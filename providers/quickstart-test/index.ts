import type {
	MemoryRecord,
	ProviderCapabilities,
	RetrievalItem,
	ScopeContext,
} from "../../types/core";
import type { BaseProvider } from "../../types/provider";

// Your in-memory storage (replace with actual implementation)
const memories = new Map<string, MemoryRecord>();

const quickstartTest: BaseProvider = {
	name: "quickstart-test", // Must match manifest.provider.name

	// === Required Operations ===

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

		// Scope isolation: key includes user_id and run_id
		const key = `${scope.user_id}:${scope.run_id}:${id}`;
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

		for (const [key, record] of memories) {
			if (!key.startsWith(prefix)) continue;

			// Simple substring matching (replace with real search logic)
			if (record.context.toLowerCase().includes(query.toLowerCase())) {
				results.push({
					record,
					score: 0.8, // Replace with real scoring
				});
			}
		}

		return results.slice(0, limit);
	},

	async delete_memory(
		scope: ScopeContext,
		memory_id: string,
	): Promise<boolean> {
		const key = `${scope.user_id}:${scope.run_id}:${memory_id}`;
		return memories.delete(key);
	},

	// === Optional Operations (only if declared in manifest) ===

	async list_memories(
		scope: ScopeContext,
		limit = 100,
		offset = 0,
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

	async get_capabilities(): Promise<ProviderCapabilities> {
		return {
			core_operations: {
				add_memory: true,
				retrieve_memory: true,
				delete_memory: true,
			},
			optional_operations: {
				update_memory: false,
				list_memories: true,
				reset_scope: false,
				get_capabilities: true,
			},
			system_flags: {
				async_indexing: false,
			},
			intelligence_flags: {
				auto_extraction: false,
				graph_support: false,
			},
		};
	},
};

export default quickstartTest;
