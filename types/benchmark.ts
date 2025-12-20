/**
 * Benchmark Interface Types
 *
 * This module defines the pluggable benchmark interface for memorybench.
 * Benchmarks are auto-discovered from benchmarks glob pattern and declare
 * required provider capabilities.
 *
 * @module types/benchmark
 * @see specs/006-benchmark-interface/spec.md
 */

import type { ScopeContext } from "./core";
import type { BaseProvider } from "./provider";

// =============================================================================
// BenchmarkMeta - Benchmark metadata declaration
// =============================================================================

/**
 * Metadata describing a benchmark.
 * Declared inline by each benchmark module.
 */
export interface BenchmarkMeta {
	/** Unique identifier (e.g., "RAG-template-benchmark") */
	readonly name: string;

	/** Semantic version (e.g., "1.0.0") */
	readonly version: string;

	/** Human-readable documentation */
	readonly description?: string;

	/** Provider capabilities required to run this benchmark */
	readonly required_capabilities: readonly string[];
}

// =============================================================================
// BenchmarkCase - Single test scenario
// =============================================================================

/**
 * Optional metadata for a benchmark case.
 */
export interface CaseMetadata {
	/** Difficulty level (e.g., "easy", "medium", "hard") */
	difficulty?: string;

	/** Category classification */
	category?: string;

	/** Origin dataset identifier */
	source_dataset?: string;

	/** Additional benchmark-specific metadata */
	[key: string]: unknown;
}

/**
 * A single test scenario within a benchmark.
 */
export interface BenchmarkCase {
	/** Unique identifier within the benchmark */
	readonly id: string;

	/** Human-readable test description */
	readonly description?: string;

	/** Test input data (benchmark-specific shape) */
	readonly input: Record<string, unknown>;

	/** Expected output/answer if applicable */
	readonly expected?: unknown;

	/** Optional metadata (category, difficulty, etc.) */
	readonly metadata?: CaseMetadata;
}

// =============================================================================
// CaseResult - Execution output
// =============================================================================

/**
 * Execution outcome status.
 */
export type CaseStatus = "pass" | "fail" | "skip" | "error";

/**
 * Error information for failed executions.
 */
export interface ErrorInfo {
	/** Error message */
	message: string;

	/** Stack trace if available */
	stack?: string;
}

/**
 * Structured output from executing a single benchmark case.
 */
export interface CaseResult {
	/** References BenchmarkCase.id */
	readonly case_id: string;

	/** Execution outcome */
	readonly status: CaseStatus;

	/** Named metrics (e.g., { precision: 0.85, recall: 0.72 }) */
	readonly scores: Record<string, number>;

	/** Execution time in milliseconds */
	readonly duration_ms: number;

	/** Error details if status is 'error' */
	readonly error?: ErrorInfo;

	/** Optional debug information */
	readonly artifacts?: Record<string, unknown>;
}

// =============================================================================
// Benchmark - Pluggable benchmark contract
// =============================================================================

/**
 * The pluggable benchmark interface.
 * Each benchmark must export a default object implementing this interface.
 *
 * @example
 * ```typescript
 * // benchmarks/my-benchmark/index.ts
 * import type { Benchmark, BenchmarkCase, CaseResult } from "../../types/benchmark";
 *
 * const myBenchmark: Benchmark = {
 *   meta: {
 *     name: "my-benchmark",
 *     version: "1.0.0",
 *     description: "A custom benchmark",
 *     required_capabilities: ["add_memory", "retrieve_memory"]
 *   },
 *
 *   cases() {
 *     return [
 *       { id: "case_1", input: { query: "test" } }
 *     ];
 *   },
 *
 *   async run_case(provider, scope, benchmarkCase) {
 *     const start = performance.now();
 *     // ... execute test logic ...
 *     return {
 *       case_id: benchmarkCase.id,
 *       status: "pass",
 *       scores: { accuracy: 0.95 },
 *       duration_ms: performance.now() - start
 *     };
 *   }
 * };
 *
 * export default myBenchmark;
 * ```
 */
export interface Benchmark {
	/** Benchmark metadata */
	readonly meta: BenchmarkMeta;

	/**
	 * Returns all test cases for this benchmark.
	 * May return an array or generator for lazy evaluation.
	 */
	cases(): Iterable<BenchmarkCase>;

	/**
	 * Execute a single benchmark case.
	 * @param provider - The memory provider to test
	 * @param scope - Execution context for test isolation
	 * @param benchmarkCase - The specific test case to run
	 * @returns Structured result with status, scores, and timing
	 */
	run_case(
		provider: BaseProvider,
		scope: ScopeContext,
		benchmarkCase: BenchmarkCase,
	): Promise<CaseResult>;
}

// =============================================================================
// Registry Types - Loading and management
// =============================================================================

/**
 * A fully loaded benchmark ready for use.
 */
export interface LoadedBenchmarkEntry {
	/** The benchmark implementation */
	benchmark: Benchmark;

	/** Absolute path to benchmark directory */
	path: string;
}

/**
 * Warning codes for benchmark loading.
 */
export type BenchmarkWarningCode = "MISSING_INDEX" | "CAPABILITY_UNKNOWN";

/**
 * Warning issued during benchmark loading (non-blocking).
 */
export interface BenchmarkLoadWarning {
	/** Benchmark path or name */
	benchmark: string;

	/** Warning classification */
	code: BenchmarkWarningCode;

	/** Human-readable message */
	message: string;
}

/**
 * Error codes for benchmark loading failures.
 */
export type BenchmarkErrorCode =
	| "INVALID_INTERFACE"
	| "DUPLICATE_NAME"
	| "IMPORT_FAILED"
	| "MISSING_META"
	| "MISSING_CASES"
	| "MISSING_RUN_CASE";

/**
 * Error preventing benchmark from loading.
 */
export interface BenchmarkLoadError {
	/** Benchmark path or name */
	benchmark: string;

	/** Error classification */
	code: BenchmarkErrorCode;

	/** Human-readable message with remediation */
	message: string;

	/** Original error if applicable */
	cause?: Error;
}

/**
 * Result of benchmark discovery and loading.
 */
export interface BenchmarkRegistryResult {
	/** Successfully loaded benchmarks */
	benchmarks: LoadedBenchmarkEntry[];

	/** Non-fatal warnings */
	warnings: BenchmarkLoadWarning[];

	/** Fatal errors */
	errors: BenchmarkLoadError[];
}

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Type guard to check if an object implements the Benchmark interface.
 *
 * @param obj - Object to check
 * @returns true if obj implements Benchmark interface
 *
 * @example
 * ```typescript
 * const module = await import('./benchmarks/my-benchmark');
 * if (isBenchmark(module.default)) {
 *   console.log(module.default.meta.name);
 * }
 * ```
 */
export function isBenchmark(obj: unknown): obj is Benchmark {
	if (typeof obj !== "object" || obj === null) {
		return false;
	}

	const candidate = obj as Record<string, unknown>;

	// Check for meta property
	if (
		typeof candidate.meta !== "object" ||
		candidate.meta === null ||
		typeof (candidate.meta as Record<string, unknown>).name !== "string" ||
		typeof (candidate.meta as Record<string, unknown>).version !== "string" ||
		!Array.isArray(
			(candidate.meta as Record<string, unknown>).required_capabilities,
		)
	) {
		return false;
	}

	// Check for cases() method
	if (typeof candidate.cases !== "function") {
		return false;
	}

	// Check for run_case() method
	if (typeof candidate.run_case !== "function") {
		return false;
	}

	return true;
}
