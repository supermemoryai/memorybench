/**
 * Benchmark Manifest Types and Schema
 *
 * Defines the schema for data-driven benchmarks where benchmarks
 * are configured via manifest.json + data files instead of custom code.
 *
 * @module types/benchmark-manifest
 * @see specs/006-benchmark-interface/data-driven-benchmark-design.md
 */

import { z } from "zod";

// =============================================================================
// Ingestion Configuration Schemas
// =============================================================================

/**
 * Simple ingestion configuration schema
 */
export const SimpleIngestionSchema = z.object({
	strategy: z.literal("simple"),
	/** Field in case input containing content to ingest */
	content_field: z.string(),
	/** Whether content field is an array of items */
	is_array: z.boolean().optional().default(false),
	/** Fields to include as metadata */
	metadata_fields: z.array(z.string()).optional(),
});

/**
 * Session-based ingestion configuration schema
 */
export const SessionBasedIngestionSchema = z.object({
	strategy: z.literal("session-based"),
	/** Field containing array of sessions */
	sessions_field: z.string(),
	/** Field containing session IDs */
	session_ids_field: z.string().optional(),
	/** Field containing session dates */
	dates_field: z.string().optional(),
	/** Field containing answer session IDs for selective ingestion */
	answer_session_ids_field: z.string().optional(),
	/** Ingestion mode: lazy (dev), shared (demo), full (production) */
	mode: z.enum(["lazy", "shared", "full"]).optional().default("full"),
	/** Sample size for shared mode */
	shared_sample_size: z.number().optional().default(10),
	/** Content formatter */
	content_formatter: z.enum(["conversation", "raw"]).optional().default("conversation"),
});

/**
 * Add-delete-verify ingestion configuration schema
 */
export const AddDeleteVerifyIngestionSchema = z.object({
	strategy: z.literal("add-delete-verify"),
	/** Field containing content to add */
	add_content_field: z.string(),
	/** Field containing IDs to delete */
	delete_target_field: z.string(),
	/** Field containing verification queries */
	verify_query_field: z.string().optional(),
	/** Delay between phases in ms */
	phase_delay_ms: z.number().optional().default(100),
});

/**
 * Combined ingestion configuration schema
 */
export const IngestionConfigSchema = z.discriminatedUnion("strategy", [
	SimpleIngestionSchema,
	SessionBasedIngestionSchema,
	AddDeleteVerifyIngestionSchema,
]);

// =============================================================================
// Evaluation Configuration Schemas
// =============================================================================

/**
 * Exact match evaluation configuration schema
 */
export const ExactMatchEvaluationSchema = z.object({
	protocol: z.literal("exact-match"),
	/** Case sensitive comparison */
	case_sensitive: z.boolean().optional().default(false),
	/** Normalize whitespace */
	normalize_whitespace: z.boolean().optional().default(true),
});

/**
 * LLM-as-judge evaluation configuration schema
 */
export const LLMJudgeEvaluationSchema = z.object({
	protocol: z.literal("llm-as-judge"),
	/** Model to use for evaluation */
	model: z.string().optional(),
	/** Field containing question type */
	type_field: z.string().optional(),
	/** Inline type instructions */
	type_instructions: z.record(z.string()).optional(),
	/** Path to type instructions JSON file */
	type_instructions_file: z.string().optional(),
});

/**
 * Deletion check evaluation configuration schema
 */
export const DeletionCheckEvaluationSchema = z.object({
	protocol: z.literal("deletion-check"),
	/** Field containing verification queries */
	verification_query_field: z.string(),
	/** Field containing deleted content */
	deleted_content_field: z.string(),
	/** Use fuzzy matching */
	fuzzy_match: z.boolean().optional().default(false),
});

/**
 * Combined evaluation configuration schema
 */
export const EvaluationConfigSchema = z.discriminatedUnion("protocol", [
	ExactMatchEvaluationSchema,
	LLMJudgeEvaluationSchema,
	DeletionCheckEvaluationSchema,
]);

