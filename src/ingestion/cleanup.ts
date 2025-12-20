/**
 * Cleanup Utilities for Ingestion
 *
 * Provides utilities to clean up ingested data after benchmark tests.
 * Extracted from: benchmarks/LongMemEval/ingestion.ts
 *
 * @module src/ingestion/cleanup
 * @see specs/006-benchmark-interface/data-driven-benchmark-design.md
 */

import type { ScopeContext } from "../../types/core";
import type { BaseProvider } from "../../types/provider";

/**
 * Check if provider supports a specific capability
 */
async function hasCapability(
	provider: BaseProvider,
	capability: "delete_memory" | "reset_scope",
): Promise<boolean> {
	if (!provider.get_capabilities) {
		return false;
	}

	try {
		const capabilities = await provider.get_capabilities();
		if (capability === "delete_memory") {
			return capabilities?.core_operations?.delete_memory ?? false;
		}
		if (capability === "reset_scope") {
			return capabilities?.optional_operations?.reset_scope ?? false;
		}
		return false;
	} catch {
		return false;
	}
}

/**
 * Clean up ingested memories by their IDs
 *
 * Uses reset_scope if available (more efficient), otherwise
 * falls back to deleting individual records.
 *
 * @param provider - The memory provider
 * @param scope - The scope context
 * @param ingestedIds - IDs of records to delete
 * @returns Object with success count and any errors
 *
 * @example
 * ```typescript
 * const result = await cleanupIngested(provider, scope, ["id1", "id2", "id3"]);
 * console.log(`Cleaned up ${result.deletedCount} records`);
 * ```
 */
export async function cleanupIngested(
	provider: BaseProvider,
	scope: ScopeContext,
	ingestedIds: string[],
): Promise<{ deletedCount: number; errors: string[] }> {
	const errors: string[] = [];
	let deletedCount = 0;

	// Try to use reset_scope if available (more efficient)
	if ((await hasCapability(provider, "reset_scope")) && provider.reset_scope) {
		try {
			await provider.reset_scope(scope);
			return { deletedCount: ingestedIds.length, errors: [] };
		} catch (error) {
			errors.push(
				`reset_scope failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			// Fall through to individual deletes
		}
	}

	// Check if provider supports delete
	if (!(await hasCapability(provider, "delete_memory"))) {
		return {
			deletedCount: 0,
			errors: ["Provider does not support delete_memory operation"],
		};
	}

	// Delete individually
	for (const id of ingestedIds) {
		try {
			await provider.delete_memory(scope, id);
			deletedCount++;
		} catch (error) {
			errors.push(
				`Failed to delete ${id}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	return { deletedCount, errors };
}

/**
 * Reset scope if supported by the provider
 *
 * @param provider - The memory provider
 * @param scope - The scope context
 * @returns True if reset was successful, false otherwise
 */
export async function resetScope(
	provider: BaseProvider,
	scope: ScopeContext,
): Promise<boolean> {
	if (!(await hasCapability(provider, "reset_scope")) || !provider.reset_scope) {
		return false;
	}

	try {
		await provider.reset_scope(scope);
		return true;
	} catch {
		return false;
	}
}

/**
 * Check if cleanup is supported by the provider
 *
 * @param provider - The memory provider
 * @returns Object indicating which cleanup methods are available
 */
export async function checkCleanupCapabilities(
	provider: BaseProvider,
): Promise<{
	hasResetScope: boolean;
	hasDeleteMemory: boolean;
}> {
	return {
		hasResetScope: await hasCapability(provider, "reset_scope"),
		hasDeleteMemory: await hasCapability(provider, "delete_memory"),
	};
}
