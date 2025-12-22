/**
 * Ingestion module for NoLiMa benchmark
 * Ingests haystacks with embedded needles into memory providers
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { prepareTestCases } from './prepare-tests';
import { getProviderRegistry } from '../../../core/providers/ProviderRegistry';
import type { BaseProvider } from '../../../core/providers/BaseProvider';

interface IngestOptions {
    needleSetType?: string;
    limit?: number;
}

interface IngestCheckpoint {
    runId: string;
    providerName: string;
    needleSetType: string;
    testCasesIngested: number;
    totalTestCases: number;
    lastIngestedIndex: number;
    timestamp: string;
}

export async function ingestNoLiMa(
    providerName: string,
    runId: string,
    options?: IngestOptions
) {
    console.log(`[NoLiMa] Ingesting haystacks with embedded needles...`);
    console.log(`Provider: ${providerName}`);
    console.log(`Run ID: ${runId}`);

    const needleSetType = options?.needleSetType || 'standard';
    console.log(`Needle Set: ${needleSetType}`);
    console.log('');

    // Prepare test cases
    const needleSetPath = getNeedleSetPath(needleSetType);
    const haystackDir = join(process.cwd(), 'benchmarks/NoLiMa/datasets/haystack/rand_shuffle');

    console.log('Preparing test cases...');
    const testCases = prepareTestCases(needleSetPath, haystackDir);

    // Apply limit if specified
    const casesToIngest = options?.limit
        ? testCases.slice(0, options.limit)
        : testCases;

    console.log(`Total test cases: ${testCases.length}`);
    console.log(`Ingesting: ${casesToIngest.length}`);
    console.log('');

    // Setup checkpoint
    const checkpointDir = join(process.cwd(), 'results', runId, 'checkpoints', 'ingest');
    if (!existsSync(checkpointDir)) {
        mkdirSync(checkpointDir, { recursive: true });
    }

    const checkpointPath = join(checkpointDir, `ingest-${runId}.json`);
    let checkpoint: IngestCheckpoint;

    if (existsSync(checkpointPath)) {
        checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8'));
        console.log(`Resuming from checkpoint: ${checkpoint.testCasesIngested}/${checkpoint.totalTestCases} ingested`);
    } else {
        checkpoint = {
            runId,
            providerName,
            needleSetType,
            testCasesIngested: 0,
            totalTestCases: casesToIngest.length,
            lastIngestedIndex: -1,
            timestamp: new Date().toISOString()
        };
    }

    // Get provider from registry
    const registry = getProviderRegistry();
    const provider = await registry.getProvider(providerName);
    await provider.initialize();

    const containerTag = `nolima-${runId}`;

    // Ingest test cases
    for (let i = checkpoint.lastIngestedIndex + 1; i < casesToIngest.length; i++) {
        const testCase = casesToIngest[i];

        if (i % 10 === 0 || i === 0) {
            console.log(`[${i + 1}/${casesToIngest.length}] Ingesting test case ${testCase.testId}...`);
        }

        try {
            // Ingest the haystack (with embedded needle)
            await provider.ingest(testCase.haystack, containerTag);

            checkpoint.testCasesIngested++;
            checkpoint.lastIngestedIndex = i;
            checkpoint.timestamp = new Date().toISOString();

            // Save checkpoint periodically
            if (i % 10 === 0 || i === casesToIngest.length - 1) {
                writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));
            }

            // Small delay between ingestions
            if (i < casesToIngest.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        } catch (error) {
            console.error(`  ✗ Failed: ${error instanceof Error ? error.message : String(error)}`);
            writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));
            throw error;
        }
    }

    console.log('');
    console.log('Ingestion Summary:');
    console.log(`  Total ingested: ${checkpoint.testCasesIngested}`);
    console.log(`  Container tag: ${containerTag}`);
    console.log('');

    // Save test cases for later phases
    const testCasesPath = join(checkpointDir, `testcases-${runId}.json`);
    writeFileSync(testCasesPath, JSON.stringify(casesToIngest, null, 2));
}

function getNeedleSetPath(type: string): string {
    const base = join(process.cwd(), 'benchmarks/NoLiMa/datasets');

    switch (type) {
        case 'standard':
            return join(base, 'needle_set.json');
        case 'hard':
            return join(base, 'needle_set_hard.json');
        case 'mc':
            return join(base, 'needle_set_MC.json');
        case 'direct':
            return join(base, 'needle_set_ONLYDirect.json');
        case 'cot':
            return join(base, 'needle_set_w_CoT.json');
        case 'distractor':
            return join(base, 'needle_set_w_Distractor.json');
        default:
            return join(base, 'needle_set.json');
    }
}
