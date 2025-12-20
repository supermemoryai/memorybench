/**
 * Provider Contract Types for BaseProvider Interface and Registry
 *
 * This file defines the universal provider contract that all memory provider
 * adapters must implement, along with registry-related types for loading,
 * validation, and error handling.
 *
 * @module types/provider
 * @see specs/005-provider-contract/spec.md
 */

import type { TemplateType } from "../providers/_template";
import type {
	MemoryRecord,
	ProviderCapabilities,
	RetrievalItem,
	ScopeContext,
} from "./core";
import { isScopeContext } from "./core";
import type { ProviderManifest } from "./manifest";

// =============================================================================
// BaseProvider Interface (T001, T002) - Universal Provider Contract
// =============================================================================

/**
 * Universal interface contract that all memory provider adapters must implement.
 *
 * Defines required operations (add_memory, retrieve_memory, delete_memory) and
 * optional operations (update_memory, list_memories, reset_scope, get_capabilities).
 *
 * All methods accept ScopeContext as first parameter for test isolation and
 * multi-tenancy support.
 *
 * @example
 * ```typescript
 * const myProvider: BaseProvider = {
 *   name: "my-provider",
 *
 *   async add_memory(scope, content, metadata) {
 *     const id = crypto.randomUUID();
 *     // Store memory...
 *     return { id, context: content, metadata: metadata ?? {}, timestamp: Date.now() };
 *   },
 *
 *   async retrieve_memory(scope, query, limit = 10) {
 *     // Search memories...
 *     return results;
 *   },
 *
 *   async delete_memory(scope, memory_id) {
 *     // Delete memory...
 *     return true;
 *   }
 * };
 * ```
 */
export interface BaseProvider {
	/** Provider name - must match manifest.provider.name (FR-012) */
	readonly name: string;

	// === Required Operations (FR-001 through FR-004) ===

	/**
	 * Store a new memory.
	 * @param scope - Execution context for test isolation
	 * @param content - The content to remember
	 * @param metadata - Optional key-value metadata
	 * @returns Created memory record with generated ID
	 */
	add_memory(
		scope: ScopeContext,
		content: string,
		metadata?: Record<string, unknown>,
	): Promise<MemoryRecord>;

	/**
	 * Search for memories matching a query.
	 * @param scope - Execution context for test isolation
	 * @param query - Search query string
	 * @param limit - Maximum number of results to return
	 * @returns Matching memories with relevance scores
	 */
	retrieve_memory(
		scope: ScopeContext,
		query: string,
		limit?: number,
	): Promise<RetrievalItem[]>;

	/**
	 * Delete a memory by ID.
	 * @param scope - Execution context for test isolation
	 * @param memory_id - Unique identifier of the memory to delete
	 * @returns true if deleted, false if not found
	 */
	delete_memory(scope: ScopeContext, memory_id: string): Promise<boolean>;

	// === Optional Operations (FR-005 through FR-009) ===

	/**
	 * Update an existing memory.
	 * Only available if manifest declares update_memory: true
	 * @param scope - Execution context for test isolation
	 * @param memory_id - Unique identifier of the memory to update
	 * @param content - New content
	 * @param metadata - Updated metadata
	 * @returns Updated memory record
	 */
	update_memory?(
		scope: ScopeContext,
		memory_id: string,
		content: string,
		metadata?: Record<string, unknown>,
	): Promise<MemoryRecord>;

	/**
	 * List all memories in a scope.
	 * Only available if manifest declares list_memories: true
	 * @param scope - Execution context for test isolation
	 * @param limit - Maximum number of results to return
	 * @param offset - Number of results to skip (for pagination)
	 * @returns Array of memory records
	 */
	list_memories?(
		scope: ScopeContext,
		limit?: number,
		offset?: number,
	): Promise<MemoryRecord[]>;

	/**
	 * Clear all memories in a scope.
	 * Only available if manifest declares reset_scope: true
	 * @param scope - Execution context for test isolation
	 * @returns true if scope was cleared
	 */
	reset_scope?(scope: ScopeContext): Promise<boolean>;

	/**
	 * Get provider capabilities.
	 * Should match manifest declarations.
	 * @returns Capability data matching manifest
	 */
	get_capabilities?(): Promise<ProviderCapabilities>;
}

// =============================================================================
// Registry Types (T003, T004, T005) - Provider Loading and Errors
// =============================================================================

/**
 * Represents a fully loaded and validated provider ready for use.
 * Contains the adapter, its manifest, and filesystem metadata.
 * (FR-018, T003)
 */
export interface LoadedProviderEntry {
	/** The provider adapter implementing BaseProvider */
	adapter: BaseProvider;

	/** Validated manifest from manifest.json */
	manifest: ProviderManifest;

	/** Absolute path to the provider directory */
	path: string;
}

