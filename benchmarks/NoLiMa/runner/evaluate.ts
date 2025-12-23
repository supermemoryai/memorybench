/**
 * Evaluation module for NoLiMa benchmark
 * Calculates accuracy, base score, and effective length metrics
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { generateText } from 'ai';
import dedent from 'dedent';
import { withRetry } from '../../../core/utils/retry';
import { getModel, getProviderName } from '../../../core/utils/models';
import type { TestCase, SearchResult, EvaluationResult, NoLiMaReport, PerformanceMetrics } from '../types';

interface EvaluateOptions {
    judgeModel?: string | string[];
}

export async function evaluateNoLiMa(
    runId: string,
    answeringModel: string | string[],
    options?: EvaluateOptions
) {
    const answeringModels = Array.isArray(answeringModel) ? answeringModel : [answeringModel];
    const judgeModels = options?.judgeModel
        ? (Array.isArray(options.judgeModel) ? options.judgeModel : [options.judgeModel])
        : ['gpt-4o'];

    console.log(`[NoLiMa] Evaluating answers...`);
    console.log(`Answering Models: ${answeringModels.join(', ')}`);
    console.log(`Judge Models: ${judgeModels.join(', ')}`);
    console.log(`Run ID: ${runId}`);
    console.log('');

    // Run evaluation for each combination of answering model and judge model
    for (const answModel of answeringModels) {
        for (const judgeModel of judgeModels) {
            await evaluateWithModels(runId, answModel, judgeModel);
        }
    }
}

async function evaluateWithModels(
    runId: string,
    answeringModel: string,
    judgeModel: string
) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Evaluating with Answering: ${answeringModel} (${getProviderName(answeringModel)})`);
    console.log(`Judge: ${judgeModel} (${getProviderName(judgeModel)})`);
    console.log('='.repeat(60));

    // Load test cases and search results
    const ingestDir = join(process.cwd(), 'results', runId, 'checkpoints', 'ingest');
    const searchDir = join(process.cwd(), 'results', runId, 'checkpoints', 'search');

    const testCasesPath = join(ingestDir, `testcases-${runId}.json`);
    const searchResultsPath = join(searchDir, `search-${runId}.json`);

    if (!existsSync(testCasesPath) || !existsSync(searchResultsPath)) {
        throw new Error('Test cases or search results not found. Run ingest and search phases first.');
    }

    const testCases: TestCase[] = JSON.parse(readFileSync(testCasesPath, 'utf8'));
    const searchCheckpoint = JSON.parse(readFileSync(searchResultsPath, 'utf8'));
    const searchResults: SearchResult[] = searchCheckpoint.searchResults;

    console.log(`Evaluating ${searchResults.length} test cases...`);
    console.log('');

    const evaluations: EvaluationResult[] = [];
    const checkpointDir = join(process.cwd(), 'results', runId, 'checkpoints', 'evaluate');
    if (!existsSync(checkpointDir)) {
        mkdirSync(checkpointDir, { recursive: true });
    }

    const evaluationCheckpointPath = join(checkpointDir, `eval-${runId}.json`);

    const failedEvaluations: { testCaseId: string; error: string }[] = [];

    for (let i = 0; i < searchResults.length; i++) {
        const searchResult = searchResults[i];
        const testCase = testCases.find(tc => tc.testId === searchResult.testCaseId);

        if (!testCase) {
            console.error(`Test case not found for ${searchResult.testCaseId}`);
            continue;
        }

        if (i % 10 === 0 || i === 0) {
            console.log(`[${i + 1}/${searchResults.length}] Evaluating ${testCase.testId}...`);
        }

        try {
            // Generate answer using the answering model
            const generatedAnswer = await generateAnswer(
                testCase.question,
                searchResult.retrievedContext,
                answeringModel
            );

            // Evaluate using judge model
            const correct = await judgeAnswer(
                testCase.question,
                testCase.answer,
                generatedAnswer,
                judgeModel
            );

            evaluations.push({
                testCaseId: testCase.testId,
                needleId: testCase.needleId,
                testId: testCase.testId,
                question: testCase.question,
                contextLength: testCase.contextLength,
                expectedAnswer: testCase.answer,
                generatedAnswer,
                correct,
                retrievedNeedle: searchResult.retrievedNeedle,
                explanation: correct ? 'Correct answer' : 'Incorrect answer'
            });

            // Save checkpoint periodically
            if (i % 10 === 0 || i === searchResults.length - 1) {
                const tempReport = createReport(runId, searchCheckpoint.providerName, answeringModel, judgeModel, testCases, evaluations);
                writeFileSync(evaluationCheckpointPath, JSON.stringify(tempReport, null, 2));
            }

            // Small delay between evaluations
            await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            console.error(`  ✗ Failed (continuing): ${errorMsg.substring(0, 100)}`);
            failedEvaluations.push({ testCaseId: testCase.testId, error: errorMsg });
            // Continue to next evaluation instead of stopping
        }
    }

    // Report failed evaluations
    if (failedEvaluations.length > 0) {
        console.log('');
        console.log(`⚠ ${failedEvaluations.length} evaluations failed and were skipped:`);
        for (const failed of failedEvaluations.slice(0, 5)) {
            console.log(`  - ${failed.testCaseId}: ${failed.error.substring(0, 80)}`);
        }
        if (failedEvaluations.length > 5) {
            console.log(`  ... and ${failedEvaluations.length - 5} more`);
        }
    }

    // Generate final report
    const finalReport = createReport(runId, searchCheckpoint.providerName, answeringModel, judgeModel, testCases, evaluations);

    // Save to evaluations directory
    const evaluationsDir = join(process.cwd(), 'results', runId, 'evaluation');
    if (!existsSync(evaluationsDir)) {
        mkdirSync(evaluationsDir, { recursive: true });
    }

    const answeringSafe = answeringModel.replace(/[/:]/g, '-');
    const judgeSafe = judgeModel.replace(/[/:]/g, '-');
    const reportPath = join(evaluationsDir, `eval-answer_${answeringSafe}-judge_${judgeSafe}.json`);
    writeFileSync(reportPath, JSON.stringify(finalReport, null, 2));

    // Save cumulative summary for visualization at run root
    const summaryPath = join(process.cwd(), 'results', runId, 'evaluation-summary.json');
    const visualizationSummary = {
        benchmark: 'NoLiMa',
        metadata: {
            runId,
            provider: searchCheckpoint.providerName,
            answeringModel,
            judgeModel,
            evaluatedAt: new Date().toISOString(),
            totalTests: finalReport.summary.totalTests,
            correctAnswers: finalReport.summary.correctAnswers,
            accuracy: `${finalReport.summary.overallAccuracy.toFixed(2)}%`
        },
        metrics: {
            overallAccuracy: finalReport.summary.overallAccuracy,
            baseScore: finalReport.summary.baseScore,
            effectiveLength: finalReport.summary.effectiveLength,
            retrievalRate: evaluations.filter(e => e.retrievedNeedle).length / evaluations.length * 100
        },
        byContextLength: finalReport.byContextLength.map(m => ({
            contextLength: `${m.contextLength / 1000}K`,
            correct: m.correctAnswers,
            total: m.totalTests,
            accuracy: `${m.accuracy.toFixed(2)}%`,
            retrievalRate: `${m.retrievalRate.toFixed(2)}%`
        }))
    };
    writeFileSync(summaryPath, JSON.stringify(visualizationSummary, null, 2));

    console.log('');
    console.log('=== Evaluation Complete ===');
    console.log(`Answering Model: ${answeringModel}`);
    console.log(`Judge Model: ${judgeModel}`);
    console.log(`Overall Accuracy: ${finalReport.summary.overallAccuracy.toFixed(2)}%`);
    console.log(`Base Score (1K context): ${finalReport.summary.baseScore.toFixed(2)}%`);
    console.log(`Effective Length: ${finalReport.summary.effectiveLength ? `${finalReport.summary.effectiveLength} tokens` : 'N/A'}`);
    console.log('');
    console.log('By Context Length:');
    for (const metric of finalReport.byContextLength) {
        console.log(`  ${metric.contextLength}K: ${metric.accuracy.toFixed(2)}% (${metric.correctAnswers}/${metric.totalTests})`);
    }
    console.log('');
    console.log(`Report saved to: ${reportPath}`);
    console.log(`Visualization summary saved to: ${summaryPath}`);
}

// Rough token estimate: ~4 characters per token
const CHARS_PER_TOKEN = 4;
const MAX_CONTEXT_TOKENS = 30000; // 30k tokens - leave room for prompt + response in 128k context
const MAX_CONTEXT_CHARS = MAX_CONTEXT_TOKENS * CHARS_PER_TOKEN;

async function generateAnswer(
    question: string,
    retrievedContext: string,
    model: string
): Promise<string> {
    // Check if context is too large and needs chunking
    if (retrievedContext.length > MAX_CONTEXT_CHARS) {
        return await generateAnswerWithChunking(question, retrievedContext, model);
    }

    const prompt = dedent`
        You will answer a question based on the following context:

        ${retrievedContext}

        Question: ${question}

        Return only the final answer with no additional explanation or reasoning.
    `;

    return await withRetry(async () => {
        const result = await generateText({
            model: getModel(model),
            messages: [
                { role: 'user', content: prompt }
            ],
        });
        return result.text.trim();
    });
}

/**
 * Handle large contexts by splitting into chunks and processing sequentially
 */
