/**
 * Evaluation module for LongMemEval
 * Uses the existing evaluation script but provides a programmatic interface
 */

import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createOpenAI } from '@ai-sdk/openai';
import { createVertex } from '@ai-sdk/google-vertex/edge';
import { generateText } from 'ai';

interface EvaluateOptions {
    startPosition?: number;
    endPosition?: number;
    judgeModel?: string;
}

interface EvaluationResult {
    questionId: string;
    questionType: string;
    question: string;
    groundTruth: string;
    hypothesis: string;
    label: number;
    explanation: string;
}

interface Chunk {
    content: string;
    position: number;
    [key: string]: any;
}

export async function evaluateAllQuestions(
    runId: string,
    answeringModel: string,
    questionTypes: string[],
    options?: EvaluateOptions & { providerName?: string }
) {
    const judgeModel = options?.judgeModel || 'gpt-4o';

    console.log(`Evaluating results for run: ${runId}`);
    console.log(`Answering Model: ${answeringModel}`);
    console.log(`Judge Model: ${judgeModel}`);
    console.log('');

    // Validate environment variables
    if (!process.env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY environment variable is required for evaluation');
    }

    // Initialize OpenAI provider (required for judge)
    const openai = createOpenAI({
        apiKey: process.env.OPENAI_API_KEY,
    });

    // Initialize Vertex provider (optional, only for Gemini models)
    let vertex: any = null;
    if (answeringModel.startsWith('gemini')) {
        if (!process.env.GOOGLE_VERTEX_PROJECT_ID) {
            throw new Error('GOOGLE_VERTEX_PROJECT_ID environment variable is required for Gemini models');
        }
        vertex = createVertex({
            project: process.env.GOOGLE_VERTEX_PROJECT_ID,
            location: "global",
        });
    }

    function getModelInstance(modelName: string) {
        if (modelName === 'gemini-3-pro-preview') {
            return vertex(modelName);
        } else {
            return openai(modelName);
        }
    }

    // Get all result files for this runId from centralized results directory
    const resultsDir = join(process.cwd(), 'results', runId, 'search');
    if (!existsSync(resultsDir)) {
        throw new Error(`Results directory not found: ${resultsDir}. Run search phase first.`);
    }

    let resultFiles = readdirSync(resultsDir)
        .filter(f => f.endsWith('.json'))
        .sort();

    // Filter by question types
    if (questionTypes.length > 0) {
        const filteredFiles: string[] = [];
        for (const filename of resultFiles) {
            const filePath = join(resultsDir, filename);
            try {
                const resultData = JSON.parse(readFileSync(filePath, 'utf8'));
                if (questionTypes.includes(resultData.metadata?.questionType)) {
                    filteredFiles.push(filename);
                }
            } catch (error) {
                console.warn(`Warning: Could not parse ${filename}, skipping...`);
            }
        }
        resultFiles = filteredFiles;
    }

    if (resultFiles.length === 0) {
        throw new Error(`No result files found for runId: ${runId}`);
    }

    console.log(`Found ${resultFiles.length} result files to evaluate`);

    // Apply position filtering
    if (options?.startPosition && options?.endPosition) {
        const start = options.startPosition - 1;
        const end = options.endPosition;
        resultFiles = resultFiles.slice(start, end);
        console.log(`Evaluating positions ${options.startPosition}-${options.endPosition}: ${resultFiles.length} files`);
    }

    console.log('');

    // Setup evaluation directory in centralized results
    const evalDir = join(process.cwd(), 'results', runId, 'evaluation');
    if (!existsSync(evalDir)) {
        mkdirSync(evalDir, { recursive: true });
    }

    const typeSuffix = questionTypes.length === 1 ? `-${questionTypes[0]}` : '';
    const rangeSuffix = (options?.startPosition && options?.endPosition)
        ? `-${options.startPosition}-${options.endPosition}`
        : '';
    const outputFilename = `eval-${answeringModel}${typeSuffix}${rangeSuffix}.json`;
    const outputPath = join(evalDir, outputFilename);

    let evaluations: EvaluationResult[] = [];
    let processedQuestionIds = new Set<string>();

    // Resume from existing evaluations if present
    if (existsSync(outputPath)) {
        try {
            const existing = JSON.parse(readFileSync(outputPath, 'utf-8'));
            if (existing.evaluations && Array.isArray(existing.evaluations)) {
                evaluations = existing.evaluations;
                processedQuestionIds = new Set(evaluations.map((e: EvaluationResult) => e.questionId));
                console.log(`Resuming: Found ${evaluations.length} existing evaluations`);
                console.log('');
            }
        } catch (error) {
            console.log(`Starting fresh evaluation`);
            console.log('');
        }
    }

    // Process each result file
    for (let i = 0; i < resultFiles.length; i++) {
        const filename = resultFiles[i];
        const filePath = join(resultsDir, filename);

        try {
            const resultData = JSON.parse(readFileSync(filePath, 'utf8'));
            const questionId = resultData.metadata.questionId;

            if (processedQuestionIds.has(questionId)) {
                console.log(`[${i + 1}/${resultFiles.length}] Skipping ${questionId} (already evaluated)`);
                continue;
            }

            console.log(`[${i + 1}/${resultFiles.length}] Evaluating ${questionId}...`);

            const evaluation = await evaluateQuestion(
                resultData,
                answeringModel,
                getModelInstance,
                openai,
                judgeModel
            );

            evaluations.push(evaluation);

            // Calculate stats
            const total = evaluations.length;
            const correct = evaluations.filter(e => e.label === 1).length;
            const accuracy = total > 0 ? (correct / total) * 100 : 0;

            // Save progress
            saveEvaluationResults(
                outputPath,
                runId,
                answeringModel,
                questionTypes,
                evaluations
            );

            const status = evaluation.label === 1 ? '✓ CORRECT' : '✗ INCORRECT';
            console.log(`  ${status} - Accuracy: ${accuracy.toFixed(2)}%`);
            console.log('');

            // Rate limiting
            await new Promise(resolve => setTimeout(resolve, 1000));

        } catch (error) {
            console.error(`  Error processing ${filename}:`, error);
        }
    }

    // Final summary
    const total = evaluations.length;
    const correct = evaluations.filter(e => e.label === 1).length;
    const accuracy = total > 0 ? (correct / total) * 100 : 0;

    console.log('='.repeat(60));
    console.log('EVALUATION SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total:        ${total}`);
    console.log(`Correct:      ${correct}`);
    console.log(`Accuracy:     ${accuracy.toFixed(2)}%`);
    console.log('');

    // Breakdown by question type
    const byQuestionType: Record<string, { correct: number; total: number }> = {};
    for (const ev of evaluations) {
        if (!byQuestionType[ev.questionType]) {
            byQuestionType[ev.questionType] = { correct: 0, total: 0 };
        }
        byQuestionType[ev.questionType].total++;
        if (ev.label === 1) {
            byQuestionType[ev.questionType].correct++;
        }
    }

    console.log('Breakdown by Question Type:');
    console.log('-'.repeat(60));
    const sortedTypes = Object.entries(byQuestionType).sort((a, b) => b[1].total - a[1].total);
    for (const [type, stats] of sortedTypes) {
        const typeAccuracy = stats.total > 0 ? (stats.correct / stats.total) * 100 : 0;
        console.log(`  ${type.padEnd(30)} ${stats.correct}/${stats.total} (${typeAccuracy.toFixed(2)}%)`);
    }
    console.log('='.repeat(60));
    console.log('');
    console.log(`Results saved to: ${outputPath}`);

    // Save cumulative summary for visualization at run root
    const summaryPath = join(process.cwd(), 'results', runId, 'evaluation-summary.json');
    const visualizationSummary = {
        benchmark: 'LongMemEval',
        metadata: {
            runId,
            provider: options?.providerName || 'unknown',
            answeringModel,
            judgeModel,
            questionTypes: questionTypes.length > 0 ? questionTypes : ['all'],
            evaluatedAt: new Date().toISOString(),
            totalQuestions: total,
            correctAnswers: correct,
            accuracy: `${accuracy.toFixed(2)}%`
        },
        byQuestionType: Object.entries(byQuestionType).map(([type, stats]) => ({
            questionType: type,
            correct: stats.correct,
            total: stats.total,
            accuracy: `${((stats.correct / stats.total) * 100).toFixed(2)}%`
        })),
        evaluations: evaluations
    };
    writeFileSync(summaryPath, JSON.stringify(visualizationSummary, null, 2));
    console.log(`Visualization summary saved to: ${summaryPath}`);
}

function deduplicateAndSortChunks(chunks: Chunk[]): Chunk[] {
    const uniqueChunks = chunks.filter((chunk, index, self) =>
        index === self.findIndex((c) => c.content === chunk.content)
    );
    return uniqueChunks.sort((a, b) => a.position - b.position);
}

async function evaluateQuestion(
    resultData: any,
    answeringModel: string,
    getModelInstance: (model: string) => any,
    openai: any,
    judgeModel: string
): Promise<EvaluationResult> {
    const { metadata, searchResults } = resultData;

    // Extract and deduplicate chunks
    const allResults = (searchResults.results || []).slice(0, 10);
    const allChunks: Chunk[] = [];
    for (const result of allResults) {
        const chunks = result.chunks || [];
        for (const chunk of chunks) {
            allChunks.push({
                content: chunk.content,
                position: chunk.position ?? 0,
                ...chunk
            });
        }
    }

    const deduplicatedChunks = deduplicateAndSortChunks(allChunks);

    // Format context
    const memoriesSection = allResults
        .map((result: any, i: number) => {
            const memory = result.memory || '';
            const temporalContext = result.metadata?.temporalContext;
            const documentDate = temporalContext?.documentDate;
            const eventDate = temporalContext?.eventDate;

            let memoryParts = [`Result ${i + 1}:`, memory];

            if (documentDate || eventDate) {
                const temporalInfo: string[] = [];
                if (documentDate) temporalInfo.push(`documentDate: ${documentDate}`);
                if (eventDate) {
                    const eventDates = Array.isArray(eventDate) ? eventDate : [eventDate];
                    temporalInfo.push(`eventDate: ${eventDates.join(', ')}`);
                }
                memoryParts.push(`Temporal Context: ${temporalInfo.join(' | ')}`);
            }

            return memoryParts.join('\n');
        })
        .join('\n\n---\n\n');

    const chunksSection = deduplicatedChunks.length > 0
        ? `\n\n=== DEDUPLICATED CHUNKS ===\n${deduplicatedChunks.map(chunk => chunk.content).join('\n\n---\n\n')}`
        : '';

    const retrievedContext = memoriesSection + chunksSection;

    // Generate answer
    const hypothesis = await generateAnswer(
        metadata.question,
        retrievedContext,
        metadata.questionDate,
        answeringModel,
        getModelInstance
    );

    // Judge answer
    const { label, explanation } = await judgeAnswer(
        metadata.question,
        metadata.groundTruthAnswer,
        hypothesis,
        metadata.questionType,
        openai,
        judgeModel
    );

    return {
        questionId: metadata.questionId,
        questionType: metadata.questionType,
        question: metadata.question,
        groundTruth: metadata.groundTruthAnswer,
        hypothesis,
        label,
        explanation,
    };
}

async function generateAnswer(
    question: string,
    retrievedContext: string,
    questionDate: string,
    model: string,
    getModelInstance: (model: string) => any
): Promise<string> {
    const answerPrompt = `You are a question-answering system. Based on the retrieved context below, answer the question.

Question: ${question}
Question Date: ${questionDate}

Retrieved Context:
${retrievedContext}

**Understanding the Context:**
The context contains search results from a memory system. Each result has multiple components you can use:

1. **Memory**: A high-level summary/atomic fact (e.g., "Alex loves hiking in mountains", "John reports to Maria")
   - This is the searchable title/summary of what was stored

2. **Chunks**: The actual detailed raw content where the memory was extracted from
   - Contains conversations, documents, messages, or text excerpts
   - **This is your primary source for detailed information and facts**
   - Look here for specifics, context, quotes, and evidence

3. **Temporal Context** (if present):
   - **Question Date**: The date when the question was asked (provided above). Use this to understand the temporal perspective of the question.
   - **documentDate**: ISO date string for when the content was originally authored/written/said by the user (NOT the system createdAt timestamp). This is the reference point for calculating relative dates. Extract from document metadata, timestamps, or context.
   - **eventDate**: Array of ISO date strings for when the event/fact being referenced actually occurred or will occur. Always provided as an array, even for single dates. For past events use past dates, for future events use future dates. Calculate relative dates (today, yesterday, last week) based on documentDate, NOT the current date.
   - Useful for time-based questions (what happened when, recent vs old info)
   - **Important**: When you see relative terms like "today", "yesterday", calculate them relative to the documentDate, NOT the current date. The question date helps you understand the temporal context of what the user is asking about.

4. **Version**: Shows if a memory has been updated/extended over time

**How to Answer:**
1. Start by scanning memory titles to find relevant results
2. **Read the chunks carefully** - they contain the actual details you need
3. Use temporal context to understand when things happened
4. Synthesize information from multiple results if needed

Instructions:
- Identify which parts of the context are relevant to answering the question
- Consider temporal relationships, sequences of events, and any updates to information over time
- If the context contains enough information to answer the question, provide a clear, concise answer
- If the context does not contain enough information, respond with "I don't know" or explain what information is missing
- Base your answer ONLY on the provided context
- **Prioritize information from chunks** - they're the raw source material

Answer:`;

    try {
        const generateOptions: any = {
            model: getModelInstance(model),
            messages: [{ role: 'user', content: answerPrompt }],
        };

        if (model === 'gpt-5') {
            generateOptions.reasoning_effort = "medium";
        }

        const result = await generateText(generateOptions);
        return result.text.trim();
    } catch (error) {
        return `Error generating answer: ${error instanceof Error ? error.message : String(error)}`;
    }
}

async function judgeAnswer(
    question: string,
    groundTruth: string,
    hypothesis: string,
    questionType: string,
    openai: any,
    judgeModel: string = 'gpt-4o'
): Promise<{ label: number; explanation: string }> {
    let promptInstruction = '';
    let groundTruthSection = '';

    // Select prompt based on question type
    if (questionType === 'temporal-reasoning') {
        promptInstruction = `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct.`;

        groundTruthSection = `<CORRECT ANSWER>
${groundTruth}
</CORRECT ANSWER>`;

    } else if (questionType === 'knowledge-update') {
        promptInstruction = `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.`;

        groundTruthSection = `<CORRECT ANSWER>
${groundTruth}
</CORRECT ANSWER>`;

    } else if (questionType === 'single-session-preference') {
        promptInstruction = `I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.`;

        groundTruthSection = `<RUBRIC>
${groundTruth}
</RUBRIC>`;

    } else {
        // Default for other types
        promptInstruction = `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no.`;

        groundTruthSection = `<CORRECT ANSWER>
${groundTruth}
</CORRECT ANSWER>`;
    }

    const judgementPrompt = `${promptInstruction}

<QUESTION>
B: ${question}
</QUESTION>

${groundTruthSection}

<RESPONSE>
A: ${hypothesis}
</RESPONSE>

Respond in the following JSON format:
{
  "label": 0 or 1,
  "explanation": "Brief explanation of your decision"
}`;

    try {
        const result = await generateText({
            model: openai(judgeModel),
            messages: [{ role: 'user', content: judgementPrompt }],
        });

        const jsonMatch = result.text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('Failed to parse JSON from model response');

        const parsed = JSON.parse(jsonMatch[0]);
        return {
            label: parsed.label,
            explanation: parsed.explanation,
        };
    } catch (error) {
        return {
            label: 0,
            explanation: `Evaluation error: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}

function saveEvaluationResults(
    outputPath: string,
    runId: string,
    model: string,
    questionTypes: string[],
    evaluations: EvaluationResult[]
) {
    const total = evaluations.length;
    const correct = evaluations.filter(e => e.label === 1).length;
    const accuracy = total > 0 ? (correct / total) * 100 : 0;

    // Calculate stats by question type
    const byQuestionType: Record<string, { correct: number; total: number }> = {};
    for (const ev of evaluations) {
        if (!byQuestionType[ev.questionType]) {
            byQuestionType[ev.questionType] = { correct: 0, total: 0 };
        }
        byQuestionType[ev.questionType].total++;
        if (ev.label === 1) {
            byQuestionType[ev.questionType].correct++;
        }
    }

    const output: any = {
        metadata: {
            runId,
            model,
            questionTypes: questionTypes.length > 0 ? questionTypes : ['all'],
            evaluatedAt: new Date().toISOString(),
            totalQuestions: total,
            correctAnswers: correct,
            accuracy: accuracy.toFixed(2) + '%',
        },
        byQuestionType: Object.entries(byQuestionType).map(([type, stats]) => ({
            questionType: type,
            correct: stats.correct,
            total: stats.total,
            accuracy: ((stats.correct / stats.total) * 100).toFixed(2) + '%',
        })),
        evaluations,
    };

    writeFileSync(outputPath, JSON.stringify(output, null, 2));
}
