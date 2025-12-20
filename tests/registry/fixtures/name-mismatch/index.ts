/**
 * Name Mismatch Fixture - Error Test
 *
 * Provider where adapter.name != manifest.provider.name.
 * Should produce "name mismatch" error.
 */

import type {
	MemoryRecord,
	RetrievalItem,
	ScopeContext,
} from "../../../../types/core";
import type { BaseProvider } from "../../../../types/provider";

const nameMismatchProvider: BaseProvider = {
	name: "actual-name", // Different from manifest "expected-name"

	async add_memory(
		scope: ScopeContext,
		content: string,
		metadata?: Record<string, unknown>,
	): Promise<MemoryRecord> {
		return {
			id: crypto.randomUUID(),
			context: content,
			metadata: metadata ?? {},
			timestamp: Date.now(),
		};
	},

	async retrieve_memory(
		scope: ScopeContext,
		query: string,
		limit = 10,
	): Promise<RetrievalItem[]> {
		return [];
	},

	async delete_memory(
		scope: ScopeContext,
		memory_id: string,
	): Promise<boolean> {
		return true;
	},
};

export default nameMismatchProvider;
