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
            // Use unified provider interface with timing
            const searchStart = performance.now();
            const results = await provider.search(testCase.question, containerTag, { limit: topK });
            const searchDurationMs = Math.round(performance.now() - searchStart);
            
            const retrievedContext = results.map((r: any) => r.content || '').filter(c => c).join('\n\n---\n\n');
            
            // Warn if no context was retrieved
            if (!retrievedContext && results.length > 0) {
                console.warn(`  ⚠ Warning: ${results.length} results returned but no content extracted. Check provider response format.`);
            }
            
            // Check if needle is retrieved - use more lenient matching for memory providers
            // that extract facts rather than storing raw text
            const needleLower = testCase.needle.toLowerCase();
            const contextLower = retrievedContext.toLowerCase();
            
            // Method 1: Exact substring match
            let retrievedNeedle = contextLower.includes(needleLower);
            
            // Method 2: If exact match fails, check if key content words are present
            // This handles cases where memory providers extract/rephrase facts
            if (!retrievedNeedle) {
                // Extract key content words (nouns, verbs) from needle, removing common words
                const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 
                    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
                    'must', 'shall', 'can', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as',
                    'into', 'through', 'during', 'before', 'after', 'above', 'below', 'between', 'under', 'again',
                    'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
                    'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same',
                    'so', 'than', 'too', 'very', 'just', 'and', 'but', 'if', 'or', 'because', 'until', 'while',
                    'that', 'which', 'who', 'whom', 'this', 'these', 'those', 'am', 'its', 'it', 'he', 'she',
                    'they', 'them', 'his', 'her', 'their', 'what', 'actually', 'really', 'certainly']);
                
                const needleWords = needleLower
                    .replace(/[^a-z0-9\s]/g, ' ')
                    .split(/\s+/)
                    .filter(w => w.length > 2 && !stopWords.has(w));
                
                // Require at least 70% of key words to be present in context
                if (needleWords.length > 0) {
                    const matchedWords = needleWords.filter(word => contextLower.includes(word));
                    const matchRatio = matchedWords.length / needleWords.length;
                    retrievedNeedle = matchRatio >= 0.7;
                }
            }

            const searchResult: SearchResult = {
                testCaseId: testCase.testId,
                needleId: testCase.needleId,
                testId: testCase.testId,
                question: testCase.question,
                retrievedContext,
                retrievedNeedle,
                timestamp: new Date().toISOString(),
                searchDurationMs,
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
    
    // Timing stats
    const durations = checkpoint.searchResults.map(r => r.searchDurationMs).filter(d => d !== undefined) as number[];
    if (durations.length > 0) {
        const avgDuration = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
        const minDuration = Math.min(...durations);
        const maxDuration = Math.max(...durations);
        console.log(`  Avg search time: ${avgDuration}ms (min: ${minDuration}ms, max: ${maxDuration}ms)`);
    }
    console.log('');
}
