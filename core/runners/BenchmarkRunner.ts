/**
 * Unified Benchmark Runner
 * Eliminates code duplication across benchmarks
 */

import { BaseProvider } from '../providers/BaseProvider';
import { getProviderRegistry } from '../providers/ProviderRegistry';
import { ensureProvidersLoaded } from '../providers/ProviderLoader';

export interface BenchmarkConfig {
    benchmarkName: string;
    providerName: string;
    runId: string;
    resultsDir: string;
}

export abstract class BenchmarkRunner {
    protected config: BenchmarkConfig;
    protected provider!: BaseProvider;

    constructor(config: BenchmarkConfig) {
        this.config = config;
    }

    /**
     * Initialize the benchmark runner
     */
    public async initialize(): Promise<void> {
        // Ensure all providers are loaded
        await ensureProvidersLoaded();

        // Get provider instance
        const registry = getProviderRegistry();
        this.provider = await registry.getProvider(this.config.providerName);

        console.log(`Initialized benchmark: ${this.config.benchmarkName}`);
        console.log(`Provider: ${this.provider.getName()}`);
        console.log(`Run ID: ${this.config.runId}`);
    }

    /**
     * Run the complete benchmark (ingest, search, evaluate)
     */
    public async run(): Promise<void> {
        await this.initialize();

        console.log('');
        console.log('='.repeat(60));
        console.log(`Running ${this.config.benchmarkName} Benchmark`);
        console.log('='.repeat(60));
        console.log('');

        try {
            // Phase 1: Ingest
            console.log('PHASE 1: INGESTION');
            console.log('-'.repeat(60));
            await this.runIngest();
            console.log('');

            // Phase 2: Search
            console.log('PHASE 2: SEARCH');
            console.log('-'.repeat(60));
            await this.runSearch();
            console.log('');

            // Phase 3: Evaluate
            console.log('PHASE 3: EVALUATION');
            console.log('-'.repeat(60));
            await this.runEvaluate();
            console.log('');

            console.log('='.repeat(60));
            console.log('BENCHMARK COMPLETE');
            console.log('='.repeat(60));
            console.log('');
            console.log(`Results saved in: results/${this.config.runId}/`);
        } catch (error) {
            console.error('Benchmark failed:', error);
            throw error;
        }
    }

    /**
     * Run ingestion phase
     */
    protected abstract runIngest(): Promise<void>;

    /**
     * Run search phase
     */
    protected abstract runSearch(): Promise<void>;

    /**
     * Run evaluation phase
     */
    protected abstract runEvaluate(): Promise<void>;

    /**
     * Get checkpoint directory path
     */
    protected getCheckpointDir(phase: string): string {
        const { join } = require('path');
        return join(process.cwd(), 'results', this.config.runId, 'checkpoints', phase);
    }

    /**
     * Get results directory path
     */
    protected getResultsDir(): string {
        const { join } = require('path');
        return join(process.cwd(), 'results', this.config.runId);
    }
}
