/**
 * Valid Full Provider - Test Fixture
 *
 * Provider implementing all core and optional operations.
 * Used to test registry loading and optional capability validation.
 */

import type { BaseProvider } from "../../../../types/provider";
import type {
	ScopeContext,
	MemoryRecord,
	RetrievalItem,
	ProviderCapabilities,
} from "../../../../types/core";

// Simple in-memory storage for testing
const memories = new Map<string, MemoryRecord>();

/**
 * Generate a scoped key for memory storage.
 * Ensures test isolation by including user_id and run_id.
 */
function getScopedKey(scope: ScopeContext, memoryId: string): string {
	return `${scope.user_id}:${scope.run_id}:${memoryId}`;
}

const validFullProvider: BaseProvider = {
	name: "valid-full",

	// === Core Operations ===

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
		limit: number = 10,
	): Promise<RetrievalItem[]> {
		const results: RetrievalItem[] = [];
		const prefix = `${scope.user_id}:${scope.run_id}:`;

		// Simple substring matching for testing
		for (const [key, record] of memories) {
			if (!key.startsWith(prefix)) continue;

			if (record.context.toLowerCase().includes(query.toLowerCase())) {
				results.push({
					record,
					score: 0.9, // Fixed score for testing
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

	// === Optional Operations ===

	async update_memory(
		scope: ScopeContext,
		memory_id: string,
		content: string,
		metadata?: Record<string, unknown>,
	): Promise<MemoryRecord> {
		const key = getScopedKey(scope, memory_id);
		const existing = memories.get(key);

		if (!existing) {
			throw new Error(`Memory ${memory_id} not found`);
		}

		const updated: MemoryRecord = {
			...existing,
			context: content,
			metadata: metadata ?? existing.metadata,
			timestamp: Date.now(),
		};

		memories.set(key, updated);
		return updated;
	},

	async list_memories(
		scope: ScopeContext,
		limit: number = 100,
		offset: number = 0,
	): Promise<MemoryRecord[]> {
		const prefix = `${scope.user_id}:${scope.run_id}:`;
		const results: MemoryRecord[] = [];

		for (const [key, record] of memories) {
			if (key.startsWith(prefix)) {
				results.push(record);
			}
		}

		return results.slice(offset, offset + limit);
	},

	async reset_scope(scope: ScopeContext): Promise<boolean> {
		const prefix = `${scope.user_id}:${scope.run_id}:`;
		let deleted = 0;

		for (const key of memories.keys()) {
			if (key.startsWith(prefix)) {
				memories.delete(key);
				deleted++;
			}
		}

		return deleted > 0;
	},

	async get_capabilities(): Promise<ProviderCapabilities> {
		return {
			core_operations: {
				add_memory: true,
				retrieve_memory: true,
				delete_memory: true,
			},
			optional_operations: {
				update_memory: true,
				list_memories: true,
				reset_scope: true,
				get_capabilities: true,
			},
			system_flags: {
				async_indexing: false,
			},
			intelligence_flags: {
				auto_extraction: true,
				graph_support: true,
			},
		};
	},
};

export default validFullProvider;