// =============================================================================
// Query Configuration Schema
// =============================================================================

/**
 * Query configuration schema
 */
export const QueryConfigSchema = z.object({
	/** Field containing the question/query */
	question_field: z.string(),
	/** Field containing the expected answer */
	expected_answer_field: z.string(),
	/** Number of memories to retrieve */
	retrieval_limit: z.number().optional().default(10),
});

// =============================================================================
// Main Benchmark Manifest Schema
// =============================================================================

/**
 * Benchmark manifest schema
 */
export const BenchmarkManifestSchema = z.object({
	/** Manifest version (for future compatibility) */
	manifest_version: z.literal("1"),

	/** Benchmark name (unique identifier) */
	name: z.string().min(1),

	/** Semantic version */
	version: z.string().regex(/^\d+\.\d+\.\d+$/),

	/** Human-readable description */
	description: z.string().optional(),

	/** Source reference (paper, repo, etc.) */
	source: z.string().optional(),

	/** Path to data file (relative to manifest) */
	data_file: z.string(),

	/** Ingestion configuration */
	ingestion: IngestionConfigSchema,

	/** Query configuration */
	query: QueryConfigSchema,

	/** Evaluation configuration */
	evaluation: EvaluationConfigSchema,

	/** Metrics to calculate */
	metrics: z.array(z.string()),

	/** Required provider capabilities */
	required_capabilities: z.array(z.string()),
});

// =============================================================================
// TypeScript Types (derived from schemas)
// =============================================================================

export type SimpleIngestionConfig = z.infer<typeof SimpleIngestionSchema>;
export type SessionBasedIngestionConfig = z.infer<typeof SessionBasedIngestionSchema>;
export type AddDeleteVerifyIngestionConfig = z.infer<typeof AddDeleteVerifyIngestionSchema>;
export type IngestionConfig = z.infer<typeof IngestionConfigSchema>;

export type ExactMatchEvaluationConfig = z.infer<typeof ExactMatchEvaluationSchema>;
export type LLMJudgeEvaluationConfig = z.infer<typeof LLMJudgeEvaluationSchema>;
export type DeletionCheckEvaluationConfig = z.infer<typeof DeletionCheckEvaluationSchema>;
export type EvaluationConfig = z.infer<typeof EvaluationConfigSchema>;

export type QueryConfig = z.infer<typeof QueryConfigSchema>;
export type BenchmarkManifest = z.infer<typeof BenchmarkManifestSchema>;

// =============================================================================
// Validation Functions
// =============================================================================

/**
 * Validation result for benchmark manifest
 */
export interface ManifestValidationResult {
	success: boolean;
	data?: BenchmarkManifest;
	errors?: Array<{
		path: string;
		message: string;
	}>;
}

/**
 * Validate a benchmark manifest
 *
 * @param json - The parsed JSON to validate
 * @returns Validation result with typed data or errors
 */
export function validateBenchmarkManifest(
	json: unknown,
): ManifestValidationResult {
	const result = BenchmarkManifestSchema.safeParse(json);

	if (result.success) {
		return { success: true, data: result.data };
	}

	return {
		success: false,
		errors: result.error.issues.map((err) => ({
			path: err.path.join("."),
			message: err.message,
		})),
	};
}

/**
 * Format validation errors for display
 *
 * @param errors - Array of validation errors
 * @returns Formatted error message
 */
export function formatManifestErrors(
	errors: Array<{ path: string; message: string }>,
): string {
	return errors
		.map((err) => `  - ${err.path}: ${err.message}`)
		.join("\n");
}

// =============================================================================
// Supported Manifest Versions
// =============================================================================

/**
 * List of supported manifest versions
 */
export const SUPPORTED_BENCHMARK_MANIFEST_VERSIONS = ["1"] as const;
