/**
 * Valid Minimal Provider - Test Fixture
 *
 * Minimal provider implementing only core operations (add, retrieve, delete).
 * Used to test registry loading and validation.
 */

import type {
	MemoryRecord,
	RetrievalItem,
	ScopeContext,
} from "../../../../types/core";
import type { BaseProvider } from "../../../../types/provider";

// Simple in-memory storage for testing
const memories = new Map<string, MemoryRecord>();

/**
 * Generate a scoped key for memory storage.
 * Ensures test isolation by including user_id and run_id.
 */
function getScopedKey(scope: ScopeContext, memoryId: string): string {
	return `${scope.user_id}:${scope.run_id}:${memoryId}`;
}

const validMinimalProvider: BaseProvider = {
	name: "valid-minimal",

	async add_memory(
		scope: ScopeContext,
		content: string,
		metadata?: Record<string, unknown>,
	): Promise<MemoryRecord> {
		const id = crypto.randomUUID();
		const record: MemoryRecord = {
			id,
			context: content,
			metadata: metadata ?? {},
			timestamp: Date.now(),
		};

		const key = getScopedKey(scope, id);
		memories.set(key, record);

		return record;
	},

	async retrieve_memory(
		scope: ScopeContext,
		query: string,
		limit = 10,
	): Promise<RetrievalItem[]> {
		const results: RetrievalItem[] = [];
		const prefix = `${scope.user_id}:${scope.run_id}:`;

		// Simple substring matching for testing
		for (const [key, record] of memories) {
			if (!key.startsWith(prefix)) continue;

			if (record.context.toLowerCase().includes(query.toLowerCase())) {
				results.push({
					record,
					score: 0.8, // Fixed score for testing
				});
			}

			if (results.length >= limit) break;
		}

		return results;
	},

	async delete_memory(
		scope: ScopeContext,
		memory_id: string,
	): Promise<boolean> {
		const key = getScopedKey(scope, memory_id);
		return memories.delete(key);
	},
};

export default validMinimalProvider;
