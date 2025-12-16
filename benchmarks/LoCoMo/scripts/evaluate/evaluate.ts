/*
LoCoMo Evaluation Script
Evaluates a single conversation's QA pairs with LLM judge.

Usage: bun run evaluate.ts <conversationId> <runId> [waitSeconds]
*/

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config, validateConfig } from '../utils/config.ts';
import { google } from '@ai-sdk/google';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Helper to get model instance based on model name
function getModel(modelName: string) {
    if (modelName.startsWith('gpt') || modelName.startsWith('o1') || modelName.startsWith('o3')) {
        return openai(modelName);
    } else if (modelName.startsWith('gemini')) {
        return google(modelName);
    } else if (modelName.startsWith('claude')) {
        return anthropic(modelName);
    } else {
        // Default to OpenAI for unknown models
        return openai(modelName);
    }
}

// Validate config - only require keys for the providers we're using
const requiredKeys: (keyof typeof config)[] = ['apiKey', 'baseUrl'];
if (config.judgeModel.startsWith('gpt') || config.judgeModel.startsWith('o1') || config.judgeModel.startsWith('o3') || 
    config.generatorModel.startsWith('gpt') || config.generatorModel.startsWith('o1') || config.generatorModel.startsWith('o3')) {
    requiredKeys.push('openaiApiKey');
}
if (config.judgeModel.startsWith('gemini') || config.generatorModel.startsWith('gemini')) {
    requiredKeys.push('googleApiKey');
}
if (config.judgeModel.startsWith('claude') || config.generatorModel.startsWith('claude')) {
    requiredKeys.push('anthropicApiKey');
}
validateConfig(requiredKeys);

// Get command line arguments
const args = process.argv.slice(2);
if (args.length < 2) {
    console.error("Usage: bun run evaluate.ts <conversationId> <runId> [waitSeconds]");
    process.exit(1);
}

const conversationId = args[0]!;
const runId = args[1]!;
const waitSeconds = args.length >= 3 ? parseInt(args[2]!) : 0;
const containerTag = `${conversationId}-${runId}`;

// Models - auto-detect provider based on model name
const JUDGE_MODEL = getModel(config.judgeModel);
const GENERATOR_MODEL = getModel(config.generatorModel);

console.log(`\n=== LoCoMo Evaluation ===`);
console.log(`Conversation ID: ${conversationId}`);
console.log(`Container Tag: ${containerTag}`);
console.log(`Generator: ${config.generatorModel}`);
console.log(`Judge: ${config.judgeModel}`);
if (waitSeconds > 0) {
    console.log(`Will wait ${waitSeconds}s for indexing`);
}
console.log('\n');

// Setup paths
const resultsDir = join(__dirname, '../../results');
if (!existsSync(resultsDir)) {
    mkdirSync(resultsDir, { recursive: true });
}

const resultFilePath = join(resultsDir, `result-${conversationId}-${runId}.json`);

// Load conversation data
const locomoDataPath = join(__dirname, '../../locomo10.json');
if (!existsSync(locomoDataPath)) {
    console.error(`Error: locomo10.json not found at ${locomoDataPath}`);
    process.exit(1);
}

const locomoData = JSON.parse(readFileSync(locomoDataPath, 'utf8'));
const conversation = locomoData.find((c: any) => c.sample_id === conversationId);

if (!conversation) {
    console.error(`Error: Conversation ${conversationId} not found`);
    process.exit(1);
}

const qaPairs = conversation.qa || [];
console.log(`Found ${qaPairs.length} QA pairs to evaluate\n`);

// Search function
const searchQuestion = async (question: string): Promise<any> => {
    const response = await fetch(`${config.baseUrl}/v4/search`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
            q: question,
            containerTag: containerTag,
            limit: 20,
            threshold: 0.3,
            include: { chunks: true }
        }),
    });

    if (!response.ok) {
        throw new Error(`Search failed: ${response.status}`);
    }

    return response.json();
};

// Helper to deduplicate and sort chunks
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

