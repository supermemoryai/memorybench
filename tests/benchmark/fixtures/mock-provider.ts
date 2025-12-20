/**
 * Mock provider for benchmark testing
 */

import type {
	MemoryRecord,
	ProviderCapabilities,
	RetrievalItem,
	ScopeContext,
} from "../../../types/core";
import type { BaseProvider } from "../../../types/provider";

export const mockProviderCapabilities: ProviderCapabilities = {
	core_operations: {
		add_memory: true,
		retrieve_memory: true,
		delete_memory: false,
	},
	optional_operations: {
		update_memory: false,
		list_memories: false,
		reset_scope: false,
	},
	system_flags: {
		async_indexing: false,
		convergence_wait_ms: 100,
	},
	intelligence_flags: {
		auto_extraction: false,
		graph_support: false,
	},
};

export const mockProvider: BaseProvider = {
	name: "MockProvider",

	async get_capabilities(): Promise<ProviderCapabilities> {
		return mockProviderCapabilities;
	},

	async add_memory(
		scope: ScopeContext,
		content: string,
	): Promise<MemoryRecord> {
		return {
			id: `mock_${Date.now()}`,
			context: content,
			metadata: {},
			timestamp: Date.now(),
		};
	},

	async retrieve_memory(
		scope: ScopeContext,
		query: string,
		limit: number,
	): Promise<RetrievalItem[]> {
		return [
			{
				record: {
					id: "mock_result_1",
					context: "Mock result for: " + query,
					metadata: {},
					timestamp: Date.now(),
				},
				score: 0.95,
			},
		];
	},

	async delete_memory(scope: ScopeContext, id: string): Promise<boolean> {
		throw new Error("delete_memory not supported by MockProvider");
	},
};
