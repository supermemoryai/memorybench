/**
 * NoLiMa Benchmark Runner
 * Main orchestrator for the NoLiMa needle-in-a-haystack benchmark
 */

import { ingestNoLiMa } from './ingest';
import { searchNoLiMa } from './search';
import { evaluateNoLiMa } from './evaluate';

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
    } catch (error) {
        console.error('Error running NoLiMa benchmark:', error);
        throw error;
    }
}
