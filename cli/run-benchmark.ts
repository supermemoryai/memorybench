#!/usr/bin/env bun
/**
 * Unified CLI for running benchmarks with specific providers
 * Usage: bun run benchmark <benchmark-name> <provider-name> [options]
 * Example: bun run benchmark LongMemEval supermemory
 */

import { parseArgs } from "util";
import { readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { ProviderLoader } from '../core/providers/ProviderLoader';
import { getProviderRegistry } from '../core/providers/ProviderRegistry';

const AVAILABLE_BENCHMARKS = ['LongMemEval', 'LoCoMo', 'NoLiMa'];

// Load all providers from the providers directory
await ProviderLoader.loadAll();
const registry = getProviderRegistry();
const AVAILABLE_PROVIDERS = registry.getAvailableProviders();

// Helper function to generate runID in format: benchmark_provider_datetime[_formal]
function generateRunId(benchmarkName: string, providerName: string, formal: boolean = false): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');

    const datetime = `${year}${month}${day}_${hours}${minutes}${seconds}`;
    const baseId = `${benchmarkName}_${providerName}_${datetime}`;
    return formal ? `${baseId}_formal` : baseId;
}

/**
 * Find the most recent run ID matching the benchmark and provider
 * @param benchmarkName - Benchmark name to match
 * @param providerName - Provider name to match
 * @param formal - Whether to match only formal runs
 * @returns The most recent matching run ID, or null if none found
 */
function findLastMatchingRunId(benchmarkName: string, providerName: string, formal: boolean): string | null {
    const resultsDir = join(process.cwd(), 'results');
    
    if (!existsSync(resultsDir)) {
        return null;
    }

    // Get all directories in results/
    const runDirs = readdirSync(resultsDir)
        .filter(dir => {
            const fullPath = join(resultsDir, dir);
            return statSync(fullPath).isDirectory();
        })
        .filter(dir => {
            // Match pattern: {Benchmark}_{provider}_{datetime}[_formal]
            const prefix = `${benchmarkName}_${providerName}_`;
            if (!dir.startsWith(prefix)) {
                return false;
            }
            
            // Check formal suffix matching
            const isFormalRun = dir.endsWith('_formal');
            if (formal && !isFormalRun) {
                return false;
            }
            if (!formal && isFormalRun) {
                return false;
            }
            
            return true;
        })
        .sort((a, b) => {
            // Sort by datetime in descending order (most recent first)
            // Extract datetime part: after benchmark_provider_ and before optional _formal
            const extractDatetime = (s: string) => {
                const prefix = `${benchmarkName}_${providerName}_`;
                let rest = s.slice(prefix.length);
                if (rest.endsWith('_formal')) {
                    rest = rest.slice(0, -7);
                }
                return rest;
            };
            return extractDatetime(b).localeCompare(extractDatetime(a));
        });

    return runDirs.length > 0 ? runDirs[0] : null;
}

// Parse command line arguments
const args = process.argv.slice(2);

