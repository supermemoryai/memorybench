/**
 * Benchmark Registry and Discovery System
 *
 * Auto-discovers benchmarks from benchmark directories and provides
 * registry singleton for accessing loaded benchmarks.
 *
 * @module src/loaders/benchmarks
 * @see specs/006-benchmark-interface/spec.md
 */

import path from "node:path";
import { Glob } from "bun";
import type {
	Benchmark,
	BenchmarkErrorCode,
	BenchmarkLoadError,
	BenchmarkLoadWarning,
	BenchmarkRegistryResult,
	BenchmarkWarningCode,
	LoadedBenchmarkEntry,
} from "../../types/benchmark";
import { isBenchmark } from "../../types/benchmark";
import type { ProviderCapabilities } from "../../types/core";

// =============================================================================
// Structured Logging
// =============================================================================

type LogLevel = "info" | "warn" | "error";

interface LogEntry {
	level: LogLevel;
	timestamp: string;
	event: string;
	details?: Record<string, unknown>;
}

function createLogEntry(
	level: LogLevel,
	event: string,
	details?: Record<string, unknown>,
): LogEntry {
	return {
		level,
		timestamp: new Date().toISOString(),
		event,
		details,
	};
}

function log(entry: LogEntry): void {
	console.log(JSON.stringify(entry));
}

// =============================================================================
// Discovery Functions
// =============================================================================

/**
 * Discover all benchmark directories containing index.ts files.
 * Excludes node_modules/, tests/, and fixtures/ directories.
 *
 * @param baseDir - Base directory to search (defaults to cwd/benchmarks)
 * @returns Array of absolute paths to benchmark index.ts files
 */
export async function discoverBenchmarks(
	baseDir: string = path.join(process.cwd(), "benchmarks"),
): Promise<string[]> {
	const glob = new Glob("**/index.ts");
	const benchmarkPaths: string[] = [];

	for await (const file of glob.scan({ cwd: baseDir })) {
		// Exclude node_modules, tests, and fixtures directories
		if (
			file.includes("node_modules/") ||
			file.includes("/tests/") ||
			file.includes("/fixtures/")
		) {
			continue;
		}

		benchmarkPaths.push(path.join(baseDir, file));
	}

	log(
		createLogEntry("info", "benchmark_discovery_complete", {
			count: benchmarkPaths.length,
			paths: benchmarkPaths,
		}),
	);

	return benchmarkPaths;
}

/**
 * Load and validate a single benchmark from a file path.
 *
 * @param filePath - Absolute path to benchmark index.ts
 * @returns LoadedBenchmarkEntry or throws error
 */
