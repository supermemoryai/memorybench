/**
 * Provider Manifest Loader
 *
 * Discovers, loads, validates, and manages provider manifests.
 * Implements FR-006 through FR-015 from the specification.
 *
 * @module src/loaders/providers
 * @see specs/004-provider-manifest/spec.md
 */

import { Glob } from "bun";
import path from "node:path";
import {
	ProviderManifestV1Schema,
	SUPPORTED_MANIFEST_VERSIONS,
	isSupportedVersion,
	type ProviderManifest,
	type LoadedProvider,
	type ManifestValidationError,
	type FieldError,
} from "../../types/manifest";
import type { z } from "zod";

// =============================================================================
// Types
// =============================================================================

/** Result of manifest validation */
export type ValidationResult =
	| { success: true; data: ProviderManifest }
	| { success: false; error: ManifestValidationError };

/** Result of loading all providers */
export interface LoadProvidersResult {
	providers: LoadedProvider[];
	errors: ManifestValidationError[];
	warnings: string[];
}

// =============================================================================
// Discovery (T024)
// =============================================================================

/**
 * Discover all manifest.json files in the providers directory.
 * Uses Bun.Glob for efficient file discovery.
 *
 * @param baseDir - Base directory to search (defaults to project root)
 * @returns Array of absolute paths to manifest.json files
 */
export async function discoverManifests(
	baseDir: string = process.cwd(),
): Promise<string[]> {
	const glob = new Glob("providers/**/manifest.json");
	const paths: string[] = [];

	for await (const file of glob.scan({ cwd: baseDir, absolute: true })) {
		paths.push(file);
	}

	return paths;
}

// =============================================================================
// Loading (T025)
// =============================================================================

/**
 * Load and parse a manifest JSON file.
 *
 * @param manifestPath - Absolute path to manifest.json
 * @returns Parsed JSON object
 * @throws Error with file path and parse location on invalid JSON (FR-014)
 */
export async function loadManifest(manifestPath: string): Promise<unknown> {
	try {
		const file = Bun.file(manifestPath);
		const text = await file.text();
		return JSON.parse(text);
	} catch (error) {
		if (error instanceof SyntaxError) {
			// Extract line/column info from JSON parse error if available
			const match = error.message.match(/position (\d+)/);
			const position = match ? ` at position ${match[1]}` : "";
			throw new Error(
				`Invalid JSON syntax in ${manifestPath}${position}: ${error.message}`,
			);
		}
		throw error;
	}
}

// =============================================================================
// Validation (T026)
// =============================================================================

/**
 * Validate a parsed manifest against the schema.
 *
 * @param json - Parsed JSON object
 * @param manifestPath - Path for error reporting
 * @returns Validation result with typed manifest or structured errors
 */
export function validateManifest(
	json: unknown,
	manifestPath: string,
): ValidationResult {
	// First check manifest_version before full validation (FR-013)
	if (
		typeof json === "object" &&
		json !== null &&
		"manifest_version" in json
	) {
		const version = (json as Record<string, unknown>).manifest_version;
		if (typeof version === "string" && !isSupportedVersion(version)) {
			return {
				success: false,
				error: {
					path: manifestPath,
					errors: [
						{
							field: "manifest_version",
							rule: "unsupported_version",
							expected: `Supported versions: ${SUPPORTED_MANIFEST_VERSIONS.join(", ")}`,
							received: version,
						},
					],
				},
			};
		}
	}

	const result = ProviderManifestV1Schema.safeParse(json);

	if (result.success) {
		return { success: true, data: result.data };
	}

	// Convert Zod errors to our FieldError format (FR-009)
	const fieldErrors: FieldError[] = result.error.issues.map((issue) => ({
		field: issue.path.join("."),
		rule: issue.code,
		expected: getExpectedValue(issue),
		received: getReceivedValue(issue),
	}));

	return {
		success: false,
		error: {
			path: manifestPath,
			errors: fieldErrors,
		},
	};
}

/**
 * Extract expected value description from Zod issue.
 */
