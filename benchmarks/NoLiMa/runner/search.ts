/**
 * Search module for NoLiMa benchmark
 * Tests retrieval quality by searching for answers to questions
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import type { TestCase, SearchResult } from '../types';
import { getProviderRegistry } from '../../../core/providers/ProviderRegistry';
import type { BaseProvider } from '../../../core/providers/BaseProvider';

interface SearchOptions {
    topK?: number;
}

interface SearchCheckpoint {
    runId: string;
    providerName: string;
    searchResults: SearchResult[];
    lastProcessedIndex: number;
}

export async function searchNoLiMa(
    providerName: string,
    runId: string,
    options?: SearchOptions
) {
    console.log(`[NoLiMa] Searching for needle answers...`);
    console.log(`Provider: ${providerName}`);
    console.log(`Run ID: ${runId}`);
    console.log('');

    // Load test cases from ingest phase
    const ingestDir = join(process.cwd(), 'results', runId, 'checkpoints', 'ingest');
    const testCasesPath = join(ingestDir, `testcases-${runId}.json`);

    if (!existsSync(testCasesPath)) {
        throw new Error(`Test cases not found. Run ingestion phase first.`);
    }

    const testCases: TestCase[] = JSON.parse(readFileSync(testCasesPath, 'utf8'));
    console.log(`Loaded ${testCases.length} test cases`);
    console.log('');

    // Setup checkpoint
    const checkpointDir = join(process.cwd(), 'results', runId, 'checkpoints', 'search');
    if (!existsSync(checkpointDir)) {
        mkdirSync(checkpointDir, { recursive: true });
    }

    const checkpointPath = join(checkpointDir, `search-${runId}.json`);
    let checkpoint: SearchCheckpoint;

    if (existsSync(checkpointPath)) {
        checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8'));
        console.log(`Resuming from checkpoint: ${checkpoint.searchResults.length}/${testCases.length} searched`);
    } else {
        checkpoint = {
            runId,
            providerName,
            searchResults: [],
            lastProcessedIndex: -1
        };
    }

    // Get provider from registry
    const registry = getProviderRegistry();
    const provider = await registry.getProvider(providerName);
    await provider.initialize();

    const containerTag = `nolima-${runId}`;
    const topK = options?.topK || 5;

    // Search for each test case
    for (let i = checkpoint.lastProcessedIndex + 1; i < testCases.length; i++) {
        const testCase = testCases[i];

        if (i % 10 === 0 || i === 0) {
            console.log(`[${i + 1}/${testCases.length}] Searching: ${testCase.testId}...`);
        }

        try {
            // Use unified provider interface
            const results = await provider.search(testCase.question, containerTag, { limit: topK });
            const retrievedContext = results.map((r: any) => r.content).join('\n\n---\n\n');
            const retrievedNeedle = retrievedContext.toLowerCase().includes(testCase.needle.toLowerCase());

            const searchResult: SearchResult = {
                testCaseId: testCase.testId,
                needleId: testCase.needleId,
                testId: testCase.testId,
                question: testCase.question,
                retrievedContext,
                retrievedNeedle,
                timestamp: new Date().toISOString()
            };

            checkpoint.searchResults.push(searchResult);
            checkpoint.lastProcessedIndex = i;

            // Save checkpoint periodically
            if (i % 10 === 0 || i === testCases.length - 1) {
                writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));
            }

            // Small delay between searches
            if (i < testCases.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        } catch (error) {
            console.error(`  ✗ Failed: ${error instanceof Error ? error.message : String(error)}`);
            writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));
            throw error;
        }
    }

    console.log('');
    console.log('Search Summary:');
    console.log(`  Total searches: ${checkpoint.searchResults.length}`);
    const needleRetrievalCount = checkpoint.searchResults.filter(r => r.retrievedNeedle).length;
    const retrievalRate = (needleRetrievalCount / checkpoint.searchResults.length * 100).toFixed(2);
    console.log(`  Needle retrieved: ${needleRetrievalCount}/${checkpoint.searchResults.length} (${retrievalRate}%)`);
    console.log('');
}
