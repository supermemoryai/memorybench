/**
 * ProviderRegistry Tests
 *
 * Tests registry loading, provider lookup, and multi-provider handling.
 * (T021, T022, User Story 2)
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { ScopeContext } from "../../types/core";
import type { BaseProvider } from "../../types/provider";

// Dynamic import to allow reset between tests
async function getRegistry() {
	const { ProviderRegistry } = await import("../../src/loaders/providers");
	return ProviderRegistry;
}

describe("ProviderRegistry - Singleton and Initialization", () => {
	beforeEach(async () => {
		// Reset singleton before each test
		const Registry = await getRegistry();
		Registry.reset();
	});

	test("getInstance() creates singleton instance", async () => {
		const Registry = await getRegistry();
		const fixturesDir = process.cwd() + "/tests/registry/fixtures";

		const instance1 = await Registry.getInstance(fixturesDir);
		const instance2 = await Registry.getInstance(fixturesDir);

		// Same instance returned
		expect(instance1).toBe(instance2);
	});

	test("reset() clears singleton instance", async () => {
		const Registry = await getRegistry();
		const fixturesDir = process.cwd() + "/tests/registry/fixtures";

		const instance1 = await Registry.getInstance(fixturesDir);
		Registry.reset();
		const instance2 = await Registry.getInstance(fixturesDir);

		// Different instances after reset
		expect(instance1).not.toBe(instance2);
	});

	test("initialize() eagerly loads providers from fixtures", async () => {
		const Registry = await getRegistry();
		const fixturesDir = process.cwd() + "/tests/registry/fixtures";

		const registry = await Registry.getInstance(fixturesDir);
		const providers = registry.listProviders();

		// Should find valid-minimal and valid-full fixtures
		expect(providers.length).toBeGreaterThanOrEqual(2);
	});
});

describe("ProviderRegistry - Provider Lookup (T021)", () => {
	beforeEach(async () => {
		const Registry = await getRegistry();
		Registry.reset();
	});

	test("getProvider() returns provider by name", async () => {
		const Registry = await getRegistry();
		const fixturesDir = process.cwd() + "/tests/registry/fixtures";

		const registry = await Registry.getInstance(fixturesDir);
		const provider = registry.getProvider("valid-minimal");

		expect(provider).toBeDefined();
		expect(provider?.adapter.name).toBe("valid-minimal");
	});

	test("getProvider() returns undefined for non-existent provider", async () => {
		const Registry = await getRegistry();
		const fixturesDir = process.cwd() + "/tests/registry/fixtures";

		const registry = await Registry.getInstance(fixturesDir);
		const provider = registry.getProvider("non-existent-provider");

		expect(provider).toBeUndefined();
	});

	test("getProvider() returns LoadedProviderEntry with adapter, manifest, and path", async () => {
		const Registry = await getRegistry();
		const fixturesDir = process.cwd() + "/tests/registry/fixtures";

		const registry = await Registry.getInstance(fixturesDir);
		const entry = registry.getProvider("valid-minimal");

		expect(entry).toBeDefined();
		expect(entry?.adapter).toBeDefined();
		expect(entry?.manifest).toBeDefined();
		expect(entry?.path).toBeDefined();

		// Verify structure
		expect(entry?.adapter.name).toBe("valid-minimal");
		expect(entry?.manifest.provider.name).toBe("valid-minimal");
		expect(entry?.path).toContain("valid-minimal");
	});

	test("listProviders() returns all loaded providers", async () => {
		const Registry = await getRegistry();
		const fixturesDir = process.cwd() + "/tests/registry/fixtures";

		const registry = await Registry.getInstance(fixturesDir);
		const providers = registry.listProviders();

		// Should have at least valid-minimal and valid-full
		expect(providers.length).toBeGreaterThanOrEqual(2);

		// Each entry should have adapter, manifest, path
		for (const entry of providers) {
			expect(entry.adapter).toBeDefined();
			expect(entry.manifest).toBeDefined();
			expect(entry.path).toBeDefined();
		}
	});

	test("listProviders() returns providers with names matching manifests", async () => {
		const Registry = await getRegistry();
		const fixturesDir = process.cwd() + "/tests/registry/fixtures";

		const registry = await Registry.getInstance(fixturesDir);
		const providers = registry.listProviders();

		// Find valid-minimal and valid-full
		const minimal = providers.find((p) => p.adapter.name === "valid-minimal");
		const full = providers.find((p) => p.adapter.name === "valid-full");

		expect(minimal).toBeDefined();
		expect(full).toBeDefined();

		// Names should match manifests
		expect(minimal?.manifest.provider.name).toBe("valid-minimal");
		expect(full?.manifest.provider.name).toBe("valid-full");
	});
});

describe("ProviderRegistry - Multi-Provider Loading (T022)", () => {
	beforeEach(async () => {
		const Registry = await getRegistry();
		Registry.reset();
	});

	test("loads multiple providers with different capabilities", async () => {
		const Registry = await getRegistry();
		const fixturesDir = process.cwd() + "/tests/registry/fixtures";

		const registry = await Registry.getInstance(fixturesDir);

		const minimal = registry.getProvider("valid-minimal");
		const full = registry.getProvider("valid-full");

		expect(minimal).toBeDefined();
		expect(full).toBeDefined();

		// valid-minimal has no optional operations
		expect(minimal?.adapter.update_memory).toBeUndefined();
		expect(minimal?.adapter.list_memories).toBeUndefined();

		// valid-full has all optional operations
		expect(full?.adapter.update_memory).toBeDefined();
		expect(full?.adapter.list_memories).toBeDefined();
		expect(full?.adapter.reset_scope).toBeDefined();
		expect(full?.adapter.get_capabilities).toBeDefined();
	});

	test("can call add_memory on any loaded provider with same interface", async () => {
		const Registry = await getRegistry();
		const fixturesDir = process.cwd() + "/tests/registry/fixtures";

		const registry = await Registry.getInstance(fixturesDir);
		const providers = registry.listProviders();

		const scope: ScopeContext = {
			user_id: "test-user",
			run_id: "multi-provider-test",
		};

		// Call add_memory on each provider - same interface
		for (const entry of providers) {
			const record = await entry.adapter.add_memory(
				scope,
				`Test content for ${entry.adapter.name}`,
				{ test: true },
			);

			// All should return MemoryRecord with same structure
			expect(record).toHaveProperty("id");
			expect(record).toHaveProperty("context");
			expect(record).toHaveProperty("metadata");
			expect(record).toHaveProperty("timestamp");
			expect(record.context).toContain(entry.adapter.name);
		}
	});

	test("can call retrieve_memory on any loaded provider with same interface", async () => {
		const Registry = await getRegistry();
		const fixturesDir = process.cwd() + "/tests/registry/fixtures";

		const registry = await Registry.getInstance(fixturesDir);
		const providers = registry.listProviders();

		const scope: ScopeContext = {
			user_id: "test-user",
			run_id: "retrieve-test",
		};

		// Add a memory first
		for (const entry of providers) {
			await entry.adapter.add_memory(scope, "searchable content", {});
		}

		// Retrieve from each provider - same interface
		for (const entry of providers) {
			const results = await entry.adapter.retrieve_memory(
				scope,
				"searchable",
				10,
			);

			// All should return RetrievalItem[]
			expect(Array.isArray(results)).toBe(true);

			if (results.length > 0) {
				expect(results[0]).toHaveProperty("record");
				expect(results[0]).toHaveProperty("score");
			}
		}
	});

	test("provider-agnostic iteration pattern works", async () => {
		const Registry = await getRegistry();
		const fixturesDir = process.cwd() + "/tests/registry/fixtures";

		const registry = await Registry.getInstance(fixturesDir);

		const scope: ScopeContext = {
			user_id: "test-user",
			run_id: "iteration-test",
		};

		// Pattern: Runner code that doesn't know about specific providers
		const results: Array<{ provider: string; memoryId: string }> = [];

		for (const entry of registry.listProviders()) {
			const provider = entry.adapter;

			// Same code works for all providers
			const memory = await provider.add_memory(scope, "test content", {});
			results.push({ provider: provider.name, memoryId: memory.id });
		}

		// Should have results from all providers
		expect(results.length).toBeGreaterThanOrEqual(2);
		expect(results.some((r) => r.provider === "valid-minimal")).toBe(true);
		expect(results.some((r) => r.provider === "valid-full")).toBe(true);
	});
});

describe("ProviderRegistry - Error Handling (T032)", () => {
	beforeEach(async () => {
		const Registry = await getRegistry();
		Registry.reset();
	});

	test("load-partial behavior: loads valid providers despite invalid ones", async () => {
		const Registry = await getRegistry();
		const fixturesDir = process.cwd() + "/tests/registry/fixtures";

		const registry = await Registry.getInstance(fixturesDir);
		const providers = registry.listProviders();

		// Should have loaded valid-minimal and valid-full
		// Invalid providers (missing-manifest, missing-adapter, name-mismatch) should be skipped
		expect(providers.length).toBeGreaterThanOrEqual(2);

		// Valid providers should be accessible
		const minimal = registry.getProvider("valid-minimal");
		const full = registry.getProvider("valid-full");
		expect(minimal).toBeDefined();
		expect(full).toBeDefined();

		// Invalid providers should not be loaded
		const missingManifest = registry.getProvider("missing-manifest");
		const missingAdapter = registry.getProvider("missing-adapter");
		const nameMismatch = registry.getProvider("expected-name");
		expect(missingManifest).toBeUndefined();
		expect(missingAdapter).toBeUndefined();
		expect(nameMismatch).toBeUndefined();
	});

	test("missing manifest skipped with warning", async () => {
		const Registry = await getRegistry();
		const fixturesDir = process.cwd() + "/tests/registry/fixtures";

		// Logs will contain warning for missing-manifest
		const registry = await Registry.getInstance(fixturesDir);

		// Provider should not be loaded
		const provider = registry.getProvider("missing-manifest");
		expect(provider).toBeUndefined();
	});

	test("missing adapter skipped with error", async () => {
		const Registry = await getRegistry();
		const fixturesDir = process.cwd() + "/tests/registry/fixtures";

		// Logs will contain error for missing-adapter
		const registry = await Registry.getInstance(fixturesDir);

		// Provider should not be loaded
		const provider = registry.getProvider("missing-adapter");
		expect(provider).toBeUndefined();
	});

	test("name mismatch skipped with error", async () => {
		const Registry = await getRegistry();
		const fixturesDir = process.cwd() + "/tests/registry/fixtures";

		const registry = await Registry.getInstance(fixturesDir);

		// Provider should not be loaded (neither expected-name nor actual-name)
		const expected = registry.getProvider("expected-name");
		const actual = registry.getProvider("actual-name");
		expect(expected).toBeUndefined();
		expect(actual).toBeUndefined();
	});

	test("duplicate provider names handled correctly", async () => {
		const Registry = await getRegistry();
		const fixturesDir = process.cwd() + "/tests/registry/fixtures";

		const registry = await Registry.getInstance(fixturesDir);

		// Only one "duplicate-provider" should be loaded (first one encountered)
		const duplicate = registry.getProvider("duplicate-provider");

		// Either both should be rejected, or first should load
		// Based on load-partial behavior, first loads, second is rejected
		const allProviders = registry.listProviders();
		const duplicateCount = allProviders.filter(
			(p) => p.adapter.name === "duplicate-provider",
		).length;

		// Should have at most 1 provider with this name
		expect(duplicateCount).toBeLessThanOrEqual(1);
	});
});

describe("ProviderRegistry - Capability Validation (T041)", () => {
	async function getRegistry() {
		const { ProviderRegistry } = await import("../../src/loaders/providers");
		ProviderRegistry.reset();
		return ProviderRegistry;
	}

	test("providers with declared optional operations must have those methods", async () => {
		const Registry = await getRegistry();
		const fixturesDir = process.cwd() + "/tests/registry/fixtures";

		const registry = await Registry.getInstance(fixturesDir);

		// valid-full declares and implements optional operations
		const provider = registry.getProvider("valid-full");
		expect(provider).toBeDefined();

		// Should have optional methods since they're declared in manifest
		expect(typeof provider?.adapter.update_memory).toBe("function");
		expect(typeof provider?.adapter.list_memories).toBe("function");
		expect(typeof provider?.adapter.reset_scope).toBe("function");
	});

	test("providers load successfully when capabilities match implementation", async () => {
		const Registry = await getRegistry();
		const fixturesDir = process.cwd() + "/tests/registry/fixtures";

		const registry = await Registry.getInstance(fixturesDir);

		// valid-minimal declares only core operations, no optional ones
		const minimal = registry.getProvider("valid-minimal");
		expect(minimal).toBeDefined();
		expect(minimal?.adapter.update_memory).toBeUndefined();

		// valid-full declares optional operations
		const full = registry.getProvider("valid-full");
		expect(full).toBeDefined();
		expect(full?.adapter.update_memory).toBeDefined();
	});

	test("legacy providers auto-wrapped maintain manifest capabilities", async () => {
		const Registry = await getRegistry();
		const fixturesDir = process.cwd() + "/tests/registry/fixtures";

		const registry = await Registry.getInstance(fixturesDir);

		// legacy-template should be wrapped but still conform to its manifest
		const legacy = registry.getProvider("legacy-template");
		expect(legacy).toBeDefined();

		// Should have BaseProvider interface
		expect(typeof legacy?.adapter.add_memory).toBe("function");
		expect(typeof legacy?.adapter.retrieve_memory).toBe("function");
		expect(typeof legacy?.adapter.delete_memory).toBe("function");

		// Should NOT have optional operations (not declared in manifest)
		expect(legacy?.adapter.update_memory).toBeUndefined();
		expect(legacy?.adapter.list_memories).toBeUndefined();
	});
});
