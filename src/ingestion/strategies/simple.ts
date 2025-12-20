/**
 * Simple Ingestion Strategy
 *
 * Adds all content at once without any session organization.
 * Suitable for benchmarks like NoLiMa where content is added in bulk.
 *
 * @module src/ingestion/strategies/simple
 * @see specs/006-benchmark-interface/data-driven-benchmark-design.md
 */

import type {
	IngestionContext,
	IngestionResult,
	IngestionStrategy,
	SimpleIngestionConfig,
} from "../types";

/**
 * Default configuration for simple ingestion
 */
const DEFAULT_CONFIG: Partial<SimpleIngestionConfig> = {
	isArray: false,
	metadataFields: [],
};

/**
 * Extract metadata from input based on field names
 */
function extractMetadata(
	input: Record<string, unknown>,
	fields: string[],
): Record<string, unknown> {
	const metadata: Record<string, unknown> = {};

	for (const field of fields) {
		if (field in input) {
			metadata[field] = input[field];
		}
	}

	return metadata;
}

/**
 * Get convergence wait time from provider if available
 */
async function getConvergenceWaitMs(
	provider: IngestionContext["provider"],
): Promise<number> {
	if (provider.get_capabilities) {
		try {
			const capabilities = await provider.get_capabilities();
			return capabilities?.system_flags?.convergence_wait_ms ?? 0;
		} catch {
			return 0;
		}
	}
	return 0;
}

/**
 * Create a simple ingestion strategy
 *
 * @param config - Configuration for simple ingestion
 * @returns Ingestion strategy implementation
 *
 * @example
 * ```typescript
 * const strategy = createSimpleIngestion({
 *   contentField: "documents",
 *   isArray: true,
 *   metadataFields: ["category", "source"]
 * });
 *
 * const result = await strategy.ingest({
 *   provider,
 *   scope,
 *   input: {
 *     documents: ["doc1 content", "doc2 content"],
 *     category: "test"
 *   }
 * });
 * ```
 */
export function createSimpleIngestion(
	config: SimpleIngestionConfig,
): IngestionStrategy {
	const mergedConfig = { ...DEFAULT_CONFIG, ...config };

	return {
		name: "simple",

		async ingest(context: IngestionContext): Promise<IngestionResult> {
			const { provider, scope, input, metadata: extraMetadata } = context;
			const ingestedIds: string[] = [];
			const errors: string[] = [];

			// Get content from input
			const content = input[mergedConfig.contentField];

			if (content === undefined) {
				return {
					ingestedIds: [],
					ingestedCount: 0,
					skippedCount: 0,
					totalCount: 0,
					errors: [`Content field '${mergedConfig.contentField}' not found in input`],
				};
			}

			// Extract metadata from input
			const inputMetadata = extractMetadata(
				input,
				mergedConfig.metadataFields ?? [],
			);
			const combinedMetadata = { ...inputMetadata, ...extraMetadata };

			// Handle array or single content
			const contentItems = mergedConfig.isArray
				? (content as unknown[])
				: [content];

			const totalCount = contentItems.length;

			// Ingest each item
			for (let i = 0; i < contentItems.length; i++) {
				const item = contentItems[i];
				const itemContent =
					typeof item === "string" ? item : JSON.stringify(item);

				try {
					const record = await provider.add_memory(
						scope,
						itemContent,
						{ ...combinedMetadata, _index: i },
					);
					ingestedIds.push(record.id);
				} catch (error) {
					errors.push(
						`Failed to ingest item ${i}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}

			// Respect provider convergence time if specified
			const convergenceWaitMs = await getConvergenceWaitMs(provider);
			if (convergenceWaitMs > 0) {
				await new Promise((resolve) => setTimeout(resolve, convergenceWaitMs));
			}

			return {
				ingestedIds,
				ingestedCount: ingestedIds.length,
				skippedCount: totalCount - ingestedIds.length,
				totalCount,
				errors: errors.length > 0 ? errors : undefined,
			};
		},
	};
}
