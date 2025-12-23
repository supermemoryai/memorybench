/**
 * Evaluation module for LoCoMo benchmark
 * Uses LLM-as-a-judge to evaluate answer quality
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { createVertex } from '@ai-sdk/google-vertex';
import dedent from 'dedent';

interface EvaluateOptions {
    startPosition?: number;
    endPosition?: number;
    judgeModel?: string;
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
    1: 'Factual',
    2: 'Temporal',
    3: 'Reasoning'
};

export async function evaluateAllSamples(
    runId: string,
    answeringModel: string,
    options?: EvaluateOptions
) {
    console.log(`[LoCoMo] Evaluating answers...`);
    console.log(`Answering Model: ${answeringModel}`);
    console.log(`Run ID: ${runId}`);

    const judgeModel = options?.judgeModel || 'gpt-4o';
    console.log(`Judge Model: ${judgeModel}`);
    console.log('');

    // Initialize Vertex only for Gemini models
    let vertex: any = null;
    if (answeringModel.startsWith('gemini')) {
        if (!process.env.GOOGLE_VERTEX_PROJECT_ID) {
            throw new Error('GOOGLE_VERTEX_PROJECT_ID environment variable is required for Gemini models');
        }

        vertex = createVertex({
            project: process.env.GOOGLE_VERTEX_PROJECT_ID,
            location: process.env.GOOGLE_VERTEX_LOCATION || 'us-central1',
        });
    }

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
                    answeringModel,
                    vertex
                );

                // Evaluate using judge model
                const evaluation = await judgeAnswer(
                    questionData.question,
                    String(questionData.answer),
                    generatedAnswer,
                    judgeModel
                );

                evaluations.push({
                    questionId: questionData.questionId,
                    category: questionData.category,
                    question: questionData.question,
                    groundTruth: String(questionData.answer),
                    hypothesis: generatedAnswer,
                    label: evaluation.label,
                    explanation: evaluation.explanation
                });

                if (evaluation.label === 1) {
                    sampleCorrect++;
                }
                sampleTotal++;

                // Save checkpoint after each evaluation
                const tempReport = createReport(runId, answeringModel, evaluations);
                writeFileSync(evaluationCheckpointPath, JSON.stringify(tempReport, null, 2));

                // Small delay between questions
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (error) {
                console.error(`  ✗ Failed on question: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        console.log(`  Sample: ${sampleCorrect}/${sampleTotal} correct`);
    }

    // Generate final report
    const finalReport = createReport(runId, answeringModel, evaluations);

    // Save to evaluations directory in results
    const evaluationsDir = join(process.cwd(), 'results', runId, 'evaluation');
    if (!existsSync(evaluationsDir)) {
        mkdirSync(evaluationsDir, { recursive: true });
    }

    const reportPath = join(evaluationsDir, `eval-${runId}-${answeringModel.replace(/[/:]/g, '-')}.json`);
    writeFileSync(reportPath, JSON.stringify(finalReport, null, 2));

    console.log('');
    console.log('=== Evaluation Complete ===');
    console.log(`Overall Accuracy: ${finalReport.metadata.accuracy}`);
    console.log(`Total Questions: ${finalReport.metadata.totalQuestions}`);
    console.log(`Correct Answers: ${finalReport.metadata.correctAnswers}`);
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
            judgeModel,
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

async function generateAnswer(
    question: string,
    retrievedContext: string,
    model: string,
    vertex: any
): Promise<string> {
    const prompt = dedent`
        You are an AI assistant answering questions based on provided context from conversation history.

        Context from conversation history:
        ${retrievedContext}

        Question: ${question}

        Based ONLY on the context provided above, answer the question concisely and accurately.
        If the context doesn't contain enough information to answer the question, say "I don't have enough information to answer this question."
    `;

    let selectedModel: any;
    if (model.startsWith('gemini')) {
        if (!vertex) {
            throw new Error('Vertex AI not initialized for Gemini model');
        }
        selectedModel = vertex(model);
    } else {
        selectedModel = openai(model);
    }

    const result = await generateText({
        model: selectedModel,
        messages: [
            { role: 'user', content: prompt }
        ],
    });

    return result.text;
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

    const result = await generateText({
        model: openai(judgeModel),
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
}

function createReport(runId: string, model: string, evaluations: QuestionEvaluation[]): EvaluationReport {
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
            evaluatedAt: new Date().toISOString(),
            totalQuestions,
            correctAnswers,
            accuracy
        },
        byCategory,
        evaluations
    };
}
