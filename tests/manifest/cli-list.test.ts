/**
 * Tests for CLI list providers command
 * @see specs/004-provider-manifest/spec.md User Story 2
 */

import { describe, expect, test } from "bun:test";
import {
	formatProviderJson,
	formatProviderTable,
} from "../../src/loaders/providers";
import type { LoadedProvider } from "../../types/manifest";

// Mock providers for testing
const mockProviders: LoadedProvider[] = [
	{
		manifest: {
			manifest_version: "1",
			provider: {
				name: "TestProvider1",
				type: "intelligent_memory",
				version: "1.0.0",
			},
			capabilities: {
				core_operations: {
					add_memory: true,
					retrieve_memory: true,
					delete_memory: true,
				},
				optional_operations: {},
				system_flags: { async_indexing: true, convergence_wait_ms: 500 },
				intelligence_flags: { auto_extraction: true, graph_support: false },
			},
			semantic_properties: {
				update_strategy: "eventual",
				delete_strategy: "immediate",
			},
			conformance_tests: { expected_behavior: { convergence_wait_ms: 500 } },
		},
		path: "/providers/test1/manifest.json",
		hash: "abc123",
	},
	{
		manifest: {
			manifest_version: "1",
			provider: {
				name: "TestProvider2",
				type: "hybrid",
				version: "2.1.0",
			},
			capabilities: {
				core_operations: {
					add_memory: true,
					retrieve_memory: true,
					delete_memory: false,
				},
				optional_operations: { update_memory: true },
				system_flags: { async_indexing: false },
				intelligence_flags: { auto_extraction: false, graph_support: true },
			},
			semantic_properties: {
				update_strategy: "immediate",
				delete_strategy: "soft_delete",
			},
			conformance_tests: { expected_behavior: { convergence_wait_ms: 0 } },
		},
		path: "/providers/test2/manifest.json",
		hash: "def456",
	},
];

describe("CLI List Providers", () => {
	test("T032: list providers with multiple manifests displays table", () => {
		const output = formatProviderTable(mockProviders);

		// Should contain header row
		expect(output).toContain("Name");
		expect(output).toContain("Type");
		expect(output).toContain("Version");
		expect(output).toContain("Core Ops");

		// Should contain provider data
		expect(output).toContain("TestProvider1");
		expect(output).toContain("intelligent_memory");
		expect(output).toContain("1.0.0");
		expect(output).toContain("TestProvider2");
		expect(output).toContain("hybrid");
		expect(output).toContain("2.1.0");

		// Should show core operations
		expect(output).toContain("add");
		expect(output).toContain("retrieve");
		expect(output).toContain("delete");
	});

	test("T033: list providers with --json outputs JSON format", () => {
		const output = formatProviderJson(mockProviders);
		const parsed = JSON.parse(output);

		expect(parsed).toHaveProperty("providers");
		expect(Array.isArray(parsed.providers)).toBe(true);
		expect(parsed.providers.length).toBe(2);

		const first = parsed.providers[0];
		expect(first.name).toBe("TestProvider1");
		expect(first.type).toBe("intelligent_memory");
		expect(first.version).toBe("1.0.0");
		expect(first.manifest_hash).toBe("abc123");
	});

	test("T034: list providers with no manifests shows empty message", () => {
		const output = formatProviderTable([]);

		expect(output).toContain("No providers");
	});

	test("JSON output includes capabilities summary", () => {
		const output = formatProviderJson(mockProviders);
		const parsed = JSON.parse(output);

		const first = parsed.providers[0];
		expect(first.capabilities).toBeDefined();
		expect(first.capabilities.core_operations).toEqual({
			add_memory: true,
			retrieve_memory: true,
			delete_memory: true,
		});
	});
});
