/*
Evaluation script for LongMemEval results.
Uses a default model (gemini-3-pro-preview) to evaluate answer quality.
*/

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createOpenAI } from '@ai-sdk/openai';
import { config, validateConfig } from '../utils/config.ts';
import { createVertex } from '@ai-sdk/google-vertex/edge';
import { generateText } from 'ai';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

validateConfig(['googleVertexProjectId']); 

if (!process.env.OPENAI_API_KEY) {
    console.error("Error: OPENAI_API_KEY environment variable is required for the judge (GPT-4o).");
    process.exit(1);
}

// Get command line arguments
const args = process.argv.slice(2);
if (args.length < 1) {
    console.error("Usage: bun run evaluate.ts <runId> [model] [questionType] [startPosition] [endPosition]");
    console.error("Example: bun run evaluate.ts run1 gpt-4o");
    console.error("Example: bun run evaluate.ts run1 gpt-5 single-session-user");
    process.exit(1);
}

const runId = args[0];
// Default model to gpt-4o if not provided or valid
let model = args[1] || 'gpt-4o';
let questionTypeFilter = args[2]; // Optional
const startPosition = args[3] ? parseInt(args[3], 10) : undefined;
const endPosition = args[4] ? parseInt(args[4], 10) : undefined;

// Validate answering model
const validModels = ['gpt-4o', 'gpt-5', 'gemini-3-pro-preview'];
if (!validModels.includes(model)) {
    console.error(`Error: Unknown model '${model}'. Valid models: ${validModels.join(', ')}`);
    process.exit(1);
}

if (questionTypeFilter === 'all') {
    questionTypeFilter = undefined;
}

// Judging model
const JUDGE_MODEL = 'gpt-4o';

console.log(`Evaluating results for: ${runId}`);
console.log(`Answering Model: ${model}`);
console.log(`Judge Model: ${JUDGE_MODEL}`);

if (questionTypeFilter) {
    console.log(`Question type filter: ${questionTypeFilter}`);
} else {
    console.log(`Question type filter: all`);
}

if (startPosition && endPosition) {
    console.log(`Processing range: ${startPosition} to ${endPosition}`);
}

console.log(`Using ALL retrieved results from each file\n`);

// Initialize providers
const vertex = createVertex({
    project: config.googleVertexProjectId,
    location: "global",
});

const openai = createOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Helper to get the appropriate model instance
function getModelInstance(modelName: string) {
    if (modelName === 'gemini-3-pro-preview') {
        return vertex(modelName);
    } else {
        return openai(modelName);
    }
}

// Setup directories
const resultsDir = join(__dirname, '../../results');
const evalDir = join(__dirname, '../../evaluations');

if (!existsSync(evalDir)) {
    mkdirSync(evalDir, { recursive: true });
}

// Find all result files for this runId
let resultFiles = readdirSync(resultsDir)
    .filter(f => f.endsWith('.json') && f.includes(`-${runId}`))
    .sort();

// Filter by question type if specified
if (questionTypeFilter) {
    const filteredFiles: string[] = [];
    for (const filename of resultFiles) {
        const filePath = join(resultsDir, filename);
        try {
            const resultData = JSON.parse(readFileSync(filePath, 'utf8'));
            if (resultData.metadata?.questionType === questionTypeFilter) {
                filteredFiles.push(filename);
            }
        } catch (error) {
            // Skip files that can't be parsed
            console.warn(`Warning: Could not parse ${filename}, skipping...`);
        }
    }
    resultFiles = filteredFiles;
    
    if (resultFiles.length === 0) {
        console.error(`No result files found for runId: ${runId} and questionType: ${questionTypeFilter}`);
        console.error(`Looking in: ${resultsDir}`);
        process.exit(1);
    }
    
    console.log(`Found ${resultFiles.length} result files to evaluate (filtered by type: ${questionTypeFilter})\n`);
} else {
    if (resultFiles.length === 0) {
        console.error(`No result files found for runId: ${runId}`);
        console.error(`Looking in: ${resultsDir}`);
        process.exit(1);
    }
    
    console.log(`Found ${resultFiles.length} result files to evaluate\n`);
}

// Filter by position range if specified
if (startPosition !== undefined && endPosition !== undefined) {
    if (isNaN(startPosition) || isNaN(endPosition) || startPosition < 1 || endPosition < startPosition) {
        console.error(`Invalid range: ${startPosition}-${endPosition}`);
        process.exit(1);
    }
    
    // positions are 1-based
    const totalBeforeSlice = resultFiles.length;
    resultFiles = resultFiles.slice(startPosition - 1, endPosition);
    console.log(`Filtered to range ${startPosition}-${endPosition}: ${resultFiles.length} files (out of ${totalBeforeSlice})`);
}