if (args.length < 2) {
    console.error('Usage: bun run benchmark <benchmark-name> <provider-name> [options]');
    console.error('');
    console.error('Available benchmarks:', AVAILABLE_BENCHMARKS.join(', '));
    console.error('Available providers:', AVAILABLE_PROVIDERS.join(', '));
    console.error('');
    console.error('Examples:');
    console.error('  bun run benchmark LongMemEval supermemory');
    console.error('  bun run benchmark LongMemEval supermemory --limit=5');
    console.error('  bun run benchmark LoCoMo supermemory --limit=2');
    console.error('  bun run benchmark NoLiMa supermemory --limit=10');
    console.error('');
    console.error('Continue a previous run:');
    console.error('  bun run benchmark LoCoMo fullcontext --continue');
    console.error('  bun run benchmark NoLiMa supermemory --formal --continue');
    console.error('');
    console.error('Multiple models (comma-separated):');
    console.error('  bun run benchmark NoLiMa supermemory --answeringModel=gpt-4o,gpt-4o-mini --judgeModel=gpt-4o');
    console.error('  bun run benchmark NoLiMa fullcontext --answeringModel=gpt-4o,claude-3-5-sonnet-20241022');
    console.error('  bun run benchmark NoLiMa supermemory --judgeModel=gpt-4o,claude-3-5-sonnet-20241022');
    console.error('');
    console.error('Skip phases:');
    console.error('  bun run benchmark LongMemEval supermemory --skipIngest');
    console.error('  bun run benchmark LongMemEval supermemory --skipSearch');
    console.error('');
    console.error('Formal runs (for visualization dashboard):');
    console.error('  bun run benchmark NoLiMa supermemory --formal');
    console.error('  bun run benchmark LongMemEval mem0 --formal --limit=50');
    console.error('');
    console.error('Note: runId is auto-generated as benchmark_provider_datetime[_formal]');
    console.error('      All results are stored in results/ directory');
    console.error('      Multiple models will create separate evaluation reports for each combination');
    console.error('      Use --formal flag to mark runs for inclusion in visualization dashboard');
    console.error('      Use --continue to resume the most recent matching run');
    process.exit(1);
}

const benchmarkName = args[0];
const providerName = args[1];
let options = args.slice(2);

// Check if --formal flag is present
const hasFormal = options.some(opt => opt === '--formal');

// Check if --continue flag is present
const hasContinue = options.some(opt => opt === '--continue');
// Remove --continue from options as it's handled here
options = options.filter(opt => opt !== '--continue');

// Determine runId
const hasRunId = options.some(opt => opt.startsWith('--runId='));
if (!hasRunId) {
    if (hasContinue) {
        // Find the most recent matching run
        const lastRunId = findLastMatchingRunId(benchmarkName, providerName, hasFormal);
        if (!lastRunId) {
            console.error(`Error: No previous run found for ${benchmarkName} with ${providerName}${hasFormal ? ' (formal)' : ''}`);
            console.error('Cannot continue - please start a new run instead.');
            process.exit(1);
        }
        options.unshift(`--runId=${lastRunId}`);
        console.log(`Continuing previous run: ${lastRunId}`);
    } else {
        // Generate new runId
        const runId = generateRunId(benchmarkName, providerName, hasFormal);
        options.unshift(`--runId=${runId}`);
        console.log(`Auto-generated runId: ${runId}`);
    }
}

// Validate benchmark
if (!AVAILABLE_BENCHMARKS.includes(benchmarkName)) {
    console.error(`Error: Unknown benchmark '${benchmarkName}'`);
    console.error('Available benchmarks:', AVAILABLE_BENCHMARKS.join(', '));
    process.exit(1);
}

// Validate provider
if (!AVAILABLE_PROVIDERS.includes(providerName)) {
    console.error(`Error: Unknown provider '${providerName}'`);
    console.error('Available providers:', AVAILABLE_PROVIDERS.join(', '));
    process.exit(1);
}

console.log('='.repeat(60));
console.log(`Running ${benchmarkName} benchmark with ${providerName} provider`);
console.log('='.repeat(60));
console.log('');

// Route to appropriate benchmark runner
switch (benchmarkName) {
    case 'LongMemEval':
        const { runLongMemEval } = await import('../benchmarks/LongMemEval/runner/index.ts');
        await runLongMemEval(providerName, options);
        break;

    case 'LoCoMo':
        const { runLoCoMo } = await import('../benchmarks/LoCoMo/runner/index.ts');
        await runLoCoMo(providerName, options);
        break;

    case 'NoLiMa':
        const { runNoLiMa } = await import('../benchmarks/NoLiMa/runner/index.ts');
        await runNoLiMa(providerName, options);
        break;

    default:
        console.error(`Error: Benchmark '${benchmarkName}' not implemented yet`);
        process.exit(1);
}
