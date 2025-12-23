/**
 * Evaluation module for LoCoMo benchmark
 * Supports both non-LLM (exact match, F1) and LLM-as-a-judge evaluation
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { generateText } from 'ai';
import dedent from 'dedent';
import { withRetry } from '../../../core/utils/retry';
import { getModel, getProviderName } from '../../../core/utils/models';
import { evaluate as metricEvaluate, type EvalMethod } from '../../../core/utils/metrics';

interface EvaluateOptions {
    startPosition?: number;
    endPosition?: number;
    judgeModel?: string;
    evalMethod?: 'exact' | 'f1' | 'llm';
    providerName?: string;
}

interface QuestionEvaluation {
    questionId: string;
    category: number;
    question: string;
    groundTruth: string;
    hypothesis: string;
    label: number;
    explanation: string;
}

interface EvaluationReport {
    metadata: {
        runId: string;
        model: string;
        evalMethod: string;
        evaluatedAt: string;
        totalQuestions: number;
        correctAnswers: number;
        accuracy: string;
    };
    byCategory: Array<{
        category: number;
        categoryName: string;
        correct: number;
        total: number;
        accuracy: string;
    }>;
    evaluations: QuestionEvaluation[];
}

const CATEGORY_NAMES: Record<number, string> = {
    1: 'Single-hop Factual',
    2: 'Temporal Reasoning',
    3: 'Multi-hop Reasoning',
    4: 'Simple Factual',
    5: 'Adversarial'
};

export async function evaluateAllSamples(
    runId: string,
    answeringModel: string,
    options?: EvaluateOptions
) {
    const evalMethod = options?.evalMethod || 'exact';
    const judgeModel = options?.judgeModel || 'gpt-4o';

    console.log(`[LoCoMo] Evaluating answers...`);
    console.log(`Answering Model: ${answeringModel} (${getProviderName(answeringModel)})`);
    console.log(`Run ID: ${runId}`);
    console.log(`Eval Method: ${evalMethod}${evalMethod === 'llm' ? ` (Judge: ${judgeModel})` : ''}`);
    console.log('');

    const dataPath = join(process.cwd(), 'benchmarks/LoCoMo/locomo10.json');
    const allSamples = JSON.parse(readFileSync(dataPath, 'utf8'));

    // Apply position filtering if provided
    let samplesToProcess = allSamples;
    if (options?.startPosition && options?.endPosition) {
        const start = options.startPosition - 1;
        const end = options.endPosition;
        samplesToProcess = allSamples.slice(start, end);
        console.log(`Processing positions ${options.startPosition}-${options.endPosition}: ${samplesToProcess.length} samples`);
    }

    console.log('');

    const evaluations: QuestionEvaluation[] = [];
    const failedEvaluations: { questionId: string; error: string }[] = [];
    const checkpointDir = join(process.cwd(), 'benchmarks/LoCoMo/checkpoints/evaluate');
    if (!existsSync(checkpointDir)) {
        mkdirSync(checkpointDir, { recursive: true });
    }

    const evaluationCheckpointPath = join(checkpointDir, `eval-${runId}.json`);

    for (let i = 0; i < samplesToProcess.length; i++) {
        const sample = samplesToProcess[i];
        const sampleId = sample.sample_id;

        console.log(`[${i + 1}/${samplesToProcess.length}] Evaluating ${sampleId} (${sample.qa.length} questions)...`);

        // Load search results
        const searchCheckpointPath = join(process.cwd(), 'results', runId, 'checkpoints', 'search', `search-${sampleId}-${runId}.json`);

        if (!existsSync(searchCheckpointPath)) {
            console.log(`  ⚠ Skipping - no search results found`);
            continue;
        }

        const searchCheckpoint = JSON.parse(readFileSync(searchCheckpointPath, 'utf8'));
        const questions = searchCheckpoint.questionsSearched;

        let sampleCorrect = 0;
        let sampleTotal = 0;

        for (const questionData of questions) {
            try {
                // Generate answer using the answering model
                const generatedAnswer = await generateAnswer(
                    questionData.question,
                    questionData.retrievedContext,
                    answeringModel
                );

                let label: number;
                let explanation: string;
                let score: number | undefined;
                let groundTruthForReport: string;

                // Category 5 is adversarial - different evaluation logic
                const isAdversarial = questionData.category === 5;
                
                if (isAdversarial) {
                    // For adversarial questions: model should NOT give the adversarial (wrong) answer
                    // AND should not just say "I don't know"
                    const adversarialAnswer = questionData.adversarial_answer || '';
                    groundTruthForReport = `[ADVERSARIAL - should NOT answer: ${adversarialAnswer}]`;
                    
                    const normalizedResponse = generatedAnswer.toLowerCase();
                    const normalizedAdversarial = adversarialAnswer.toLowerCase();
                    
                    const gaveAdversarialAnswer = normalizedAdversarial && normalizedResponse.includes(normalizedAdversarial);
                    const saidDontKnow = normalizedResponse.includes("don't know") || 
                                         normalizedResponse.includes("don't have enough information") ||
                                         normalizedResponse.includes("cannot answer") ||
                                         normalizedResponse.includes("no information");
                    
                    if (gaveAdversarialAnswer) {
                        // Model was tricked - gave the wrong answer
                        label = 0;
                        explanation = `FAILED: Model gave the adversarial (wrong) answer "${adversarialAnswer}"`;
                    } else if (saidDontKnow) {
                        // Model avoided the trap but didn't provide useful answer
                        // This is partially correct - avoided wrong answer but no good answer
                        label = 0;
                        explanation = `PARTIAL: Model avoided adversarial answer but said "I don't know" (no context retrieved?)`;
                    } else {
                        // Model avoided the trap and gave some other answer
                        label = 1;
                        explanation = `PASSED: Model avoided the adversarial answer "${adversarialAnswer}"`;
                    }
                } else {
                    // Regular questions (categories 1-4)
                    groundTruthForReport = String(questionData.answer);
                    
                    if (evalMethod === 'llm') {
                        // Use LLM-as-a-judge
                        const evaluation = await judgeAnswer(
                            questionData.question,
                            groundTruthForReport,
                            generatedAnswer,
                            judgeModel
                        );
                        label = evaluation.label;
                        explanation = evaluation.explanation;
                    } else {
                        // Use non-LLM evaluation (exact match or F1)
                        const metricMethod = evalMethod as EvalMethod;
                        const result = metricEvaluate(generatedAnswer, questionData.answer, metricMethod);
                        label = result.correct ? 1 : 0;
                        score = result.score;
                        explanation = evalMethod === 'f1' 
                            ? `F1 score: ${result.score.toFixed(3)}`
                            : `Exact match: ${result.correct ? 'yes' : 'no'}`;
                    }
                }

                evaluations.push({
                    questionId: questionData.questionId,
                    category: questionData.category,
                    question: questionData.question,
                    groundTruth: groundTruthForReport,
                    hypothesis: generatedAnswer,
                    label,
                    explanation,
                    ...(score !== undefined && { score })
                } as QuestionEvaluation);

                if (label === 1) {
                    sampleCorrect++;
                }
                sampleTotal++;

                // Save checkpoint after each evaluation
                const tempReport = createReport(runId, answeringModel, evalMethod, evaluations);
                writeFileSync(evaluationCheckpointPath, JSON.stringify(tempReport, null, 2));

                // Only delay for LLM calls (answer generation already has delay in retry)
                if (evalMethod === 'llm') {
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                console.error(`  ✗ Failed (continuing): ${errorMsg.substring(0, 100)}`);
                failedEvaluations.push({ questionId: questionData.questionId, error: errorMsg });
                sampleTotal++;
                // Continue to next question
            }
        }

        console.log(`  Sample: ${sampleCorrect}/${sampleTotal} correct`);
    }

    // Report failed evaluations
    if (failedEvaluations.length > 0) {
        console.log('');
        console.log(`⚠ ${failedEvaluations.length} evaluations failed and were skipped:`);
        for (const failed of failedEvaluations.slice(0, 5)) {
            console.log(`  - ${failed.questionId}: ${failed.error.substring(0, 80)}`);
        }
        if (failedEvaluations.length > 5) {
            console.log(`  ... and ${failedEvaluations.length - 5} more`);
        }
    }

    // Generate final report
    const finalReport = createReport(runId, answeringModel, evalMethod, evaluations);

    // Save to evaluations directory in results
    const evaluationsDir = join(process.cwd(), 'results', runId, 'evaluation');
    if (!existsSync(evaluationsDir)) {
        mkdirSync(evaluationsDir, { recursive: true });
    }

    const reportPath = join(evaluationsDir, `eval-${runId}-${answeringModel.replace(/[/:]/g, '-')}-${evalMethod}.json`);
    writeFileSync(reportPath, JSON.stringify(finalReport, null, 2));

    console.log('');
    console.log('=== Evaluation Complete ===');
    console.log(`Eval Method: ${evalMethod}`);
    console.log(`Overall Accuracy: ${finalReport.metadata.accuracy}`);
    console.log(`Total Questions: ${finalReport.metadata.totalQuestions}`);
    console.log(`Correct Answers: ${finalReport.metadata.correctAnswers}`);
    if (evalMethod === 'f1') {
        const avgF1 = evaluations.reduce((sum, e) => sum + ((e as any).score || 0), 0) / evaluations.length;
        console.log(`Average F1 Score: ${avgF1.toFixed(3)}`);
    }
    console.log('');
    console.log('By Category:');
    for (const cat of finalReport.byCategory) {
        console.log(`  ${cat.categoryName}: ${cat.accuracy} (${cat.correct}/${cat.total})`);
    }
    console.log('');
    console.log(`Report saved to: ${reportPath}`);

    // Save cumulative summary for visualization at run root
    const summaryPath = join(process.cwd(), 'results', runId, 'evaluation-summary.json');
    const summaryDir = join(process.cwd(), 'results', runId);
    if (!existsSync(summaryDir)) {
        mkdirSync(summaryDir, { recursive: true });
    }

    const visualizationSummary = {
        benchmark: 'LoCoMo',
        metadata: {
            runId,
            provider: options?.providerName || 'unknown',
            answeringModel,
            evalMethod,
            judgeModel: evalMethod === 'llm' ? judgeModel : null,
            evaluatedAt: finalReport.metadata.evaluatedAt,
            totalQuestions: finalReport.metadata.totalQuestions,
            correctAnswers: finalReport.metadata.correctAnswers,
            accuracy: finalReport.metadata.accuracy
        },
        byCategory: finalReport.byCategory,
        evaluations: finalReport.evaluations
    };
    writeFileSync(summaryPath, JSON.stringify(visualizationSummary, null, 2));
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
        You are an AI assistant answering questions based on provided context from conversation history.

        Context from conversation history:
        ${retrievedContext}

        Question: ${question}

        Based ONLY on the context provided above, answer the question concisely and accurately.
        If the context doesn't contain enough information to answer the question, say "I don't have enough information to answer this question."
    `;

    return await withRetry(async () => {
        const result = await generateText({
            model: getModel(model),
            messages: [
                { role: 'user', content: prompt }
            ],
        });
        return result.text;
    });
}

/**
 * Handle large contexts by splitting into chunks and processing sequentially
 * Each chunk is processed with a delay to avoid rate limits
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

    // Process each chunk sequentially
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        console.log(`    → Processing chunk ${i + 1}/${chunks.length} (${Math.round(chunk.length / 1000)}k chars)...`);

        const chunkPrompt = dedent`
            You are an AI assistant answering questions based on provided context from conversation history.
            
            This is PART ${i + 1} of ${chunks.length} of the full context. Extract any information relevant to the question.

            Context (Part ${i + 1}/${chunks.length}):
            ${chunk}

            Question: ${question}

            If this chunk contains information relevant to answering the question, provide that information.
            If this chunk does NOT contain relevant information, respond with: "NO_RELEVANT_INFO"
        `;

        const partialAnswer = await withRetry(async () => {
            const result = await generateText({
                model: getModel(model),
                messages: [
                    { role: 'user', content: chunkPrompt }
                ],
            });
            return result.text;
        });

        if (!partialAnswer.includes('NO_RELEVANT_INFO')) {
            partialAnswers.push(partialAnswer);
        }

        // Delay between chunks to avoid rate limits
        if (i < chunks.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

    // If no relevant info found in any chunk
    if (partialAnswers.length === 0) {
        return "I don't have enough information to answer this question.";
    }

    // If only one chunk had relevant info, return it directly
    if (partialAnswers.length === 1) {
        return partialAnswers[0];
    }

    // Synthesize final answer from partial answers
    console.log(`    → Synthesizing final answer from ${partialAnswers.length} partial responses...`);
    
    const synthesisPrompt = dedent`
        You are an AI assistant. Based on the following partial answers extracted from different parts of a conversation history, 
        provide a final, concise answer to the question.

        Question: ${question}

        Partial answers from different context chunks:
        ${partialAnswers.map((a, i) => `[Part ${i + 1}]: ${a}`).join('\n\n')}

        Synthesize these into a single, accurate, and concise answer.
    `;

    return await withRetry(async () => {
        const result = await generateText({
            model: getModel(model),
            messages: [
                { role: 'user', content: synthesisPrompt }
            ],
        });
        return result.text;
    });
}

async function judgeAnswer(
    question: string,
    groundTruth: string,
    hypothesis: string,
    judgeModel: string = 'gpt-4o'
): Promise<{ label: number; explanation: string }> {
    const judgementPrompt = dedent`
        You are an expert evaluator comparing AI-generated answers to ground truth answers.

        Question: ${question}

        Ground Truth Answer: ${groundTruth}

        AI Generated Answer: ${hypothesis}

        Task: Determine if the AI's answer is correct compared to the ground truth.

        Guidelines:
        - Label as 1 (CORRECT) if the AI's answer matches the ground truth in meaning, even if worded differently
        - Label as 1 (CORRECT) if the AI's answer contains the correct information from the ground truth
        - Label as 0 (INCORRECT) if the AI's answer contradicts the ground truth
        - Label as 0 (INCORRECT) if the AI's answer is missing key information
        - Label as 0 (INCORRECT) if the AI says it doesn't have enough information

        Respond in JSON format:
        {
            "label": 0 or 1,
            "explanation": "Brief explanation of your decision"
        }
    `;

    return await withRetry(async () => {
        const result = await generateText({
            model: getModel(judgeModel),
            messages: [
                { role: 'user', content: judgementPrompt }
            ],
        });

        try {
            const parsed = JSON.parse(result.text);
            return {
                label: parsed.label,
                explanation: parsed.explanation
            };
        } catch (error) {
            // Fallback parsing
            const labelMatch = result.text.match(/"label"\s*:\s*([01])/);
            const explanationMatch = result.text.match(/"explanation"\s*:\s*"([^"]*)"/);

            return {
                label: labelMatch ? parseInt(labelMatch[1]) : 0,
                explanation: explanationMatch ? explanationMatch[1] : 'Failed to parse judge response'
            };
        }
    });
}

function createReport(runId: string, model: string, evalMethod: string, evaluations: QuestionEvaluation[]): EvaluationReport {
    const totalQuestions = evaluations.length;
    const correctAnswers = evaluations.filter(e => e.label === 1).length;
    const accuracy = totalQuestions > 0 ? ((correctAnswers / totalQuestions) * 100).toFixed(2) + '%' : '0.00%';

    // Group by category
    const categoryStats: Record<number, { correct: number; total: number }> = {};

    for (const evaluation of evaluations) {
        const cat = evaluation.category;
        if (!categoryStats[cat]) {
            categoryStats[cat] = { correct: 0, total: 0 };
        }
        categoryStats[cat].total++;
        if (evaluation.label === 1) {
            categoryStats[cat].correct++;
        }
    }

    const byCategory = Object.entries(categoryStats).map(([category, stats]) => ({
        category: parseInt(category),
        categoryName: CATEGORY_NAMES[parseInt(category)] || `Category ${category}`,
        correct: stats.correct,
        total: stats.total,
        accuracy: ((stats.correct / stats.total) * 100).toFixed(2) + '%'
    }));

    return {
        metadata: {
            runId,
            model,
            evalMethod,
            evaluatedAt: new Date().toISOString(),
            totalQuestions,
            correctAnswers,
            accuracy
        },
        byCategory,
        evaluations
    };
}
