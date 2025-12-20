/**
 * Tests for simple ingestion strategy
 *
 * @see src/ingestion/strategies/simple.ts
 */

import { describe, expect, test } from "bun:test";
import { createSimpleIngestion } from "../../src/ingestion/strategies/simple";
import type { IngestionContext } from "../../src/ingestion/types";
import type { ScopeContext } from "../../types/core";
import type { BaseProvider, MemoryRecord } from "../../types/provider";

/**
 * Create a mock provider for testing
 */
function createMockProvider(): BaseProvider & { addedRecords: MemoryRecord[] } {
	const addedRecords: MemoryRecord[] = [];
	let idCounter = 0;

	return {
		name: "mock-provider",
		addedRecords,

		async add_memory(
			_scope: ScopeContext,
			content: string,
			metadata?: Record<string, unknown>,
		): Promise<MemoryRecord> {
			const record: MemoryRecord = {
				id: `record_${++idCounter}`,
				context: content,
				timestamp: Date.now(),
				metadata,
			};
			addedRecords.push(record);
			return record;
		},

		async retrieve_memory() {
			return [];
		},

		async delete_memory() {
			return true;
		},
	};
}

describe("createSimpleIngestion", () => {
	test("returns ingestion strategy with correct name", () => {
		const strategy = createSimpleIngestion({ contentField: "content" });
		expect(strategy.name).toBe("simple");
	});

	test("ingests single content item", async () => {
		const strategy = createSimpleIngestion({ contentField: "content" });
		const provider = createMockProvider();
		const scope: ScopeContext = { user_id: "test", run_id: "run1" };

		const context: IngestionContext = {
			provider,
			scope,
			input: { content: "Hello world" },
		};

		const result = await strategy.ingest(context);

		expect(result.ingestedCount).toBe(1);
		expect(result.ingestedIds).toHaveLength(1);
		expect(result.totalCount).toBe(1);
		expect(result.skippedCount).toBe(0);
		expect(provider.addedRecords[0]?.context).toBe("Hello world");
	});

	test("ingests array of content items", async () => {
		const strategy = createSimpleIngestion({
			contentField: "documents",
			isArray: true,
		});
		const provider = createMockProvider();
		const scope: ScopeContext = { user_id: "test", run_id: "run1" };

		const context: IngestionContext = {
			provider,
			scope,
			input: { documents: ["doc1", "doc2", "doc3"] },
		};

		const result = await strategy.ingest(context);

		expect(result.ingestedCount).toBe(3);
		expect(result.ingestedIds).toHaveLength(3);
		expect(result.totalCount).toBe(3);
		expect(provider.addedRecords).toHaveLength(3);
	});

	test("includes metadata fields", async () => {
		const strategy = createSimpleIngestion({
			contentField: "content",
			metadataFields: ["category", "source"],
		});
		const provider = createMockProvider();
		const scope: ScopeContext = { user_id: "test", run_id: "run1" };

		const context: IngestionContext = {
			provider,
			scope,
			input: {
				content: "Hello",
				category: "test",
				source: "unit-test",
				ignored: "this should not appear",
			},
		};

		const result = await strategy.ingest(context);

		expect(result.ingestedCount).toBe(1);
		expect(provider.addedRecords[0]?.metadata?.category).toBe("test");
		expect(provider.addedRecords[0]?.metadata?.source).toBe("unit-test");
		expect(provider.addedRecords[0]?.metadata?.ignored).toBeUndefined();
	});

	test("returns error when content field not found", async () => {
		const strategy = createSimpleIngestion({ contentField: "missing" });
		const provider = createMockProvider();
		const scope: ScopeContext = { user_id: "test", run_id: "run1" };

		const context: IngestionContext = {
			provider,
			scope,
			input: { content: "Hello" },
		};

		const result = await strategy.ingest(context);

		expect(result.ingestedCount).toBe(0);
		expect(result.errors).toBeDefined();
		expect(result.errors?.[0]).toContain("missing");
	});

	test("handles provider errors gracefully", async () => {
		const strategy = createSimpleIngestion({
			contentField: "documents",
			isArray: true,
		});

		let callCount = 0;
		const errorProvider: BaseProvider = {
			name: "error-provider",
			async add_memory() {
				callCount++;
				if (callCount === 2) {
					throw new Error("Simulated failure");
				}
				return { id: `id_${callCount}`, context: "", timestamp: Date.now() };
			},
			async retrieve_memory() {
				return [];
			},
			async delete_memory() {
				return true;
			},
		};

		const scope: ScopeContext = { user_id: "test", run_id: "run1" };
		const context: IngestionContext = {
			provider: errorProvider,
			scope,
			input: { documents: ["doc1", "doc2", "doc3"] },
		};

		const result = await strategy.ingest(context);

		expect(result.ingestedCount).toBe(2); // 2 succeeded
		expect(result.skippedCount).toBe(1); // 1 failed
		expect(result.errors).toBeDefined();
		expect(result.errors?.[0]).toContain("Simulated failure");
	});

	test("adds extra metadata from context", async () => {
		const strategy = createSimpleIngestion({ contentField: "content" });
		const provider = createMockProvider();
		const scope: ScopeContext = { user_id: "test", run_id: "run1" };

		const context: IngestionContext = {
			provider,
			scope,
			input: { content: "Hello" },
			metadata: { benchmark: "test-benchmark" },
		};

		const result = await strategy.ingest(context);

		expect(result.ingestedCount).toBe(1);
		expect(provider.addedRecords[0]?.metadata?.benchmark).toBe("test-benchmark");
	});
});