/**
 * Warning issued during provider loading (non-blocking).
 * Used for load-partial behavior where valid providers load
 * despite other providers failing validation.
 * (FR-021, T004)
 */
export interface ProviderLoadWarning {
	/** Provider path or name */
	provider: string;

	/** Warning code for categorization */
	code: "MISSING_MANIFEST" | "MISSING_ADAPTER" | "CAPABILITY_MISMATCH";

	/** Human-readable warning message */
	message: string;
}

/**
 * Error preventing provider from loading.
 * Contains actionable error information per FR-015.
 * (T004)
 */
export interface ProviderLoadError {
	/** Provider path or name */
	provider: string;

	/** Error code for categorization */
	code:
		| "INVALID_MANIFEST"
		| "NAME_MISMATCH"
		| "MISSING_REQUIRED_METHOD"
		| "MISSING_DECLARED_METHOD"
		| "IMPORT_FAILED"
		| "INITIALIZATION_FAILED";

	/** Human-readable error message with remediation steps */
	message: string;

	/** Original error if applicable */
	cause?: Error;
}

/**
 * Result of provider discovery and loading.
 * Used by ProviderRegistry to track load-partial behavior.
 * (FR-021, T005)
 */
export interface ProviderRegistryResult {
	/** Successfully loaded providers */
	providers: LoadedProviderEntry[];

	/** Non-fatal warnings (missing manifests, capability mismatches) */
	warnings: ProviderLoadWarning[];

	/** Fatal errors (validation failures, missing methods) */
	errors: ProviderLoadError[];
}

// =============================================================================
// Error Classes (T006) - Unsupported Operations
// =============================================================================

/**
 * Thrown when calling an optional operation the provider doesn't support.
 * Provides clear context about which provider and operation failed.
 * (FR-005, T006)
 *
 * @example
 * ```typescript
 * if (!provider.update_memory) {
 *   throw new UnsupportedOperationError(provider.name, "update_memory");
 * }
 * ```
 */
export class UnsupportedOperationError extends Error {
	override readonly name = "UnsupportedOperationError";

	constructor(
		/** Provider that doesn't support the operation */
		readonly providerName: string,
		/** Operation that was attempted */
		readonly operation: string,
	) {
		super(
			`Provider '${providerName}' does not support operation: ${operation}`,
		);

		// Maintain proper stack trace in V8 engines
		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, UnsupportedOperationError);
		}
	}
}

// =============================================================================
// Type Guards (T007, T007b) - Runtime type validation
// =============================================================================

/**
 * Type guard to check if an object implements the BaseProvider interface.
 * Uses structural typing - checks for presence of required methods.
 * (T007, research R2)
 *
 * @param obj - Unknown object to check
 * @returns true if obj has all required BaseProvider methods
 *
 * @example
 * ```typescript
 * const maybeProvider = await import('./providers/foo/index.ts').default;
 * if (isBaseProvider(maybeProvider)) {
 *   // TypeScript now knows maybeProvider is BaseProvider
 *   await maybeProvider.add_memory(scope, content);
 * }
 * ```
 */
export function isBaseProvider(obj: unknown): obj is BaseProvider {
	return (
		typeof obj === "object" &&
		obj !== null &&
		"name" in obj &&
		typeof (obj as any).name === "string" &&
		"add_memory" in obj &&
		typeof (obj as any).add_memory === "function" &&
		"retrieve_memory" in obj &&
		typeof (obj as any).retrieve_memory === "function" &&
		"delete_memory" in obj &&
		typeof (obj as any).delete_memory === "function"
	);
}

/**
 * Type guard to check if an object implements the legacy TemplateType interface.
 * Detects old providers using addContext/searchQuery naming.
 * (T007, research R2, FR-019)
 *
 * @param obj - Unknown object to check
 * @returns true if obj has legacy TemplateType methods
 *
 * @example
 * ```typescript
 * const legacyProvider = await import('./providers/old/index.ts').default;
 * if (isLegacyTemplate(legacyProvider)) {
 *   // Wrap with LegacyProviderAdapter
 *   const adapter = new LegacyProviderAdapter(legacyProvider, legacyProvider.name);
 * }
 * ```
 */
export function isLegacyTemplate(obj: unknown): obj is TemplateType {
	return (
		typeof obj === "object" &&
		obj !== null &&
		"name" in obj &&
		typeof (obj as any).name === "string" &&
		"addContext" in obj &&
		typeof (obj as any).addContext === "function" &&
		"searchQuery" in obj &&
		typeof (obj as any).searchQuery === "function" &&
		"prepareProvider" in obj &&
		typeof (obj as any).prepareProvider === "function"
	);
}

