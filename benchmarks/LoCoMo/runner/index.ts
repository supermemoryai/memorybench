/**
 * LoCoMo Benchmark Runner
 * Main orchestrator for the LoCoMo long-term conversational memory benchmark
 */

import { ingestAllSamples } from './ingest';
import { searchAllSamples } from './search';
import { evaluateAllSamples } from './evaluate';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

interface RunOptions {
    runId?: string;
    skipIngest?: boolean;
    skipSearch?: boolean;
    skipEvaluate?: boolean;
    answeringModel?: string;
    judgeModel?: string;
    evalMethod?: 'exact' | 'f1' | 'llm';
    startPosition?: number;
    endPosition?: number;
    limit?: number;
    topK?: number;
    sessionDelay?: number;
}

function parseOptions(args: string[]): RunOptions {
    const options: RunOptions = {
        skipIngest: false,
        skipSearch: false,
        skipEvaluate: false,
        evalMethod: 'exact', // Default to exact match (non-LLM)
    };

    for (const arg of args) {
        if (arg.startsWith('--runId=')) {
            options.runId = arg.split('=')[1];
        } else if (arg === '--skipIngest') {
            options.skipIngest = true;
        } else if (arg === '--skipSearch') {
            options.skipSearch = true;
        } else if (arg === '--skipEvaluate') {
            options.skipEvaluate = true;
        } else if (arg.startsWith('--answeringModel=')) {
            options.answeringModel = arg.split('=')[1];
        } else if (arg.startsWith('--judgeModel=')) {
            options.judgeModel = arg.split('=')[1];
        } else if (arg.startsWith('--evalMethod=')) {
            const method = arg.split('=')[1] as 'exact' | 'f1' | 'llm';
            if (!['exact', 'f1', 'llm'].includes(method)) {
                console.warn(`Unknown eval method '${method}', using 'exact'`);
            } else {
                options.evalMethod = method;
            }
        } else if (arg.startsWith('--startPosition=')) {
            options.startPosition = parseInt(arg.split('=')[1], 10);
        } else if (arg.startsWith('--endPosition=')) {
            options.endPosition = parseInt(arg.split('=')[1], 10);
        } else if (arg.startsWith('--limit=')) {
            options.limit = parseInt(arg.split('=')[1]!, 10);
        } else if (arg.startsWith('--topK=')) {
            options.topK = parseInt(arg.split('=')[1]!, 10);
        } else if (arg.startsWith('--sessionDelay=')) {
            options.sessionDelay = parseInt(arg.split('=')[1]!, 10);
        }
    }

    return options;
}

export async function runLoCoMo(
    providerName: string,
    args: string[]
) {
    const options = parseOptions(args);

    const runId = options.runId || `locomo-${Date.now()}`;
    const answeringModel = options.answeringModel || 'gpt-4o';

    // Convert --limit to startPosition/endPosition if provided
    if (options.limit && !options.startPosition && !options.endPosition) {
        options.startPosition = 1;
        options.endPosition = options.limit;
    }

    const evalMethod = options.evalMethod || 'exact';

    console.log('=================================');
    console.log('   LoCoMo Benchmark Runner');
    console.log('=================================');
    console.log(`Provider: ${providerName}`);
    console.log(`Run ID: ${runId}`);
    console.log(`Answering Model: ${answeringModel}`);
    console.log(`Eval Method: ${evalMethod}${evalMethod === 'llm' ? ` (Judge: ${options.judgeModel || 'gpt-4o'})` : ' (no LLM judge)'}`);
    if (options.startPosition && options.endPosition) {
        console.log(`Sample Range: ${options.startPosition}-${options.endPosition}`);
    }
    console.log('=================================');
    console.log('');

    try {
        // Phase 1: Ingest conversation sessions
        if (!options.skipIngest) {
            console.log('Phase 1: Ingesting conversation sessions...');
            console.log('');
            await ingestAllSamples(providerName, runId, {
                startPosition: options.startPosition,
                endPosition: options.endPosition,
                sessionDelay: options.sessionDelay
            });
        } else {
            console.log('Phase 1: Skipped (--skipIngest)');
            console.log('');
        }

        // Phase 2: Search for relevant context
        if (!options.skipSearch) {
            console.log('Phase 2: Searching for relevant context...');
            console.log('');
            await searchAllSamples(providerName, runId, {
                startPosition: options.startPosition,
                endPosition: options.endPosition,
                topK: options.topK
            });
        } else {
            console.log('Phase 2: Skipped (--skipSearch)');
            console.log('');
        }

        // Phase 3: Evaluate answers
        if (!options.skipEvaluate) {
            console.log('Phase 3: Evaluating answers...');
            console.log('');
            await evaluateAllSamples(runId, answeringModel, {
                startPosition: options.startPosition,
                endPosition: options.endPosition,
                judgeModel: options.judgeModel,
                evalMethod,
                providerName
            });
        } else {
            console.log('Phase 3: Skipped (--skipEvaluate)');
            console.log('');
        }

        console.log('=================================');
        console.log('   LoCoMo Benchmark Complete!');
        console.log('=================================');
        console.log('');

        // Display evaluation summary if available
        displayEvaluationSummary(runId);
    } catch (error) {
        console.error('Error running LoCoMo benchmark:', error);
        throw error;
    }
}

function displayEvaluationSummary(runId: string): void {
    const summaryPath = join(process.cwd(), 'results', runId, 'evaluation-summary.json');
    
    if (existsSync(summaryPath)) {
        try {
            const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
            
            console.log('📊 EVALUATION RESULTS');
            console.log('='.repeat(60));
            console.log(`Benchmark: ${summary.benchmark}`);
            console.log(`Provider:  ${summary.metadata.provider}`);
            console.log(`Answering Model: ${summary.metadata.answeringModel}`);
            console.log(`Eval Method: ${summary.metadata.evalMethod || 'llm'}`);
            if (summary.metadata.evalMethod === 'llm' || !summary.metadata.evalMethod) {
                console.log(`Judge Model: ${summary.metadata.judgeModel}`);
            }
            console.log('');
            console.log('Performance Metrics:');
            console.log(`  Overall Accuracy: ${summary.metadata.accuracy}`);
            console.log(`  Total Questions: ${summary.metadata.totalQuestions}`);
            console.log(`  Correct Answers: ${summary.metadata.correctAnswers}`);
            console.log('');
            if (summary.byCategory && summary.byCategory.length > 0) {
                console.log('By Category:');
                for (const cat of summary.byCategory) {
                    console.log(`  ${cat.categoryName}: ${cat.accuracy} (${cat.correct}/${cat.total})`);
                }
                console.log('');
            }
            console.log('='.repeat(60));
            console.log(`✓ Results saved to: results/${runId}/`);
            console.log('');
        } catch (error) {
            // Summary file might not be ready yet if evaluation was skipped
        }
    }
}
