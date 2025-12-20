/**
 * Tests for LegacyProviderAdapter (T040, FR-019)
 *
 * Verifies that:
 * 1. Legacy TemplateType providers are correctly wrapped
 * 2. add_memory maps to addContext and generates UUIDs
 * 3. retrieve_memory maps to searchQuery and wraps results
 * 4. delete_memory throws UnsupportedOperationError
 */

import { test, expect, describe } from "bun:test";
import type { PreparedData } from "../../providers/_template";

describe("LegacyProviderAdapter (T040)", () => {
	test("wraps TemplateType with BaseProvider interface", async () => {
		const { LegacyProviderAdapter, isBaseProvider } = await import(
			"../../types/provider"
		);

		// Create a mock legacy provider
		const legacyProvider = {
			name: "test-legacy",
			addContext: async (_data: PreparedData) => {},
			searchQuery: async (_query: string) => [
				{ id: "1", context: "test", score: 0.9 },
			],
			prepareProvider: () => [],
		};

		// Wrap it
		const adapter = new LegacyProviderAdapter(legacyProvider, "test-legacy");

		// Should now be a BaseProvider
		expect(isBaseProvider(adapter)).toBe(true);
		expect(adapter.name).toBe("test-legacy");
	});

	test("add_memory generates UUID and calls addContext", async () => {
		const { LegacyProviderAdapter } = await import("../../types/provider");

		let capturedData: PreparedData | null = null;

		const legacyProvider = {
			name: "test-legacy",
			addContext: async (data: PreparedData) => {
				capturedData = data;
			},
			searchQuery: async () => [],
			prepareProvider: () => [],
		};

		const adapter = new LegacyProviderAdapter(legacyProvider, "test-legacy");

		const scope = { user_id: "user-1", run_id: "run-1" };
		const result = await adapter.add_memory(
			scope,
			"test content",
			{ key: "value" },
		);

		// Should return MemoryRecord with UUID
		expect(result.id).toBeDefined();
		expect(result.id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		); // UUID v4 format
		expect(result.context).toBe("test content");
		expect(result.metadata).toEqual({ key: "value" });
		expect(result.timestamp).toBeGreaterThan(0);

		// Should have called addContext with enhanced metadata
		expect(capturedData?.context).toBe("test content");
		expect(capturedData?.metadata.key).toBe("value");
		expect(capturedData?.metadata._scope).toEqual({
			user_id: "user-1",
			run_id: "run-1",
			session_id: undefined,
			namespace: undefined,
		});
		expect(capturedData?.metadata._generated_id).toBeDefined();
	});

	test("retrieve_memory calls searchQuery and wraps results", async () => {
		const { LegacyProviderAdapter } = await import("../../types/provider");

		const legacyProvider = {
			name: "test-legacy",
			addContext: async () => {},
			searchQuery: async (query: string) => [
				{ id: "1", context: `Result for ${query}`, score: 0.9 },
				{ id: "2", context: "Another result", score: 0.7 },
			],
			prepareProvider: () => [],
		};

		const adapter = new LegacyProviderAdapter(legacyProvider, "test-legacy");

		const scope = { user_id: "user-1", run_id: "run-1" };
		const results = await adapter.retrieve_memory(scope, "test query", 10);

		// Should return RetrievalItem array
		expect(results).toHaveLength(2);
		expect(results[0].record.id).toBe("1");
		expect(results[0].record.context).toBe("Result for test query");
		expect(results[0].score).toBe(0.9);
		expect(results[1].record.id).toBe("2");
		expect(results[1].record.context).toBe("Another result");
		expect(results[1].score).toBe(0.7);
	});

	test("delete_memory throws UnsupportedOperationError", async () => {
		const { LegacyProviderAdapter, UnsupportedOperationError } =
			await import("../../types/provider");

		const legacyProvider = {
			name: "test-legacy",
			addContext: async () => {},
			searchQuery: async () => [],
			prepareProvider: () => [],
		};

		const adapter = new LegacyProviderAdapter(legacyProvider, "test-legacy");

		const scope = { user_id: "user-1", run_id: "run-1" };

		// Should throw UnsupportedOperationError
		await expect(adapter.delete_memory(scope, "test-id")).rejects.toThrow(
			UnsupportedOperationError,
		);
		await expect(adapter.delete_memory(scope, "test-id")).rejects.toThrow(
			"Provider 'test-legacy' does not support operation: delete_memory",
		);
	});

	test("legacy provider auto-detected and wrapped by registry", async () => {
		const { ProviderRegistry } = await import("../../src/loaders/providers");

		const fixturesDir = process.cwd() + "/tests/registry/fixtures";

		// Reset and load fixtures
		ProviderRegistry.reset();
		const registry = await ProviderRegistry.getInstance(fixturesDir);

		// legacy-template fixture should be loaded and wrapped
		const provider = registry.getProvider("legacy-template");

		expect(provider).toBeDefined();
		expect(provider?.adapter.name).toBe("legacy-template");

		// Should have BaseProvider interface
		expect(typeof provider?.adapter.add_memory).toBe("function");
		expect(typeof provider?.adapter.retrieve_memory).toBe("function");
		expect(typeof provider?.adapter.delete_memory).toBe("function");
	});
});
