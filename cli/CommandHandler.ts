/**
 * Command Handler - Routes commands to appropriate handlers
 */

import { ProviderLoader } from '../core/providers/ProviderLoader';
import { getProviderRegistry } from '../core/providers/ProviderRegistry';
import { logger } from './Logger';
import type { Command, RunCommand } from './CliParser';

const AVAILABLE_BENCHMARKS = ['LongMemEval', 'LoCoMo', 'NoLiMa'];

export class CommandHandler {
    private registry = getProviderRegistry();
    private timerStart: Map<string, number> = new Map();

    async handle(command: Command): Promise<void> {
        switch (command.type) {
            case 'run':
                await this.handleRun(command);
                break;
            case 'list-benchmarks':
                await this.handleListBenchmarks();
                break;
            case 'list-providers':
                await this.handleListProviders();
                break;
            case 'help':
                this.handleHelp();
                break;
        }
    }

    private async handleRun(command: RunCommand): Promise<void> {
        // Load all providers
        logger.subsection('Loading providers...');
        logger.startTimer('provider-load');
        await ProviderLoader.loadAll();
        logger.logTimer('provider-load', 'Provider initialization');

        const { benchmark, provider, options } = command;

        // Validate benchmark
        if (!AVAILABLE_BENCHMARKS.includes(benchmark)) {
            logger.error(`Unknown benchmark '${benchmark}'`);
            logger.info('Available benchmarks: ' + AVAILABLE_BENCHMARKS.join(', '));
            process.exit(1);
        }

        // Validate provider
        const availableProviders = this.registry.getAvailableProviders();
        if (!availableProviders.includes(provider)) {
            logger.error(`Unknown provider '${provider}'`);
            logger.info('Available providers: ' + availableProviders.join(', '));
            process.exit(1);
        }

        logger.section(`Running ${benchmark} with ${provider}`);

        // Log configuration
        logger.table({
            'Benchmark': benchmark,
            'Provider': provider,
            'Timestamp': new Date().toISOString(),
        });

        // Log options if any
        if (Object.keys(options).length > 0) {
            logger.subsection('Options');
            logger.table(options as Record<string, string | number>);
        }

        // Convert options object to args array for benchmark runners
        const args = this.optionsToArgs(benchmark, provider, options);

        // Route to appropriate benchmark
        logger.startTimer('benchmark-run');
        try {
            switch (benchmark) {
                case 'LongMemEval':
                    const { runLongMemEval } = await import('../benchmarks/LongMemEval/runner/index');
                    await runLongMemEval(provider, args);
                    break;

                case 'LoCoMo':
                    const { runLoCoMo } = await import('../benchmarks/LoCoMo/runner/index');
                    await runLoCoMo(provider, args);
                    break;

                case 'NoLiMa':
                    const { runNoLiMa } = await import('../benchmarks/NoLiMa/runner/index');
                    await runNoLiMa(provider, args);
                    break;

                default:
                    logger.error(`Benchmark '${benchmark}' not implemented yet`);
                    process.exit(1);
            }

            const totalTime = this.endTimer('benchmark-run');
            logger.section(`Benchmark Completed Successfully`);
            logger.success(`Total execution time: ${totalTime}`);
            logger.info(`Results saved in: results/${options.runId || 'auto-generated'}/`);
        } catch (error) {
            logger.error(`Benchmark failed: ${error instanceof Error ? error.message : error}`);
            throw error;
        }
    }

    private endTimer(key: string): string {
        const start = this.timerStart.get(key);
        if (!start) {
            return 'unknown time';
        }

        const elapsed = Date.now() - start;
        const seconds = (elapsed / 1000).toFixed(2);
        this.timerStart.delete(key);

        return `${seconds}s`;
    }

    private optionsToArgs(benchmarkName: string, providerName: string, options: Record<string, string | number | boolean>): string[] {
        const args: string[] = [];

        for (const [key, value] of Object.entries(options)) {
            if (value === true) {
                // Boolean flag
                args.push(`--${key}`);
            } else if (value !== false) {
                // Key=value pair (skip false values)
                args.push(`--${key}=${value}`);
            }
        }

        // Auto-generate runId if not provided
        if (!args.some(arg => arg.startsWith('--runId'))) {
            const runId = this.generateRunId(
                benchmarkName,
                providerName,
                options.formal === true
            );
            args.unshift(`--runId=${runId}`);
            logger.info(`Auto-generated runId: ${runId}`);
        }

        return args;
    }

    private generateRunId(benchmarkName: string, providerName: string, formal: boolean = false): string {
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

    private async handleListBenchmarks(): Promise<void> {
        logger.section('Available Benchmarks');
        logger.info('LongMemEval  - Long-term memory evaluation benchmark');
        logger.info('LoCoMo       - Long-term conversational memory benchmark');
        logger.info('NoLiMa       - Long-context memory benchmark');
        logger.subsection('Usage');
        logger.info('memorybench run --benchmark <name> --provider <name> [options]');
    }

    private async handleListProviders(): Promise<void> {
        logger.subsection('Loading providers...');
        logger.startTimer('provider-load');
        await ProviderLoader.loadAll();
        logger.logTimer('provider-load', 'Provider initialization');

        const providers = this.registry.getAvailableProviders();

        logger.section('Available Providers');
        providers.forEach(provider => {
            logger.info(provider);
        });
    }

    private handleHelp(): void {
        logger.section('MemoryBench CLI');
        logger.subsection('Usage');
        logger.info('memorybench <command> [options]');

        logger.subsection('Commands');
        logger.info('run                    Run a benchmark');
        logger.info('list-benchmarks        List available benchmarks');
        logger.info('list-providers         List available providers');
        logger.info('help                   Show this help message');

        logger.subsection('Run Command');
        logger.info('memorybench run --benchmark <name> --provider <name> [options]');

        logger.subsection('Options (for run command)');
        logger.info('--benchmark <name>     Benchmark to run (required)');
        logger.info('--provider <name>      Provider to use (required)');
        logger.info('--limit <n>           Limit number of questions/samples to process');
        logger.info('--skipIngest          Skip ingestion phase');
        logger.info('--skipSearch          Skip search phase');
        logger.info('--skipEvaluate        Skip evaluation phase');
        logger.info('--answeringModel <m>  Model for answering questions');
        logger.info('--judgeModel <m>      Model for judging answers');
        logger.info('--formal              Mark run for visualization dashboard');
        logger.info('--runId <id>          Custom run ID (auto-generated by default)');

        logger.subsection('Examples');
        logger.info('memorybench run --benchmark LongMemEval --provider supermemory');
        logger.info('memorybench run --benchmark LongMemEval --provider mem0 --limit 5');
        logger.info('memorybench run --benchmark LoCoMo --provider supermemory --answeringModel gpt-4o');
        logger.info('memorybench run --benchmark NoLiMa --provider fullcontext --formal');
        logger.info('memorybench list-benchmarks');
        logger.info('memorybench list-providers');
        logger.info('memorybench help');

        logger.subsection('Environment Variables');
        logger.info('SUPERMEMORY_API_KEY    Supermemory API key');
        logger.info('MEM0_API_KEY          Mem0 API key');
        logger.info('ZEP_API_KEY           Zep API key');
        logger.info('OPENAI_API_KEY        OpenAI API key (for evaluation)');

        logger.info('For more information, see BENCHMARK_GUIDE.md');
    }
}
