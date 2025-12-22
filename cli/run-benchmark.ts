#!/usr/bin/env bun
/**
 * Unified CLI for running benchmarks with specific providers
 * Usage: bun run benchmark <benchmark-name> <provider-name> [options]
 * Example: bun run benchmark LongMemEval supermemory --runId=test-run
 */

import { parseArgs } from "util";

const AVAILABLE_BENCHMARKS = ['LongMemEval', 'LoCoMo', 'NoLiMa'];
const AVAILABLE_PROVIDERS = ['supermemory', 'mem0', 'zep', 'AQRAG', 'ContextualRetrieval'];

// Parse command line arguments
const args = process.argv.slice(2);

if (args.length < 2) {
    console.error('Usage: bun run benchmark <benchmark-name> <provider-name> [options]');
    console.error('');
    console.error('Available benchmarks:', AVAILABLE_BENCHMARKS.join(', '));
    console.error('Available providers:', AVAILABLE_PROVIDERS.join(', '));
    console.error('');
    console.error('Examples:');
    console.error('  bun run benchmark LongMemEval supermemory --runId=run1');
    console.error('  bun run benchmark LongMemEval supermemory --runId=run1 --limit=5');
    console.error('  bun run benchmark LoCoMo supermemory --runId=run1 --limit=2');
    console.error('  bun run benchmark NoLiMa supermemory --runId=run1 --limit=10');
    console.error('  bun run benchmark LongMemEval supermemory --runId=run1 --answeringModel=gpt-4o --judgeModel=gpt-4o');
    console.error('  bun run benchmark LongMemEval supermemory --runId=run1 --skipIngest');
    console.error('  bun run benchmark LongMemEval supermemory --runId=run1 --skipSearch');
    process.exit(1);
}

const benchmarkName = args[0];
const providerName = args[1];
const options = args.slice(2);

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