export async function loadBenchmark(
	filePath: string,
): Promise<LoadedBenchmarkEntry> {
	try {
		const module = await import(filePath);

		if (!module.default) {
			throw {
				code: "INVALID_INTERFACE",
				message: `Benchmark at ${filePath} must export a default object`,
			};
		}

		if (!isBenchmark(module.default)) {
			throw {
				code: "INVALID_INTERFACE",
				message: `Benchmark at ${filePath} does not implement Benchmark interface`,
			};
		}

		const benchmark = module.default as Benchmark;
		const benchmarkPath = path.dirname(filePath);

		log(
			createLogEntry("info", "benchmark_loaded", {
				name: benchmark.meta.name,
				version: benchmark.meta.version,
				path: benchmarkPath,
			}),
		);

		return {
			benchmark,
			path: benchmarkPath,
		};
	} catch (error) {
		// Re-throw with structured error
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			"message" in error
		) {
			throw error;
		}

		throw {
			code: "IMPORT_FAILED",
			message: `Failed to import benchmark from ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
			cause: error instanceof Error ? error : undefined,
		};
	}
}

// =============================================================================
// BenchmarkRegistry Singleton
// =============================================================================

/**
 * Singleton registry for all loaded benchmarks.
 * Provides discovery, loading, and lookup operations.
 */
export class BenchmarkRegistry {
	private static instance: BenchmarkRegistry | null = null;
	private benchmarks: Map<string, LoadedBenchmarkEntry> = new Map();
	private warnings: BenchmarkLoadWarning[] = [];
	private errors: BenchmarkLoadError[] = [];
	private initialized = false;

	private constructor() {}

	/**
	 * Get the singleton instance of BenchmarkRegistry.
	 */
	static getInstance(): BenchmarkRegistry {
		if (!BenchmarkRegistry.instance) {
			BenchmarkRegistry.instance = new BenchmarkRegistry();
		}
		return BenchmarkRegistry.instance;
	}

	/**
	 * Initialize the registry by discovering and loading all benchmarks.
	 * Uses load-partial behavior: continues loading valid benchmarks even if some fail.
	 *
	 * @param baseDir - Base directory to search (defaults to cwd/benchmarks)
	 * @returns Result containing loaded benchmarks, warnings, and errors
	 */
	async initialize(baseDir?: string): Promise<BenchmarkRegistryResult> {
		if (this.initialized) {
			log(
				createLogEntry("info", "registry_already_initialized", {
					count: this.benchmarks.size,
				}),
			);
			return this.getResult();
		}

		log(createLogEntry("info", "registry_initialization_start", {}));

		const benchmarkPaths = await discoverBenchmarks(baseDir);

		for (const filePath of benchmarkPaths) {
			try {
				const entry = await loadBenchmark(filePath);

				// Check for duplicate names
				if (this.benchmarks.has(entry.benchmark.meta.name)) {
					const existingPath = this.benchmarks.get(
						entry.benchmark.meta.name,
					)?.path;
					this.errors.push({
						benchmark: entry.benchmark.meta.name,
						code: "DUPLICATE_NAME",
						message: `Duplicate benchmark name "${entry.benchmark.meta.name}" found at ${entry.path} and ${existingPath}`,
					});
					log(
						createLogEntry("error", "benchmark_load_failed", {
							name: entry.benchmark.meta.name,
							path: filePath,
							code: "DUPLICATE_NAME",
						}),
					);
					continue;
				}

				this.benchmarks.set(entry.benchmark.meta.name, entry);
			} catch (error) {
				// Load-partial: continue with other benchmarks
				const errorObj =
					typeof error === "object" && error !== null
						? (error as { code?: BenchmarkErrorCode; message?: string })
						: {};
				this.errors.push({
					benchmark: filePath,
					code: errorObj.code || "IMPORT_FAILED",
					message:
						errorObj.message || `Failed to load benchmark: ${String(error)}`,
					cause: error instanceof Error ? error : undefined,
				});

				log(
					createLogEntry("warn", "benchmark_load_failed", {
						path: filePath,
						error: String(error),
					}),
				);
			}
		}

		this.initialized = true;

		log(
			createLogEntry("info", "registry_initialization_complete", {
				loaded: this.benchmarks.size,
				errors: this.errors.length,
				warnings: this.warnings.length,
			}),
		);

		return this.getResult();
	}

	/**
	 * Get a benchmark by name.
	 *
	 * @param name - Benchmark name
	 * @returns LoadedBenchmarkEntry or undefined if not found
	 */
	get(name: string): LoadedBenchmarkEntry | undefined {
		return this.benchmarks.get(name);
	}

	/**
	 * List all loaded benchmarks.
	 *
	 * @returns Array of all LoadedBenchmarkEntry objects
	 */
	list(): LoadedBenchmarkEntry[] {
		return Array.from(this.benchmarks.values());
	}

	/**
	 * Get the current registry result with all loaded benchmarks, warnings, and errors.
	 */
	private getResult(): BenchmarkRegistryResult {
		return {
			benchmarks: this.list(),
			warnings: [...this.warnings],
			errors: [...this.errors],
		};
	}

	/**
	 * Reset the registry (primarily for testing).
	 */
	reset(): void {
		this.benchmarks.clear();
		this.warnings = [];
		this.errors = [];
		this.initialized = false;
	}
}

// =============================================================================
// Capability Validation
// =============================================================================

/**
 * Capability string to ProviderCapabilities property mapping.
 */
const CAPABILITY_MAP: Record<string, string[]> = {
	add_memory: ["core_operations", "add_memory"],
	retrieve_memory: ["core_operations", "retrieve_memory"],
	delete_memory: ["core_operations", "delete_memory"],
	update_memory: ["optional_operations", "update_memory"],
	list_memories: ["optional_operations", "list_memories"],
	reset_scope: ["optional_operations", "reset_scope"],
};

/**
 * Check if a provider has all required capabilities for a benchmark.
 *
 * @param requiredCapabilities - Array of capability strings from benchmark
 * @param providerCapabilities - Provider's ProviderCapabilities object
 * @returns true if provider has all required capabilities
 */
export function checkProviderCompatibility(
	requiredCapabilities: readonly string[],
	providerCapabilities: ProviderCapabilities,
): boolean {
	for (const capability of requiredCapabilities) {
		const mapping = CAPABILITY_MAP[capability];

		if (!mapping) {
			// Unknown capability - cannot verify compatibility
			log(
				createLogEntry("warn", "unknown_capability", {
					capability,
				}),
			);
			return false;
		}

		const [section, operation] = mapping;
		if (!section || !operation) {
			return false;
		}
		const providerSection = providerCapabilities[
			section as keyof ProviderCapabilities
		] as Record<string, boolean> | undefined;

		if (!providerSection || !providerSection[operation]) {
			return false;
		}
	}

	return true;
}

// =============================================================================
// CLI Formatting
// =============================================================================

/**
 * Format benchmarks as a table for CLI display.
 *
 * @param benchmarks - Array of loaded benchmarks
 * @returns Formatted table string
 */
export function formatBenchmarkTable(
	benchmarks: LoadedBenchmarkEntry[],
): string {
	if (benchmarks.length === 0) {
		return "No benchmarks found.";
	}

	const rows: string[] = [];

	// Header
	rows.push("Name            Version  Required Capabilities");
	rows.push("-----------------------------------------------");

	// Data rows
	for (const entry of benchmarks) {
		const name = entry.benchmark.meta.name.padEnd(15);
		const version = entry.benchmark.meta.version.padEnd(8);
		const capabilities = entry.benchmark.meta.required_capabilities.join(", ");
		rows.push(`${name} ${version} ${capabilities}`);
	}

	return rows.join("\n");
}

/**
 * Format benchmarks as JSON for machine-parseable output.
 *
 * @param benchmarks - Array of loaded benchmarks
 * @returns JSON string
 */
export function formatBenchmarkJson(
	benchmarks: LoadedBenchmarkEntry[],
): string {
	const output = benchmarks.map((entry) => ({
		name: entry.benchmark.meta.name,
		version: entry.benchmark.meta.version,
		description: entry.benchmark.meta.description,
		required_capabilities: entry.benchmark.meta.required_capabilities,
		path: entry.path,
	}));

	return JSON.stringify(output, null, 2);
}