function getExpectedValue(issue: z.ZodIssue): string {
	switch (issue.code) {
		case "invalid_type":
			return `Expected ${issue.expected}`;
		case "invalid_enum_value":
			return `Expected one of: ${(issue.options as string[]).join(", ")}`;
		case "invalid_literal":
			return `Expected ${JSON.stringify(issue.expected)}`;
		case "too_small":
			return `Minimum ${issue.type === "string" ? "length" : "value"}: ${issue.minimum}`;
		case "too_big":
			return `Maximum ${issue.type === "string" ? "length" : "value"}: ${issue.maximum}`;
		default:
			return issue.message;
	}
}

/**
 * Extract received value description from Zod issue.
 */
function getReceivedValue(issue: z.ZodIssue): string {
	switch (issue.code) {
		case "invalid_type":
			return `Received ${issue.received}`;
		case "invalid_enum_value":
			return `Received "${issue.received}"`;
		default:
			return "invalid";
	}
}

// =============================================================================
// Error Formatting (T027)
// =============================================================================

/**
 * Format a validation error into a human-readable, actionable message.
 * Implements FR-009: includes field name, validation rule, expected format.
 *
 * @param error - Structured validation error
 * @returns Formatted error message
 */
export function formatValidationError(error: ManifestValidationError): string {
	const lines = [`Manifest validation failed: ${error.path}`];

	for (const fieldError of error.errors) {
		lines.push(
			`  - ${fieldError.field}: ${fieldError.expected}. ${fieldError.received}.`,
		);
	}

	return lines.join("\n");
}

// =============================================================================
// Hashing (T028)
// =============================================================================

/**
 * Compute SHA-256 hash of manifest content.
 * Uses canonical JSON (sorted keys) for stable hashing.
 *
 * @param manifest - Validated manifest
 * @returns Hex-encoded SHA-256 hash
 */
export function hashManifest(manifest: ProviderManifest): string {
	// Canonical JSON: sorted keys for deterministic hashing
	const canonical = JSON.stringify(manifest, Object.keys(manifest).sort());
	const hash = new Bun.CryptoHasher("sha256");
	hash.update(canonical);
	return hash.digest("hex");
}

// =============================================================================
// Orchestration (T029, T030)
// =============================================================================

/** Warning threshold for convergence_wait_ms (FR-015) */
const CONVERGENCE_WARNING_THRESHOLD_MS = 10000;

/**
 * Load all provider manifests from the providers directory.
 * Implements discovery, loading, validation, and deduplication.
 *
 * @param baseDir - Base directory (defaults to process.cwd())
 * @returns Loaded providers, errors, and warnings
 */
export async function loadAllProviders(
	baseDir: string = process.cwd(),
): Promise<LoadProvidersResult> {
	const providers: LoadedProvider[] = [];
	const errors: ManifestValidationError[] = [];
	const warnings: string[] = [];
	const seenKeys = new Map<string, string>(); // key -> path

	// Discover all manifests
	const manifestPaths = await discoverManifests(baseDir);

	// Load and validate each manifest
	for (const manifestPath of manifestPaths) {
		try {
			const json = await loadManifest(manifestPath);
			const result = validateManifest(json, manifestPath);

			if (!result.success) {
				errors.push(result.error);
				continue;
			}

			const manifest = result.data;

			// Check for duplicate name+version (FR-012)
			const key = `${manifest.provider.name}@${manifest.provider.version}`;
			const existingPath = seenKeys.get(key);

			if (existingPath) {
				errors.push({
					path: manifestPath,
					errors: [
						{
							field: "provider",
							rule: "duplicate_provider",
							expected: `Unique name+version combination`,
							received: `Provider "${key}" already registered from ${existingPath}`,
						},
					],
				});
				continue;
			}

			seenKeys.set(key, manifestPath);

			// Warn on large convergence_wait_ms (FR-015)
			const convergenceMs =
				manifest.conformance_tests.expected_behavior.convergence_wait_ms;
			if (convergenceMs > CONVERGENCE_WARNING_THRESHOLD_MS) {
				warnings.push(
					`Warning: ${manifestPath} has convergence_wait_ms=${convergenceMs}ms (>10000ms). This may indicate misconfiguration.`,
				);
			}

			// Create loaded provider
			providers.push({
				manifest,
				path: manifestPath,
				hash: hashManifest(manifest),
			});
		} catch (error) {
			// JSON parse errors or file read errors
			errors.push({
				path: manifestPath,
				errors: [
					{
						field: "_file",
						rule: "parse_error",
						expected: "Valid JSON file",
						received:
							error instanceof Error ? error.message : String(error),
					},
				],
			});
		}
	}

	return { providers, errors, warnings };
}