// Output file path
const typeSuffix = questionTypeFilter ? `-${questionTypeFilter}` : '';
const rangeSuffix = (startPosition && endPosition) ? `-${startPosition}-${endPosition}` : '-all';
const outputFilename = `eval-${runId}-${model}${typeSuffix}${rangeSuffix}.json`;
const outputPath = join(evalDir, outputFilename);

interface EvaluationResult {
    questionId: string;
    questionType: string;
    question: string;
    groundTruth: string;
    hypothesis: string;
    label: number; // 1 = correct, 0 = incorrect
    explanation: string;
}

interface Chunk {
    content: string;
    position: number;
    [key: string]: any;
}

function deduplicateAndSortChunks(chunks: Chunk[]): Chunk[] {
    const uniqueChunks = chunks.filter((chunk, index, self) =>
        index === self.findIndex((c) => c.content === chunk.content)
    );
    return uniqueChunks.sort((a, b) => a.position - b.position);
}

async function generateAnswer(question: string, retrievedContext: string, questionDate?: string): Promise<string> {
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

4. **Profile Data** (if present):
   - **Static Profile**: Permanent user characteristics (name, preferences, core identity)
   - **Dynamic Profile**: Contains a subset of the recently added memories
   - Provides background about the user

5. **Version**: Shows if a memory has been updated/extended over time

**How to Answer:**
1. Start by scanning memory titles to find relevant results
2. **Read the chunks carefully** - they contain the actual details you need
3. Use temporal context to understand when things happened
4. Use profile data for background about the user
5. Synthesize information from multiple results if needed

Instructions:
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
    questionType: string // Added questionType parameter
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
            model: openai(JUDGE_MODEL),
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

async function evaluateQuestion(resultData: any): Promise<EvaluationResult> {
    const { metadata, searchResults } = resultData;
    
    const allResults = (searchResults.results || []);
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
    
    try {
        const hypothesis = await generateAnswer(metadata.question, retrievedContext, metadata.questionDate);
        const { label, explanation } = await judgeAnswer(metadata.question, metadata.groundTruthAnswer, hypothesis, metadata.questionType);
        
        return {
            questionId: metadata.questionId,
            questionType: metadata.questionType,
            question: metadata.question,
            groundTruth: metadata.groundTruthAnswer,
            hypothesis,
            label,
            explanation,
        };
    } catch (error) {
        console.error(`Error evaluating ${metadata.questionId}:`, error);
        return {
            questionId: metadata.questionId,
            questionType: metadata.questionType,
            question: metadata.question,
            groundTruth: metadata.groundTruthAnswer,
            hypothesis: '',
            label: 0,
            explanation: `Evaluation error: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}

async function evaluateAll() {
    let evaluations: EvaluationResult[] = [];
    let processedQuestionIds = new Set<string>();
    
    if (existsSync(outputPath)) {
        try {
            const existing = JSON.parse(readFileSync(outputPath, 'utf-8'));
            if (existing.evaluations && Array.isArray(existing.evaluations)) {
                evaluations = existing.evaluations;
                processedQuestionIds = new Set(evaluations.map((e: EvaluationResult) => e.questionId));
                console.log(`Resuming: Found ${evaluations.length} existing evaluations\n`);
            }
        } catch (error) {
            console.log(`Starting fresh evaluation\n`);
        }
    }
    
    for (const filename of resultFiles) {
        const filePath = join(resultsDir, filename);
        try {
            const resultData = JSON.parse(readFileSync(filePath, 'utf8'));
            const questionId = resultData.metadata.questionId;
            
            if (processedQuestionIds.has(questionId)) {
                console.log(`Skipping: ${questionId} (already evaluated)`);
                continue;
            }
            
            console.log(`Evaluating: ${questionId}`);
            const evaluation = await evaluateQuestion(resultData);
            evaluations.push(evaluation);
            
            // Calculate intermediate stats
            const total = evaluations.length;
            const correct = evaluations.filter(e => e.label === 1).length;
            const accuracy = total > 0 ? (correct / total) * 100 : 0;
            
            // Save
            const output = {
                metadata: {
                    runId,
                    model,
                    evaluatedAt: new Date().toISOString(),
                    totalQuestions: total,
                    correctAnswers: correct,
                    accuracy: accuracy.toFixed(2) + '%',
                },
                evaluations,
            };
            writeFileSync(outputPath, JSON.stringify(output, null, 2));
            
            // Log
            const status = evaluation.label === 1 ? '✓ CORRECT' : '✗ INCORRECT';
            console.log(`  ${status} - ${evaluation.explanation.substring(0, 60)}...`);
            console.log(`  Progress: ${total}/${resultFiles.length} | Accuracy: ${accuracy.toFixed(2)}%\n`);
            
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
    console.log(`Run ID:       ${runId}`);
    console.log(`Total:        ${total}`);
    console.log(`Correct:      ${correct}`);
    console.log(`Accuracy:     ${accuracy.toFixed(2)}%`);
    console.log('='.repeat(60));
}

await evaluateAll();
