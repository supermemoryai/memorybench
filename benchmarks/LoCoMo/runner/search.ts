/**
 * Search module for LoCoMo benchmark
 * Retrieves relevant conversation context for questions
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { LoCoMoBenchmarkItem, qaItem } from '../types';
import { getProviderRegistry } from '../../../core/providers/ProviderRegistry';
import type { BaseProvider } from '../../../core/providers/BaseProvider';

interface SearchOptions {
    startPosition?: number;
    endPosition?: number;
    topK?: number;
}

interface QuestionSearchResult {
    questionId: string;
    question: string;
    answer?: string | number;           // Regular answer (categories 1-4)
    adversarial_answer?: string;        // Wrong answer to avoid (category 5)
    category: number;
    retrievedContext: string;
    timestamp: string;
    searchDurationMs?: number;          // API call duration in milliseconds
}

interface SampleSearchCheckpoint {
    sampleId: string;
    runId: string;
    containerTag: string;
    questionsSearched: QuestionSearchResult[];
    lastProcessedIndex: number;
}

export async function searchAllSamples(
    providerName: string,
    runId: string,
    options?: SearchOptions
) {
    console.log(`[LoCoMo] Searching for question answers...`);
    console.log(`Provider: ${providerName}`);
    console.log(`Run ID: ${runId}`);
    console.log('');

    const dataPath = join(process.cwd(), 'benchmarks/LoCoMo/locomo10.json');
    const allSamples: LoCoMoBenchmarkItem[] = JSON.parse(readFileSync(dataPath, 'utf8'));

    console.log(`Found ${allSamples.length} samples in dataset`);

    // Apply position filtering if provided
    let samplesToProcess = allSamples;
    if (options?.startPosition && options?.endPosition) {
        const start = options.startPosition - 1;
        const end = options.endPosition;
        samplesToProcess = allSamples.slice(start, end);
        console.log(`Processing positions ${options.startPosition}-${options.endPosition}: ${samplesToProcess.length} samples`);
    }

    console.log('');

    // Get provider from registry
    const registry = getProviderRegistry();
    const provider = await registry.getProvider(providerName);
    await provider.initialize();

    let successCount = 0;
    let failedCount = 0;

    for (let i = 0; i < samplesToProcess.length; i++) {
        const sample = samplesToProcess[i];
        const sampleId = sample.sample_id;

        console.log(`[${i + 1}/${samplesToProcess.length}] Searching ${sampleId} (${sample.qa.length} questions)...`);

        try {
            await searchSingleSample(sample, runId, provider, options);
            successCount++;
            console.log(`  ✓ Success`);
        } catch (error) {
            failedCount++;
            console.error(`  ✗ Failed: ${error instanceof Error ? error.message : String(error)}`);
        }

        console.log('');
    }

    console.log('Search Summary:');
    console.log(`  Success: ${successCount}`);
    console.log(`  Failed: ${failedCount}`);
    console.log(`  Total: ${samplesToProcess.length}`);
    console.log('');
}

async function searchSingleSample(
    sample: LoCoMoBenchmarkItem,
    runId: string,
    provider: BaseProvider,
    options?: SearchOptions
) {
    const sampleId = sample.sample_id;
    const containerTag = `${sampleId}-${runId}`;
    const questions = sample.qa;

    // Setup checkpoint
    const checkpointDir = join(process.cwd(), 'results', runId, 'checkpoints', 'search');
    if (!existsSync(checkpointDir)) {
        mkdirSync(checkpointDir, { recursive: true });
    }

    const checkpointPath = join(checkpointDir, `search-${sampleId}-${runId}.json`);
    let checkpoint: SampleSearchCheckpoint;

    if (existsSync(checkpointPath)) {
        checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8'));
    } else {
        checkpoint = {
            sampleId,
            runId,
            containerTag,
            questionsSearched: [],
            lastProcessedIndex: -1
        };
    }

    const topK = options?.topK || 5;

    for (let i = checkpoint.lastProcessedIndex + 1; i < questions.length; i++) {
        const qa = questions[i];
        const questionId = `${sampleId}-q${i + 1}`;

        try {
            // Search for relevant context using unified interface with timing
            const searchStart = performance.now();
            const results = await provider.search(qa.question, containerTag, { limit: topK });
            const searchDurationMs = Math.round(performance.now() - searchStart);
            
            const retrievedContext = results.map((r: any) => r.content || '').filter(c => c).join('\n\n---\n\n');
            
            // Warn if no context was retrieved
            if (!retrievedContext && results.length > 0) {
                console.warn(`  ⚠ Warning: ${results.length} results returned but no content extracted. Check provider response format.`);
            }

            const searchResult: QuestionSearchResult = {
                questionId,
                question: qa.question,
                // Category 5 has adversarial_answer (wrong answer to avoid), others have answer
                ...(qa.category === 5 
                    ? { adversarial_answer: qa.adversarial_answer }
                    : { answer: qa.answer }),
                category: qa.category,
                retrievedContext,
                timestamp: new Date().toISOString(),
                searchDurationMs,
            };

            checkpoint.questionsSearched.push(searchResult);
            checkpoint.lastProcessedIndex = i;

            // Save checkpoint after each question
            writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));

            // Small delay between questions
            if (i < questions.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        } catch (error) {
            throw new Error(`Failed at question ${i + 1}/${questions.length}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    if (checkpoint.questionsSearched.length !== questions.length) {
        throw new Error(`Only ${checkpoint.questionsSearched.length}/${questions.length} questions searched`);
    }
}