// =============================================================================
// CLI Formatting (T035, T036)
// =============================================================================

/**
 * Format providers as a human-readable table.
 * Shows name, type, version, and core operations.
 *
 * @param providers - Loaded provider list
 * @returns Formatted table string
 */
export function formatProviderTable(providers: LoadedProvider[]): string {
	if (providers.length === 0) {
		return "No providers configured.\n\nTo add a provider, create providers/<name>/manifest.json";
	}

	// Column widths
	const nameWidth = Math.max(
		4,
		...providers.map((p) => p.manifest.provider.name.length),
	);
	const typeWidth = Math.max(
		4,
		...providers.map((p) => p.manifest.provider.type.length),
	);
	const versionWidth = Math.max(
		7,
		...providers.map((p) => p.manifest.provider.version.length),
	);

	// Header
	const header = [
		"Name".padEnd(nameWidth),
		"Type".padEnd(typeWidth),
		"Version".padEnd(versionWidth),
		"Core Ops",
	].join("  ");

	const separator = "-".repeat(header.length);

	// Rows
	const rows = providers.map((p) => {
		const ops = p.manifest.capabilities.core_operations;
		const coreOps = [
			ops.add_memory ? "add" : "",
			ops.retrieve_memory ? "retrieve" : "",
			ops.delete_memory ? "delete" : "",
		]
			.filter(Boolean)
			.join(",");

		return [
			p.manifest.provider.name.padEnd(nameWidth),
			p.manifest.provider.type.padEnd(typeWidth),
			p.manifest.provider.version.padEnd(versionWidth),
			coreOps,
		].join("  ");
	});

	return [header, separator, ...rows].join("\n");
}

/**
 * Format providers as machine-parseable JSON.
 *
 * @param providers - Loaded provider list
 * @returns JSON string
 */
export function formatProviderJson(providers: LoadedProvider[]): string {
	const output = {
		providers: providers.map((p) => ({
			name: p.manifest.provider.name,
			type: p.manifest.provider.type,
			version: p.manifest.provider.version,
			capabilities: p.manifest.capabilities,
			semantic_properties: p.manifest.semantic_properties,
			conformance_tests: p.manifest.conformance_tests,
			manifest_hash: p.hash,
		})),
	};

	return JSON.stringify(output, null, 2);
}

// =============================================================================
// Semantic Property Accessors (T045, T046, T047, T048)
// =============================================================================

/**
 * Get the update strategy from a manifest.
 *
 * @param manifest - Validated provider manifest
 * @returns Update strategy enum value
 */
export function getUpdateStrategy(
	manifest: ProviderManifest,
): ProviderManifest["semantic_properties"]["update_strategy"] {
	return manifest.semantic_properties.update_strategy;
}

/**
 * Get the delete strategy from a manifest.
 *
 * @param manifest - Validated provider manifest
 * @returns Delete strategy enum value
 */
export function getDeleteStrategy(
	manifest: ProviderManifest,
): ProviderManifest["semantic_properties"]["delete_strategy"] {
	return manifest.semantic_properties.delete_strategy;
}

/**
 * Get the convergence wait time from a manifest.
 * Used by conformance tests to determine how long to wait after writes.
 *
 * @param manifest - Validated provider manifest
 * @returns Convergence wait time in milliseconds
 */
export function getConvergenceWaitMs(manifest: ProviderManifest): number {
	return manifest.conformance_tests.expected_behavior.convergence_wait_ms;
}

// =============================================================================
// Exports (T031)
// =============================================================================

// All exports are at module level above
