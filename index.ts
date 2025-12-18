import type { BenchmarkRegistry, BenchmarkType } from "./benchmarks";
import { ragBenchmarkData } from "./benchmarks";
import { AQRAGProvider, ContextualRetrievalProvider, type TemplateType } from "./providers";

// Provider registry
const PROVIDERS: Record<string, TemplateType> = {
	ContextualRetrieval: ContextualRetrievalProvider,
	AQRAG: AQRAGProvider,
};

// Benchmark data registry
const BENCHMARK_DATA: Record<
	BenchmarkType,
	BenchmarkRegistry[BenchmarkType][]
> = {
	"RAG-template-benchmark": ragBenchmarkData,
};

interface CLIArgs {
	benchmarks: string[];
	providers: string[];
}

function parseCliArgs(): CLIArgs {
	const args = Bun.argv.slice(2);
	const benchmarks: string[] = [];
	const providers: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		if (arg === "--benchmarks" || arg === "-b") {
			i++;
			// Collect all benchmark names until we hit another option or end
			while (i < args.length && args[i] && !args[i]!.startsWith("-")) {
				benchmarks.push(args[i]!);
				i++;
			}
			i--; // Back up one since the for loop will increment
		} else if (arg === "--providers" || arg === "-p") {
			i++;
			// Collect all provider names until we hit another option or end
			while (i < args.length && args[i] && !args[i]!.startsWith("-")) {
				providers.push(args[i]!);
				i++;
			}
			i--; // Back up one since the for loop will increment
		}
	}

	return { benchmarks, providers };
}

function validateArgs(args: CLIArgs): void {
	if (args.benchmarks.length === 0) {
		throw new Error(
			"No benchmarks specified. Use --benchmarks to specify at least one benchmark.",
		);
	}

	if (args.providers.length === 0) {
		throw new Error(
			"No providers specified. Use --providers to specify at least one provider.",
		);
	}

	// Validate benchmark names
	const validBenchmarks = Object.keys(BENCHMARK_DATA);
	for (const benchmark of args.benchmarks) {
		if (!validBenchmarks.includes(benchmark)) {
			throw new Error(
				`Invalid benchmark: ${benchmark}. Available benchmarks: ${validBenchmarks.join(", ")}`,
			);
		}
	}

	// Validate provider names
	const validProviders = Object.keys(PROVIDERS);
	for (const provider of args.providers) {
		if (!validProviders.includes(provider)) {
			throw new Error(
				`Invalid provider: ${provider}. Available providers: ${validProviders.join(", ")}`,
			);
		}
	}
}

async function runBenchmark(
	benchmarkType: BenchmarkType,
	benchmarkData: BenchmarkRegistry[BenchmarkType][],
	providerName: string,
	provider: TemplateType,
): Promise<void> {
	console.log(
		`\n=== Running ${benchmarkType} benchmark with ${providerName} provider ===`,
	);

	try {
		// Prepare data through the provider
		const preparedData = provider.prepareProvider(benchmarkType, benchmarkData);
		console.log(`Prepared ${preparedData.length} items for processing`);

		// Process each item
		for (let i = 0; i < preparedData.length; i++) {
			const item = preparedData[i]!;
			console.log(`\n--- Processing item ${i + 1}/${preparedData.length} ---`);
			console.log(`Context preview: ${item.context.substring(0, 100)}...`);

			// Add context to provider
			await provider.addContext(item);

			// Simulate search (in real implementation, you might want to extract the question from metadata)
			const query =
				item.metadata.query || item.metadata.benchmarkId || "test query";
			const results = await provider.searchQuery(query as string);

			console.log(`Search results: ${results.length} items found`);

			if (item.metadata.expectedAnswer || item.metadata.expectedResponse) {
				const expected =
					item.metadata.expectedAnswer || item.metadata.expectedResponse;
				console.log(
					`Expected: ${typeof expected === "string" ? expected.substring(0, 100) + "..." : expected}`,
				);
			}
		}

		console.log(
			`\n Completed ${benchmarkType} benchmark with ${providerName} provider`,
		);
	} catch (error) {
		console.error(
			`L Error running ${benchmarkType} benchmark with ${providerName} provider:`,
			error,
		);
	}
}

async function main(): Promise<void> {
	try {
		const args = parseCliArgs();

		// Show help if no arguments
		if (args.benchmarks.length === 0 && args.providers.length === 0) {
			console.log(`
Memory Benchmark CLI

Usage:
  bun run index.ts --benchmarks <benchmark1> [benchmark2...] --providers <provider1> [provider2...]

Options:
  --benchmarks, -b  Benchmark types to run (${Object.keys(BENCHMARK_DATA).join(", ")})
  --providers, -p   Providers to test (${Object.keys(PROVIDERS).join(", ")})

Examples:
  bun run index.ts --benchmarks RAG-template-benchmark --providers ContextualRetrieval AQRAG
  bun run index.ts -b RAG-template-benchmark -p ContextualRetrieval
      `);
			return;
		}

		validateArgs(args);

		console.log("=� Starting memory benchmark tests...");
		console.log(`Benchmarks: ${args.benchmarks.join(", ")}`);
		console.log(`Providers: ${args.providers.join(", ")}`);

		// Run each benchmark with each provider
		for (const benchmarkName of args.benchmarks) {
			const benchmarkType = benchmarkName as BenchmarkType;
			const benchmarkData = BENCHMARK_DATA[benchmarkType];

			for (const providerName of args.providers) {
				const provider = PROVIDERS[providerName]!;
				await runBenchmark(
					benchmarkType,
					benchmarkData,
					providerName,
					provider,
				);
			}
		}

		console.log("\n<� All benchmark tests completed!");
	} catch (error) {
		console.error("L Error:", error instanceof Error ? error.message : error);
		process.exit(1);
	}
}

// Run the CLI
main().catch(console.error);