/**
 * Validates that a ScopeContext has all required fields.
 * Uses the existing isScopeContext type guard from types/core.ts.
 * (T007b, FR-020 compliance)
 *
 * @param scope - Object to validate
 * @returns The validated ScopeContext
 * @throws Error if validation fails with details about missing/invalid fields
 *
 * @example
 * ```typescript
 * import { validateScopeContext } from './types/provider';
 *
 * async function add_memory(scope: unknown, content: string) {
 *   const validScope = validateScopeContext(scope);
 *   // validScope is now guaranteed to have user_id and run_id
 * }
 * ```
 */
export function validateScopeContext(scope: unknown): ScopeContext {
	// Provide detailed error message for debugging
	const issues: string[] = [];

	if (typeof scope !== "object" || scope === null) {
		throw new Error(
			"Invalid ScopeContext: expected object, got " + typeof scope,
		);
	}

	const obj = scope as any;

	// Validate required fields
	if (!("user_id" in obj) || typeof obj.user_id !== "string") {
		issues.push("missing or invalid user_id (expected string)");
	}
	if (!("run_id" in obj) || typeof obj.run_id !== "string") {
		issues.push("missing or invalid run_id (expected string)");
	}

	// Validate optional fields - they must be string if present
	if (
		"session_id" in obj &&
		obj.session_id !== undefined &&
		typeof obj.session_id !== "string"
	) {
		issues.push("invalid session_id (expected string or undefined)");
	}
	if (
		"namespace" in obj &&
		obj.namespace !== undefined &&
		typeof obj.namespace !== "string"
	) {
		issues.push("invalid namespace (expected string or undefined)");
	}

	if (issues.length > 0) {
		throw new Error(
			`Invalid ScopeContext: ${issues.join(", ")}. Expected { user_id: string, run_id: string, session_id?: string, namespace?: string }`,
		);
	}

	return scope as ScopeContext;
}

// =============================================================================
// Legacy Adapter (Phase 2 placeholder) - Will be implemented in T008
// =============================================================================

/**
 * Wraps legacy TemplateType providers with BaseProvider interface.
 * Enables backward compatibility without modifying existing providers.
 * (FR-019, T008 - skeleton, full implementation in Phase 3)
 */
export class LegacyProviderAdapter implements BaseProvider {
	readonly name: string;

	constructor(
		private readonly legacy: TemplateType,
		name: string,
	) {
		this.name = name;
	}

	/**
	 * Maps add_memory to legacy addContext.
	 * Generates a UUID for the memory ID and creates a MemoryRecord.
	 * (T014, FR-019)
	 */
	async add_memory(
		scope: ScopeContext,
		content: string,
		metadata?: Record<string, unknown>,
	): Promise<MemoryRecord> {
		// Generate UUID for memory ID
		const id = crypto.randomUUID();

		// Create PreparedData for legacy provider
		const preparedData = {
			context: content,
			metadata: {
				...metadata,
				// Include scope information for potential legacy provider use
				_scope: {
					user_id: scope.user_id,
					run_id: scope.run_id,
					session_id: scope.session_id,
					namespace: scope.namespace,
				},
				// Store generated ID for potential retrieval
				_generated_id: id,
			},
		};

		// Call legacy addContext
		await this.legacy.addContext(preparedData);

		// Return MemoryRecord
		return {
			id,
			context: content,
			metadata: metadata ?? {},
			timestamp: Date.now(),
		};
	}

	/**
	 * Maps retrieve_memory to legacy searchQuery.
	 * Wraps search results in RetrievalItem format.
	 * (T015, FR-019)
	 */
	async retrieve_memory(
		_scope: ScopeContext,
		query: string,
		limit?: number,
	): Promise<RetrievalItem[]> {
		// Call legacy searchQuery
		const legacyResults = await this.legacy.searchQuery(query);

		// Wrap results in RetrievalItem format
		const items: RetrievalItem[] = legacyResults.map((result) => ({
			record: {
				id: result.id,
				context: result.context,
				metadata: {},
				timestamp: Date.now(), // Legacy providers don't track timestamps
			},
			score: result.score,
		}));

		// Apply limit if specified (handle limit=0 correctly)
		return limit !== undefined ? items.slice(0, limit) : items;
	}

	/**
	 * Legacy providers don't support delete operations.
	 * Throws UnsupportedOperationError per FR-019.
	 * (T016)
	 */
	async delete_memory(
		_scope: ScopeContext,
		_memory_id: string,
	): Promise<boolean> {
		throw new UnsupportedOperationError(this.name, "delete_memory");
	}
}

/**
 * Check if a provider has a specific capability.
 * (T045, FR-014, research R6)
 *
 * @param provider - BaseProvider instance to check
 * @param operation - Operation name to check for
 * @returns true if the provider has the operation method, false otherwise
 */
export function hasCapability(
	provider: BaseProvider,
	operation: keyof BaseProvider,
): boolean {
	return typeof provider[operation] === "function";
}
