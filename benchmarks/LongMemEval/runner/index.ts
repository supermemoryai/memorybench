/**
 * LongMemEval Benchmark Runner
 * Orchestrates the full benchmark pipeline: ingest -> search -> evaluate
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { ingestAllQuestions } from './ingest';
import { searchAllQuestions } from './search';
import { evaluateAllQuestions } from './evaluate';

interface RunOptions {
    runId?: string;
    skipIngest?: boolean;
    skipSearch?: boolean;
    skipEvaluate?: boolean;
    questionTypes?: string[];
    answeringModel?: string;
    judgeModel?: string;
    startPosition?: number;
    endPosition?: number;
    limit?: number;
    // Optimization options
    optimized?: boolean;
    batchSize?: number;
    sessionDelay?: number;
}

function parseOptions(args: string[]): RunOptions {
    const options: RunOptions = {
        skipIngest: false,
        skipSearch: false,
        skipEvaluate: false,
        questionTypes: [],
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
        } else if (arg.startsWith('--questionTypes=')) {
            options.questionTypes = arg.split('=')[1].split(',');
        } else if (arg.startsWith('--answeringModel=')) {
            options.answeringModel = arg.split('=')[1];
        } else if (arg.startsWith('--judgeModel=')) {
            options.judgeModel = arg.split('=')[1];
        } else if (arg.startsWith('--startPosition=')) {
            options.startPosition = parseInt(arg.split('=')[1], 10);
        } else if (arg.startsWith('--endPosition=')) {
            options.endPosition = parseInt(arg.split('=')[1], 10);
        } else if (arg.startsWith('--limit=')) {
            options.limit = parseInt(arg.split('=')[1]!, 10);
        } else if (arg === '--optimized') {
            options.optimized = true;
        } else if (arg.startsWith('--batchSize=')) {
            options.batchSize = parseInt(arg.split('=')[1]!, 10);
        } else if (arg.startsWith('--sessionDelay=')) {
            options.sessionDelay = parseInt(arg.split('=')[1]!, 10);
        }
    }

    return options;
}

export async function runLongMemEval(providerName: string, args: string[]) {
    const options = parseOptions(args);

    // Validate required options
    if (!options.runId) {
        console.error('Error: --runId is required');
        console.error('Example: bun run benchmark LongMemEval supermemory --runId=test-run-1');
        process.exit(1);
    }

    const runId = options.runId;
    const answeringModel = options.answeringModel || 'gpt-4o';
    const judgeModel = options.judgeModel || 'gpt-4o';

    // Convert --limit to startPosition/endPosition if provided
    if (options.limit && !options.startPosition && !options.endPosition) {
        options.startPosition = 1;
        options.endPosition = options.limit;
        console.log(`Using --limit=${options.limit} (processing first ${options.limit} questions per type)`);
        console.log('');
    }

    // Check if dataset is prepared
    const questionsDir = join(process.cwd(), 'benchmarks/LongMemEval/datasets/questions');
    if (!existsSync(questionsDir)) {
        console.error('Error: Questions directory not found!');
        console.error('Please run setup first:');
        console.error('  1. Download longmemeval_s_cleaned.json from HuggingFace');
        console.error('  2. Place it in benchmarks/LongMemEval/datasets/');
        console.error('  3. Run: cd benchmarks/LongMemEval && bun run scripts/setup/split_questions.ts');
        process.exit(1);
    }

    const questionFiles = readdirSync(questionsDir).filter(f => f.endsWith('.json'));
    if (questionFiles.length === 0) {
        console.error('Error: No question files found!');
        console.error('Run: cd benchmarks/LongMemEval && bun run scripts/setup/split_questions.ts');
        process.exit(1);
    }

    console.log(`Found ${questionFiles.length} question files`);
    console.log('');

    // Get question types to process
    const AVAILABLE_TYPES = [
        'single-session-user',
        'single-session-assistant',
        'single-session-preference',
        'knowledge-update',
        'temporal-reasoning',
        'multi-session',
    ];

    let questionTypesToProcess = options.questionTypes && options.questionTypes.length > 0
        ? options.questionTypes
        : AVAILABLE_TYPES;

    console.log('Question types to process:', questionTypesToProcess.join(', '));
    console.log('');

    // Phase 1: Ingestion
    if (!options.skipIngest) {
        console.log('='.repeat(60));
        console.log('PHASE 1: INGESTION');
        console.log('='.repeat(60));
        console.log('');

        for (const questionType of questionTypesToProcess) {
            await ingestAllQuestions(providerName, runId, questionType, {
                startPosition: options.startPosition,
                endPosition: options.endPosition,
            });
        }
    } else {
        console.log('Skipping ingestion (--skipIngest flag set)');
        console.log('');
    }

    // Phase 2: Search
    if (!options.skipSearch) {
        console.log('='.repeat(60));
        console.log('PHASE 2: SEARCH');
        console.log('='.repeat(60));
        console.log('');

        for (const questionType of questionTypesToProcess) {
            await searchAllQuestions(providerName, runId, questionType, {
                startPosition: options.startPosition,
                endPosition: options.endPosition,
            });
        }
    } else {
        console.log('Skipping search (--skipSearch flag set)');
        console.log('');
    }

    // Phase 3: Evaluation
    if (!options.skipEvaluate) {
        console.log('='.repeat(60));
        console.log('PHASE 3: EVALUATION');
        console.log('='.repeat(60));
        console.log('');

        // Evaluate all question types together
        await evaluateAllQuestions(runId, answeringModel, questionTypesToProcess, {
            startPosition: options.startPosition,
            endPosition: options.endPosition,
            judgeModel,
            providerName,
        });
    } else {
        console.log('Skipping evaluation (--skipEvaluate flag set)');
        console.log('');
    }

    console.log('='.repeat(60));
    console.log('BENCHMARK COMPLETE');
    console.log('='.repeat(60));
    console.log('');
    console.log(`Results saved in: results/${runId}/`);
    console.log(`  - Checkpoints: results/${runId}/checkpoints/`);
    console.log(`  - Search results: results/${runId}/search/`);
    console.log(`  - Evaluations: results/${runId}/evaluation/`);
    console.log('');

    // Display evaluation summary if available
    displayEvaluationSummary(runId);
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
            console.log(`Judge Model: ${summary.metadata.judgeModel}`);
            console.log('');
            console.log('Performance Metrics:');
            console.log(`  Overall Accuracy: ${summary.metadata.accuracy}`);
            console.log(`  Total Questions: ${summary.metadata.totalQuestions}`);
            console.log(`  Correct Answers: ${summary.metadata.correctAnswers}`);
            console.log('');
            if (summary.byQuestionType && summary.byQuestionType.length > 0) {
                console.log('By Question Type:');
                for (const qtype of summary.byQuestionType) {
                    console.log(`  ${qtype.questionType}: ${qtype.accuracy} (${qtype.correct}/${qtype.total})`);
                }
                console.log('');
            }
            console.log('='.repeat(60));
            console.log(`✓ Full results available at: results/${runId}/evaluation-summary.json`);
            console.log('');
        } catch (error) {
            // Summary file might not be ready yet if evaluation was skipped
        }
    }
}
