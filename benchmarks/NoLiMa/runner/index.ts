/**
 * NoLiMa Benchmark Runner
 * Main orchestrator for the NoLiMa needle-in-a-haystack benchmark
 */

import { ingestNoLiMa } from './ingest';
import { searchNoLiMa } from './search';
import { evaluateNoLiMa } from './evaluate';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

interface RunOptions {
    runId?: string;
    skipIngest?: boolean;
    skipSearch?: boolean;
    skipEvaluate?: boolean;
    answeringModel?: string | string[];
    judgeModel?: string | string[];
    needleSetType?: string;
    limit?: number;
    topK?: number;
}

function parseOptions(args: string[]): RunOptions {
    const options: RunOptions = {
        skipIngest: false,
        skipSearch: false,
        skipEvaluate: false,
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
            const value = arg.split('=')[1]!;
            options.answeringModel = value.includes(',') ? value.split(',').map(m => m.trim()) : value;
        } else if (arg.startsWith('--judgeModel=')) {
            const value = arg.split('=')[1]!;
            options.judgeModel = value.includes(',') ? value.split(',').map(m => m.trim()) : value;
        } else if (arg.startsWith('--needleSetType=')) {
            options.needleSetType = arg.split('=')[1];
        } else if (arg.startsWith('--limit=')) {
            options.limit = parseInt(arg.split('=')[1]!, 10);
        } else if (arg.startsWith('--topK=')) {
            options.topK = parseInt(arg.split('=')[1]!, 10);
        }
    }

    return options;
}

export async function runNoLiMa(
    providerName: string,
    args: string[]
) {
    const options = parseOptions(args);

    const runId = options.runId || `nolima-${Date.now()}`;
    const answeringModel = options.answeringModel || 'gpt-4o';
    const needleSetType = options.needleSetType || 'standard';

    console.log('=================================');
    console.log('   NoLiMa Benchmark Runner');
    console.log('=================================');
    console.log(`Provider: ${providerName}`);
    console.log(`Run ID: ${runId}`);
    console.log(`Answering Model: ${answeringModel}`);
    if (options.judgeModel) {
        console.log(`Judge Model: ${options.judgeModel}`);
    }
    console.log(`Needle Set: ${needleSetType}`);
    if (options.limit) {
        console.log(`Limit: ${options.limit} test cases`);
    }
    console.log('=================================');
    console.log('');

    try {
        // Phase 1: Ingest haystacks with needles
        if (!options.skipIngest) {
            console.log('Phase 1: Ingesting haystacks with embedded needles...');
            console.log('');
            await ingestNoLiMa(providerName, runId, {
                needleSetType,
                limit: options.limit
            });
        } else {
            console.log('Phase 1: Skipped (--skipIngest)');
            console.log('');
        }

        // Phase 2: Search for needle answers
        if (!options.skipSearch) {
            console.log('Phase 2: Searching for needle answers...');
            console.log('');
            await searchNoLiMa(providerName, runId, {
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
            await evaluateNoLiMa(runId, answeringModel, {
                judgeModel: options.judgeModel
            });
        } else {
            console.log('Phase 3: Skipped (--skipEvaluate)');
            console.log('');
        }

        console.log('=================================');
        console.log('   NoLiMa Benchmark Complete!');
        console.log('=================================');
        console.log('');

        // Display evaluation summary if available
        displayEvaluationSummary(runId);
    } catch (error) {
        console.error('Error running NoLiMa benchmark:', error);
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
            console.log(`Judge Model: ${summary.metadata.judgeModel}`);
            console.log('');
            console.log('Performance Metrics:');
            console.log(`  Overall Accuracy: ${summary.metadata.accuracy}`);
            console.log(`  Base Score: ${(summary.metrics.baseScore).toFixed(2)}%`);
            console.log(`  Effective Length: ${summary.metrics.effectiveLength || 'N/A'}`);
            console.log(`  Retrieval Rate: ${(summary.metrics.retrievalRate).toFixed(2)}%`);
            console.log('');
            console.log('By Context Length:');
            for (const metric of summary.byContextLength) {
                console.log(`  ${metric.contextLength}: ${metric.accuracy} (${metric.correct}/${metric.total})`);
            }
            console.log('='.repeat(60));
            console.log(`✓ Results saved to: results/${runId}/`);
            console.log('');
        } catch (error) {
            // Summary file might not be ready yet if evaluation was skipped
        }
    }
}
