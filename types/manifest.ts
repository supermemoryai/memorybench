/**
 * Provider Manifest Schema Definitions
 *
 * This file defines the Zod schemas and TypeScript types for provider manifests.
 * Manifests declare what a provider supports (capabilities, semantic properties)
 * without implementing how it works.
 *
 * @module types/manifest
 * @see specs/004-provider-manifest/spec.md
 */

import { z } from "zod";
import type {
	CoreOperations,
	IntelligenceFlags,
	OptionalOperations,
	SystemFlags,
} from "./core";

// =============================================================================
// Constants (T005)
// =============================================================================

/** Supported manifest schema versions */
export const SUPPORTED_MANIFEST_VERSIONS = ["1"] as const;

// =============================================================================
// Enum Schemas (T006, T007, T008)
// =============================================================================

/** Provider architecture categories (T006) */
export const ProviderTypeSchema = z.enum([
	"intelligent_memory",
	"hybrid",
	"framework",
]);
export type ProviderType = z.infer<typeof ProviderTypeSchema>;

/** Update operation semantics (T007) */
export const UpdateStrategySchema = z.enum([
	"immediate",
	"eventual",
	"versioned",
	"immutable",
]);
export type UpdateStrategy = z.infer<typeof UpdateStrategySchema>;

/** Delete operation semantics (T008) */
export const DeleteStrategySchema = z.enum([
	"immediate",
	"eventual",
	"soft_delete",
]);
export type DeleteStrategy = z.infer<typeof DeleteStrategySchema>;

// =============================================================================
// Sub-Schemas (T009, T010, T011)
// =============================================================================

/** Provider identification metadata (T009) */
export const ProviderMetadataSchema = z.object({
	name: z.string().min(1, "Provider name is required"),
	type: ProviderTypeSchema,
	version: z.string().min(1, "Provider version is required"),
});
export type ProviderMetadata = z.infer<typeof ProviderMetadataSchema>;

/** Core operations schema (aligned with types/core.ts) */
export const CoreOperationsSchema = z.object({
	add_memory: z.boolean(),
	retrieve_memory: z.boolean(),
	delete_memory: z.boolean(),
});

/** Optional operations schema (aligned with types/core.ts) */
export const OptionalOperationsSchema = z
	.object({
		update_memory: z.boolean().optional(),
		list_memories: z.boolean().optional(),
		reset_scope: z.boolean().optional(),
		get_capabilities: z.boolean().optional(),
	})
	.passthrough();

/** System flags schema (aligned with types/core.ts) */
export const SystemFlagsSchema = z
	.object({
		async_indexing: z.boolean(),
		processing_latency: z.number().int().nonnegative().optional(),
		convergence_wait_ms: z.number().int().nonnegative().optional(),
	})
	.passthrough();

/** Intelligence flags schema (aligned with types/core.ts) */
export const IntelligenceFlagsSchema = z
	.object({
		auto_extraction: z.boolean(),
		graph_support: z.boolean(),
		graph_type: z.string().optional(),
	})
	.passthrough();

/** Provider capabilities structure */
export const ProviderCapabilitiesSchema = z
	.object({
		core_operations: CoreOperationsSchema,
		optional_operations: OptionalOperationsSchema,
		system_flags: SystemFlagsSchema,
		intelligence_flags: IntelligenceFlagsSchema,
	})
	.passthrough();

/** Semantic properties for update/delete behavior (T010) */
export const SemanticPropertiesSchema = z.object({
	update_strategy: UpdateStrategySchema,
	delete_strategy: DeleteStrategySchema,
});
export type SemanticProperties = z.infer<typeof SemanticPropertiesSchema>;

/** Expected behavior configuration for conformance tests */
export const ExpectedBehaviorSchema = z.object({
	convergence_wait_ms: z.number().int().nonnegative(),
});

/** Conformance test configuration (T011) */
export const ConformanceTestConfigSchema = z.object({
	expected_behavior: ExpectedBehaviorSchema,
});
export type ConformanceTestConfig = z.infer<typeof ConformanceTestConfigSchema>;

// =============================================================================
// Main Manifest Schema (T012)
// =============================================================================

/**
 * Provider Manifest v1 Schema
 *
 * Uses .passthrough() for forward compatibility (FR-011).
 * Unknown fields are preserved, not rejected.
 */
export const ProviderManifestV1Schema = z
	.object({
		manifest_version: z.literal("1"),
		provider: ProviderMetadataSchema,
		capabilities: ProviderCapabilitiesSchema,
		semantic_properties: SemanticPropertiesSchema,
		conformance_tests: ConformanceTestConfigSchema,
	})
	.passthrough();

// =============================================================================
// Type Exports (T013)
// =============================================================================

/** Inferred TypeScript type from the Zod schema */
export type ProviderManifest = z.infer<typeof ProviderManifestV1Schema>;

// =============================================================================
// Loader Output Types (T014, T015)
// =============================================================================

/**
 * Result of loading and validating a manifest (T014)
 */
export interface LoadedProvider {
	/** Validated manifest data */
	manifest: ProviderManifest;
	/** Absolute path to the manifest.json file */
	path: string;
	/** SHA-256 hash of the canonical manifest JSON */
	hash: string;
}

/**
 * Represents a single field-level validation error (T015)
 */
export interface FieldError {
	/** JSON path to the field (e.g., "provider.version") */
	field: string;
	/** The validation rule that failed */
	rule: string;
	/** Expected format or value */
	expected: string;
	/** Actual value received (stringified) */
	received: string;
}

/**
 * Structured validation error for manifest failures (T015)
 */
export interface ManifestValidationError {
	/** Path to the invalid manifest file */
	path: string;
	/** List of field-level errors */
	errors: FieldError[];
}

// =============================================================================
// Validation Helpers
// =============================================================================

/**
 * Check if a manifest version is supported
 */
export function isSupportedVersion(
	version: string,
): version is (typeof SUPPORTED_MANIFEST_VERSIONS)[number] {
	return SUPPORTED_MANIFEST_VERSIONS.includes(
		version as (typeof SUPPORTED_MANIFEST_VERSIONS)[number],
	);
}
