/**
 * Duplicate Name Fixture #2 - Error Test
 *
 * Second provider with name "duplicate-provider".
 * Should produce "duplicate provider name" error.
 */

import type {
	MemoryRecord,
	RetrievalItem,
	ScopeContext,
} from "../../../../types/core";
import type { BaseProvider } from "../../../../types/provider";

const duplicateProvider2: BaseProvider = {
	name: "duplicate-provider",

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

export default duplicateProvider2;
