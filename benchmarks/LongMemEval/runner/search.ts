/**
 * Search module for LongMemEval
 * Handles searching all questions of a specific type
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getProviderRegistry } from '../../../core/providers/ProviderRegistry';
import type { BaseProvider } from '../../../core/providers/BaseProvider';

interface SearchOptions {
    startPosition?: number;
    endPosition?: number;
}

export async function searchAllQuestions(
    providerName: string,
    runId: string,
    questionType: string,
    options?: SearchOptions
) {
    console.log(`Searching ${questionType} questions...`);
    console.log(`Provider: ${providerName}`);
    console.log(`Run ID: ${runId}`);
    console.log('');

    // Get all question files of this type
    const questionsDir = join(process.cwd(), 'benchmarks/LongMemEval/datasets/questions');
    const allFiles = readdirSync(questionsDir).filter(f => f.endsWith('.json'));

    const questionFiles = allFiles.filter(filename => {
        const filePath = join(questionsDir, filename);
        const data = JSON.parse(readFileSync(filePath, 'utf8'));
        return data.question_type === questionType;
    });

    if (questionFiles.length === 0) {
        console.log(`No questions found for type: ${questionType}`);
        return;
    }

    console.log(`Found ${questionFiles.length} questions of type ${questionType}`);

    // Apply position filtering if provided
    let filesToProcess = questionFiles;
    if (options?.startPosition && options?.endPosition) {
        const start = options.startPosition - 1; // Convert to 0-indexed
        const end = options.endPosition;
        filesToProcess = questionFiles.slice(start, end);
        console.log(`Processing positions ${options.startPosition}-${options.endPosition}: ${filesToProcess.length} questions`);
    }

    console.log('');

    // Setup results directory - centralized in results/{runId}/
    const resultsDir = join(process.cwd(), 'results', runId, 'search');
    if (!existsSync(resultsDir)) {
        mkdirSync(resultsDir, { recursive: true });
    }

    // Get provider from registry
    const registry = getProviderRegistry();
    const provider = await registry.getProvider(providerName);
    await provider.initialize();

    let successCount = 0;
    let failedCount = 0;

    for (let i = 0; i < filesToProcess.length; i++) {
        const filename = filesToProcess[i];
        const questionId = filename.replace('.json', '');
        const containerTag = `${questionId}-${runId}`;

        console.log(`[${i + 1}/${filesToProcess.length}] Searching ${questionId}...`);

        try {
            const questionFilePath = join(questionsDir, filename);
            const data = JSON.parse(readFileSync(questionFilePath, 'utf8'));

            const question = data.question;
            const questionDate = data.question_date;
            const answer = data.answer;

            // Perform search using unified provider interface with timing
            const searchStart = performance.now();
            const searchResults = await provider.search(question, containerTag, {
                limit: 10,
                threshold: 0.3,
            });
            const searchDurationMs = Math.round(performance.now() - searchStart);

            // Transform results to match expected format
            const transformedResults = {
                results: searchResults.map(result => ({
                    id: result.id,
                    memory: result.content,
                    similarity: result.similarity || result.score || 0,
                    chunks: result.chunks || [],
                    metadata: result.metadata || {},
                }))
            };

            // Save results
            const resultFilePath = join(resultsDir, `${questionId}-${runId}.json`);
            const resultData = {
                metadata: {
                    questionId,
                    runId,
                    containerTag,
                    question,
                    questionDate,
                    questionType,
                    groundTruthAnswer: answer,
                    searchParams: {
                        limit: 10,
                        threshold: 0.3,
                        includeChunks: true,
                        rerank: false,
                        rewrite: false,
                    },
                    timestamp: new Date().toISOString(),
                    searchDurationMs,
                },
                searchResults: transformedResults,
            };

            writeFileSync(resultFilePath, JSON.stringify(resultData, null, 2));

            successCount++;
            console.log(`  ✓ Success - ${transformedResults.results.length} results`);

            // Small delay between searches
            await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
            failedCount++;
            console.error(`  ✗ Failed: ${error instanceof Error ? error.message : String(error)}`);
        }

        console.log('');
    }

    console.log('Search Summary:');
    console.log(`  Success: ${successCount}`);
    console.log(`  Failed: ${failedCount}`);
    console.log(`  Total: ${filesToProcess.length}`);
    console.log('');
}
