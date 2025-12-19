import type { BenchmarkRegistry, BenchmarkType } from "./benchmarks";
import { ragBenchmarkData } from "./benchmarks";
import type { TemplateType } from "./providers/_template";
import {
	loadAllProviders,
	formatProviderTable,
	formatProviderJson,
	formatValidationError,
} from "./src/loaders/providers";

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

function validateArgs(args: CLIArgs, validProviders: string[]): void {
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
	for (const provider of args.providers) {
		if (!validProviders.includes(provider)) {
			throw new Error(
				`Invalid provider: ${provider}. Available providers: ${validProviders.join(", ")}`,
			);
		}
	}
}

async function loadProviderRegistry(): Promise<Record<string, TemplateType>> {
	const { AQRAGProvider, ContextualRetrievalProvider } =
		await import("./providers");
	return {
		ContextualRetrieval: ContextualRetrievalProvider,
		AQRAG: AQRAGProvider,
	};
}

async function getProviderNamesForHelp(): Promise<string> {
	try {
		const result = await loadAllProviders();
		const names = Array.from(
			new Set(result.providers.map((provider) => provider.manifest.provider.name)),
		).sort();
		return names.length > 0 ? names.join(", ") : "none";
	} catch {
		return "none";
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

/**
 * Handle the 'list providers' subcommand (T037-T040)
 */
async function handleListProviders(jsonOutput: boolean): Promise<void> {
	const result = await loadAllProviders();

	// Report warnings
	for (const warning of result.warnings) {
		console.error(warning);
	}

	// Report errors
	if (result.errors.length > 0) {
		console.error("\nValidation errors:");
		for (const error of result.errors) {
			console.error(formatValidationError(error));
		}
	}

	// Output providers
	if (jsonOutput) {
		console.log(formatProviderJson(result.providers));
	} else {
		console.log(formatProviderTable(result.providers));
	}
}

async function main(): Promise<void> {
	try {
		const rawArgs = Bun.argv.slice(2);

		// Check for 'list providers' subcommand (T037)
		if (rawArgs[0] === "list" && rawArgs[1] === "providers") {
			const jsonOutput = rawArgs.includes("--json"); // T038
			await handleListProviders(jsonOutput);
			return;
		}

		const args = parseCliArgs();

		// Show help if no arguments
		if (args.benchmarks.length === 0 && args.providers.length === 0) {
			const providerNames = await getProviderNamesForHelp();
			console.log(`
Memory Benchmark CLI

Usage:
  bun run index.ts --benchmarks <benchmark1> [benchmark2...] --providers <provider1> [provider2...]
  bun run index.ts list providers [--json]

Commands:
  list providers      List all configured provider manifests
    --json            Output in JSON format for machine parsing

Options:
  --benchmarks, -b  Benchmark types to run (${Object.keys(BENCHMARK_DATA).join(", ")})
  --providers, -p   Providers to test (${providerNames})

Examples:
  bun run index.ts --benchmarks RAG-template-benchmark --providers ContextualRetrieval AQRAG
  bun run index.ts -b RAG-template-benchmark -p ContextualRetrieval
  bun run index.ts list providers
  bun run index.ts list providers --json
      `);
			return;
		}

		const providerRegistry = await loadProviderRegistry();
		validateArgs(args, Object.keys(providerRegistry));

		console.log("=� Starting memory benchmark tests...");
		console.log(`Benchmarks: ${args.benchmarks.join(", ")}`);
		console.log(`Providers: ${args.providers.join(", ")}`);

		// Run each benchmark with each provider
		for (const benchmarkName of args.benchmarks) {
			const benchmarkType = benchmarkName as BenchmarkType;
			const benchmarkData = BENCHMARK_DATA[benchmarkType];

			for (const providerName of args.providers) {
				const provider = providerRegistry[providerName]!;
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