async function generateAnswerWithChunking(
    question: string,
    retrievedContext: string,
    model: string
): Promise<string> {
    // Split context into 4 chunks
    const chunkSize = Math.ceil(retrievedContext.length / 4);
    const chunks: string[] = [];
    
    for (let i = 0; i < retrievedContext.length; i += chunkSize) {
        chunks.push(retrievedContext.slice(i, i + chunkSize));
    }

    console.log(`    → Context too large (${Math.round(retrievedContext.length / 1000)}k chars), splitting into ${chunks.length} chunks...`);

    const partialAnswers: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        console.log(`    → Processing chunk ${i + 1}/${chunks.length} (${Math.round(chunk.length / 1000)}k chars)...`);

        const chunkPrompt = dedent`
            You will answer a question based on the following context (Part ${i + 1} of ${chunks.length}).
            
            ${chunk}

            Question: ${question}

            If the answer is in this chunk, return ONLY the answer.
            If the answer is NOT in this chunk, respond with: "NO_ANSWER_FOUND"
        `;

        const partialAnswer = await withRetry(async () => {
            const result = await generateText({
                model: getModel(model),
                messages: [
                    { role: 'user', content: chunkPrompt }
                ],
            });
            return result.text.trim();
        });

        if (!partialAnswer.includes('NO_ANSWER_FOUND')) {
            partialAnswers.push(partialAnswer);
        }

        // Delay between chunks to avoid rate limits
        if (i < chunks.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

    // Return the first valid answer found, or indicate no answer
    if (partialAnswers.length === 0) {
        return "Unable to find the answer in the provided context.";
    }

    // If multiple answers, return the first one (NoLiMa expects a single specific answer)
    return partialAnswers[0];
}

async function judgeAnswer(
    question: string,
    expectedAnswer: string,
    generatedAnswer: string,
    judgeModel: string = 'gpt-4o'
): Promise<boolean> {
    const judgementPrompt = dedent`
        Determine if the generated answer matches the expected answer.

        Question: ${question}
        Expected Answer: ${expectedAnswer}
        Generated Answer: ${generatedAnswer}

        Does the generated answer correctly identify "${expectedAnswer}" as the answer?
        Consider variations and phrasings, but the core answer must match.

        Respond with only "yes" or "no".
    `;

    return await withRetry(async () => {
        const result = await generateText({
            model: getModel(judgeModel),
            messages: [
                { role: 'user', content: judgementPrompt }
            ],
        });
        return result.text.trim().toLowerCase().includes('yes');
    });
}

function createReport(
    runId: string,
    providerName: string,
    answeringModel: string,
    judgeModel: string,
    testCases: TestCase[],
    evaluations: EvaluationResult[]
): NoLiMaReport {
    const totalTests = evaluations.length;
    const correctAnswers = evaluations.filter(e => e.correct).length;
    const overallAccuracy = totalTests > 0 ? (correctAnswers / totalTests) * 100 : 0;

    // Group by context length
    const contextLengths = [1000, 4000, 8000, 16000, 32000];
    const byContextLength: PerformanceMetrics[] = [];

    for (const length of contextLengths) {
        const lengthEvals = evaluations.filter(e => {
            // Allow 20% tolerance for grouping
            const tc = testCases.find(tc => tc.testId === e.testCaseId);
            if (!tc) return false;
            return Math.abs(tc.contextLength - length) < length * 0.2;
        });

        if (lengthEvals.length === 0) continue;

        const correct = lengthEvals.filter(e => e.correct).length;
        const retrieved = lengthEvals.filter(e => e.retrievedNeedle).length;

        byContextLength.push({
            contextLength: length,
            totalTests: lengthEvals.length,
            correctAnswers: correct,
            accuracy: (correct / lengthEvals.length) * 100,
            retrievalRate: (retrieved / lengthEvals.length) * 100
        });
    }

    // Calculate base score (shortest context)
    const baseScore = byContextLength.length > 0 ? byContextLength[0].accuracy : 0;

    // Calculate effective length (longest context maintaining 85% of base score)
    const threshold = baseScore * 0.85;
    let effectiveLength: number | null = null;

    for (let i = byContextLength.length - 1; i >= 0; i--) {
        if (byContextLength[i].accuracy >= threshold) {
            effectiveLength = byContextLength[i].contextLength;
            break;
        }
    }

    return {
        metadata: {
            runId,
            providerName,
            answeringModel,
            judgeModel,
            needleSetType: 'standard',
            evaluatedAt: new Date().toISOString()
        },
        summary: {
            totalTests,
            correctAnswers,
            overallAccuracy,
            baseScore,
            effectiveLength
        },
        byContextLength,
        evaluations
    };
}
