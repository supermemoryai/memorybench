import type { BenchmarkRegistry, BenchmarkType } from "../../benchmarks";

const mockSearchFunction = async (_query: string) => {
	return [
		{
			id: "",
			context: "",
			score: 0,
		},
	];
};

export interface PreparedData {
	context: string;
	metadata: Record<string, unknown>;
}

export type BenchmarkProcessor<T extends BenchmarkType> = (
	data: BenchmarkRegistry[T][],
) => PreparedData[];

export type BenchmarkProcessors = {
	[K in BenchmarkType]?: BenchmarkProcessor<K>;
};

const templateType = {
	name: "Template repository",
	addContext: async (data: PreparedData) => {
		// process context with full type safety
		console.log(data.context); // string
		console.log(data.metadata); // Record<string, unknown>
	},

	searchQuery: async (query: string) => {
		return mockSearchFunction(query);
	},

	prepareProvider: <T extends BenchmarkType>(
		benchmarkType: T,
		data: BenchmarkRegistry[T][],
	): PreparedData[] => {
		const processors: BenchmarkProcessors = {
			RAG: (ragData: BenchmarkRegistry["RAG"][]) => {
				return ragData.map((item) => ({
					context: `Question: ${item.question}\n\nDocuments:\n${item.documents.map((d) => `- ${d.title}: ${d.content}`).join("\n")}`,
					metadata: {
						id: item.id,
						expectedAnswer: item.expected_answer,
						difficulty: item.metadata.difficulty,
						category: item.metadata.category,
					},
				}));
			},
		};

		const processor = processors[benchmarkType] as
			| BenchmarkProcessor<T>
			| undefined;
		if (!processor) {
			throw new Error(
				`Benchmark type "${benchmarkType}" not supported by this provider`,
			);
		}

		return processor(data);
	},
};

export type TemplateType = typeof templateType;

// =============================================================================
// BaseProvider Interface Example (005-provider-contract)
// =============================================================================

/**
 * NEW PROVIDER IMPLEMENTATION GUIDE
 *
 * For new providers, implement the BaseProvider interface instead of TemplateType.
 * Legacy TemplateType providers are automatically wrapped via LegacyProviderAdapter.
 *
 * Example BaseProvider implementation:
 *
 * ```typescript
 * import type { BaseProvider } from "../../types/provider";
 * import type { ScopeContext, MemoryRecord, RetrievalItem } from "../../types/core";
 *
 * const myProvider: BaseProvider = {
 *   name: "my-provider", // Must match manifest.provider.name
 *
 *   // === Required Operations ===
 *
 *   async add_memory(
 *     scope: ScopeContext,
 *     content: string,
 *     metadata?: Record<string, unknown>
 *   ): Promise<MemoryRecord> {
 *     const id = crypto.randomUUID();
 *     // Store memory using scope for isolation
 *     // Return MemoryRecord with generated ID
 *     return {
 *       id,
 *       context: content,
 *       metadata: metadata ?? {},
 *       timestamp: Date.now(),
 *     };
 *   },
 *
 *   async retrieve_memory(
 *     scope: ScopeContext,
 *     query: string,
 *     limit: number = 10
 *   ): Promise<RetrievalItem[]> {
 *     // Search memories within scope
 *     // Return array of RetrievalItem with scores
 *     return [];
 *   },
 *
 *   async delete_memory(
 *     scope: ScopeContext,
 *     memory_id: string
 *   ): Promise<boolean> {
 *     // Delete memory by ID within scope
 *     // Return true if deleted, false if not found
 *     return false;
 *   },
 *
 *   // === Optional Operations (declare in manifest) ===
 *
 *   async update_memory(
 *     scope: ScopeContext,
 *     memory_id: string,
 *     content: string,
 *     metadata?: Record<string, unknown>
 *   ): Promise<MemoryRecord> {
 *     // Only implement if manifest declares update_memory: true
 *     throw new Error("Not implemented");
 *   },
 *
 *   async list_memories(
 *     scope: ScopeContext,
 *     limit: number = 100,
 *     offset: number = 0
 *   ): Promise<MemoryRecord[]> {
 *     // Only implement if manifest declares list_memories: true
 *     return [];
 *   },
 *
 *   async reset_scope(scope: ScopeContext): Promise<boolean> {
 *     // Only implement if manifest declares reset_scope: true
 *     return false;
 *   },
 *
 *   async get_capabilities(): Promise<ProviderCapabilities> {
 *     // Only implement if manifest declares get_capabilities: true
 *     // Should match manifest capabilities
 *     return {
 *       core_operations: { add_memory: true, retrieve_memory: true, delete_memory: true },
 *       optional_operations: { update_memory: false, list_memories: false, reset_scope: false, get_capabilities: true },
 *       system_flags: { async_indexing: false },
 *       intelligence_flags: { auto_extraction: false, graph_support: false },
 *     };
 *   },
 * };
 *
 * export default myProvider;
 * ```
 *
 * IMPORTANT:
 * - Provider `name` must match `manifest.provider.name`
 * - All three core operations are required
 * - Optional operations must be declared in manifest.json
 * - Use ScopeContext for test isolation (user_id, run_id, session_id, namespace)
 * - Providers are auto-discovered by ProviderRegistry from providers/*\/index.ts
 */