// Generate answer using LLM
const generateAnswer = async (question: string, searchResults: any, questionDate?: string): Promise<string> => {
    const allResults = searchResults.results || [];
    
    // Build memories section with temporal context
    const memoriesSection = allResults
        .map((result: any, i: number) => {
            const memory = result.memory || '';
            const temporalContext = result.metadata?.temporalContext || result.temporalContext;
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
    
    // Extract and deduplicate chunks from all results
    const allChunks: Chunk[] = [];
    for (const result of allResults) {
        const chunks = result.chunks || [];
        for (const chunk of chunks) {
            allChunks.push({
                content: chunk.content || chunk.text || '',
                position: chunk.position ?? 0,
                ...chunk
            });
        }
    }
    const deduplicatedChunks = deduplicateAndSortChunks(allChunks);
    
    // Build chunks section
    const chunksSection = deduplicatedChunks.length > 0
        ? `\n\n=== DEDUPLICATED CHUNKS ===\n${deduplicatedChunks.map(chunk => chunk.content).join('\n\n---\n\n')}`
        : '';
    
    // Combine into retrieved context
    const retrievedContext = memoriesSection + chunksSection;

    if (allResults.length === 0) {
        return "I don't have enough information in my memory to answer this question.";
    }

    try {
        const { text: llmResponse } = await generateText({
            model: GENERATOR_MODEL,
            prompt: `You are a question-answering system. Based on the retrieved context below, answer the question.

Question: ${question}

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

# INSTRUCTIONS (LoCoMo Specific):

1. **Conciseness**: Keep answers concise (typically under 20 words), but ensure completeness.
2. **Timestamp Logic**:
   - If the question asks about a specific event or fact, look for evidence in the memories or chunks.
   - If the content contains contradictory information, prioritize the most recent information.
   - If there is a question about time references (like "last year", "two months ago", etc.), calculate the actual date based on the memory/chunk timestamp.
   - Always convert relative time references to specific dates, months, or years.
3. **Focus**: Focus only on the content of the memories. Do not confuse character names mentioned in memories with the actual users who created those memories.

# APPROACH (Think step by step):

1. First, examine all memories that contain information related to the question.
2. Examine the timestamps and content of these memories carefully.
3. Look for mentions of dates, times, locations, or events that answer the question.
4. If the answer requires calculation (e.g., converting relative time references), show your work.
5. Formulate a precise, concise answer based on the evidence in the memories.
6. Double-check that your answer directly addresses the question asked.
7. Ensure your final answer is specific and avoids vague time references.

Instructions:
- If the context contains enough information to answer the question, provide a clear, concise answer
- If the context does not contain enough information, respond with "I don't know" or explain what information is missing
- Base your answer on the provided context. You may make reasonable inferences from what's stated, but do not introduce facts not grounded in the context.
- **Prioritize information from chunks** - they're the raw source material

Answer:`,
        });

        return llmResponse;
    } catch (error) {
        console.error('Error generating answer:', error);
        return "Error generating answer";
    }
};

// Judge answer
const evaluateAnswer = async (
    question: string,
    groundTruthAnswer: string,
    generatedAnswer: string
): Promise<{ score: number; label: string; reasoning: string }> => {
    try {
        const { text: judgement } = await generateText({
            model: JUDGE_MODEL,
            prompt: `Your task is to label an answer to a question as "CORRECT" or "WRONG". You will be given

the following data: (1) a question (posed by one user to another user), (2) a 'gold'

(ground truth) answer, (3) a generated answer which you will score as CORRECT/WRONG.

The point of the question is to ask about something one user should know about the other

user based on their prior conversations. The gold answer will usually be a concise and

short answer that includes the referenced topic, for example:

Question: Do you remember what I got the last time I went to Hawaii?

Gold answer: A shell necklace

The generated answer might be much longer, but you should be generous with your grading

- as long as it touches on the same topic as the gold answer, it should be counted as

CORRECT.

For time related questions, the gold answer will be a specific date, month, year, etc. The

generated answer might be much longer or use relative time references (like 'last Tuesday'

or 'next month'), but you should be generous with your grading - as long as it refers to

the same date or time period as the gold answer, it should be counted as CORRECT. Even if

the format differs (e.g., 'May 7th' vs '7 May'), consider it CORRECT if it's the same date.

Now it's time for the real question:

Question: ${question}

Gold answer: ${groundTruthAnswer}

Generated answer: ${generatedAnswer}

Return a JSON object with:
- "label": "CORRECT" or "WRONG"
- "reasoning": A short (one sentence) explanation of your reasoning

Example: {"label": "CORRECT", "reasoning": "The generated answer mentions the same topic as the gold answer."}`,
        });

        // Parse JSON response
        let score = 0;
        let label = "WRONG";
        let reasoning = "";
        
        try {
            // Extract JSON block if present (in case LLM wraps it in markdown)
            const jsonMatch = judgement.match(/\{[\s\S]*\}/);
            const jsonStr = jsonMatch ? jsonMatch[0] : judgement;
            const parsed = JSON.parse(jsonStr);
            
            // Handle format: "CORRECT" or "WRONG"
            if (parsed.label === "CORRECT") {
                score = 1;
                label = "CORRECT";
            } else if (parsed.label === "WRONG") {
                score = 0;
                label = "WRONG";
            } else if (parsed.label === 1) {
                score = 1;
                label = "CORRECT";
            }
            
            reasoning = parsed.reasoning || "";
        } catch (e) {
            // Fallback if JSON parsing fails: look for "CORRECT" or "WRONG" in text
            if (judgement.includes('"label": "CORRECT"') || judgement.includes('"label":"CORRECT"')) {
                score = 1;
                label = "CORRECT";
            } else if (judgement.includes('CORRECT') && !judgement.includes('WRONG')) {
                score = 1;
                label = "CORRECT";
            }
            reasoning = judgement; // Use full response as reasoning
        }
        
        return { score, label, reasoning };
    } catch (error) {
        console.error('Error judging answer:', error);
        return { score: 0, label: "WRONG", reasoning: `Error: ${error}` };
    }
};

// Category names
const CATEGORY_NAMES: { [key: number]: string } = {
    1: 'Single-hop',
    2: 'Multi-hop',
    3: 'Temporal',
    4: 'Open-domain',
    5: 'Adversarial'
};

// Main evaluation
const runEvaluation = async () => {
    if (waitSeconds > 0) {
        console.log(`Waiting ${waitSeconds} seconds for indexing...`);
        await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
        console.log('Proceeding with evaluation...\n');
    }

    const results: any[] = [];

    for (let i = 0; i < qaPairs.length; i++) {
        const qa = qaPairs[i];
        const { question, evidence, category } = qa;
        const answer = qa.answer ?? qa.adversarial_answer;

        console.log(`[${i + 1}/${qaPairs.length}] ${CATEGORY_NAMES[category] || 'Unknown'}`);
        console.log(`  Q: ${question.substring(0, 50)}${question.length > 50 ? '...' : ''}`);

        try {
            const searchResults = await searchQuestion(question);
            const generatedAnswer = await generateAnswer(question, searchResults, qa.question_date);
            const judgement = await evaluateAnswer(question, String(answer), generatedAnswer);

            console.log(`  A: ${generatedAnswer.substring(0, 50)}${generatedAnswer.length > 50 ? '...' : ''}`);
            console.log(`  ${judgement.score ? '✓ CORRECT' : '✗ WRONG'}`);

            results.push({
                conversation_id: conversationId,
                question,
                question_category: category,
                ground_truth_answer: answer,
                evidence,
                generated_answer: generatedAnswer,
                score: judgement.score,
                judge_label: judgement.label,
                judge_reasoning: judgement.reasoning,
                search_results: searchResults,
                timestamp: new Date().toISOString(),
            });

            // Save intermediate
            writeFileSync(resultFilePath, JSON.stringify({
                metadata: {
                    conversation_id: conversationId,
                    container_tag: containerTag,
                    run_id: runId,
                    questions_evaluated: results.length,
                    total_questions: qaPairs.length,
                    timestamp: new Date().toISOString(),
                },
                results
            }, null, 2));

        } catch (error) {
            console.error(`  Error: ${error}`);
            results.push({
                conversation_id: conversationId,
                question,
                question_category: category,
                ground_truth_answer: answer,
                evidence,
                generated_answer: "Error",
                score: 0,
                judge_label: "ERROR",
                judge_reasoning: `Error: ${error instanceof Error ? error.message : String(error)}`,
                error: error instanceof Error ? error.message : String(error),
                timestamp: new Date().toISOString(),
            });
        }

        await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // Calculate metrics
    const total = results.length;
    const correct = results.filter(r => r.score === 1).length;
    const accuracy = total > 0 ? (correct / total) * 100 : 0;

    // Category breakdown
    const categoryMetrics: any[] = [];
    for (const cat of [1, 2, 3, 4, 5]) {
        const catResults = results.filter(r => r.question_category === cat);
        const catCorrect = catResults.filter(r => r.score === 1).length;
        const catTotal = catResults.length;
        if (catTotal > 0) {
            categoryMetrics.push({
                category: cat,
                name: CATEGORY_NAMES[cat],
                total: catTotal,
                correct: catCorrect,
                accuracy: (catCorrect / catTotal) * 100
            });
        }
    }

    // Weighted accuracy
    const weightedAccuracy = categoryMetrics.length > 0
        ? categoryMetrics.reduce((sum, c) => sum + c.accuracy, 0) / categoryMetrics.length
        : 0;

    // Save final
    writeFileSync(resultFilePath, JSON.stringify({
        metadata: {
            conversation_id: conversationId,
            container_tag: containerTag,
            run_id: runId,
            total_questions: total,
            correct_answers: correct,
            accuracy: accuracy.toFixed(2) + '%',
            weighted_accuracy: weightedAccuracy.toFixed(2) + '%',
            timestamp: new Date().toISOString(),
        },
        category_metrics: categoryMetrics,
        results
    }, null, 2));

    // Print summary
    console.log('\n' + '═'.repeat(60));
    console.log('                    EVALUATION SUMMARY');
    console.log('═'.repeat(60));
    console.log(`Total Questions:    ${total}`);
    console.log(`Correct Answers:    ${correct}`);
    console.log(`Accuracy:           ${accuracy.toFixed(2)}%`);
    console.log(`Weighted Accuracy:  ${weightedAccuracy.toFixed(2)}%`);
    console.log('─'.repeat(60));
    for (const cat of categoryMetrics) {
        console.log(`${cat.name.padEnd(12)} | ${cat.correct}/${cat.total} | ${cat.accuracy.toFixed(1)}%`);
    }
    console.log('═'.repeat(60));
    console.log(`\n✓ Results saved to: ${resultFilePath}`);
};

await runEvaluation();

