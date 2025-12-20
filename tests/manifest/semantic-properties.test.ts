/**
 * Tests for semantic properties validation and accessors
 * @see specs/004-provider-manifest/spec.md User Story 3
 */

import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
	formatValidationError,
	getConvergenceWaitMs,
	getDeleteStrategy,
	getUpdateStrategy,
	loadManifest,
	validateManifest,
} from "../../src/loaders/providers";
import type { ProviderManifest } from "../../types/manifest";

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures");

// Valid manifest for testing accessors
const validManifest: ProviderManifest = {
	manifest_version: "1",
	provider: {
		name: "TestProvider",
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
		system_flags: { async_indexing: true },
		intelligence_flags: { auto_extraction: false, graph_support: false },
	},
	semantic_properties: {
		update_strategy: "eventual",
		delete_strategy: "immediate",
	},
	conformance_tests: {
		expected_behavior: {
			convergence_wait_ms: 500,
		},
	},
};

describe("Semantic Properties", () => {
	test("T041: eventual update_strategy is validated and accessible", () => {
		const strategy = getUpdateStrategy(validManifest);
		expect(strategy).toBe("eventual");
	});

	test("T042: immediate delete_strategy is validated and accessible", () => {
		const strategy = getDeleteStrategy(validManifest);
		expect(strategy).toBe("immediate");
	});

	test("T043: convergence_wait_ms is validated as non-negative integer", async () => {
		const manifestPath = path.join(FIXTURES_DIR, "valid/manifest.json");
		const json = await loadManifest(manifestPath);
		const result = validateManifest(json, manifestPath);

		expect(result.success).toBe(true);
		if (result.success) {
			const waitMs = getConvergenceWaitMs(result.data);
			expect(waitMs).toBe(500);
			expect(Number.isInteger(waitMs)).toBe(true);
			expect(waitMs).toBeGreaterThanOrEqual(0);
		}
	});

	test("T044: invalid semantic property enum value produces specific error", async () => {
		const invalidManifest = {
			manifest_version: "1",
			provider: {
				name: "BadSemantic",
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
				system_flags: { async_indexing: false },
				intelligence_flags: { auto_extraction: false, graph_support: false },
			},
			semantic_properties: {
				update_strategy: "invalid_strategy", // Invalid enum value
				delete_strategy: "immediate",
			},
			conformance_tests: {
				expected_behavior: {
					convergence_wait_ms: 0,
				},
			},
		};

		const result = validateManifest(invalidManifest, "test.json");

		expect(result.success).toBe(false);
		if (!result.success) {
			const errorMessage = formatValidationError(result.error);
			expect(errorMessage).toContain("semantic_properties.update_strategy");
			expect(errorMessage).toMatch(/immediate|eventual|versioned|immutable/);
		}
	});

	test("all update_strategy values are accepted", () => {
		const strategies = ["immediate", "eventual", "versioned", "immutable"];

		for (const strategy of strategies) {
			const manifest = {
				...validManifest,
				semantic_properties: {
					update_strategy: strategy,
					delete_strategy: "immediate",
				},
			};
			const result = validateManifest(manifest, "test.json");
			expect(result.success).toBe(true);
		}
	});

	test("all delete_strategy values are accepted", () => {
		const strategies = ["immediate", "eventual", "soft_delete"];

		for (const strategy of strategies) {
			const manifest = {
				...validManifest,
				semantic_properties: {
					update_strategy: "immediate",
					delete_strategy: strategy,
				},
			};
			const result = validateManifest(manifest, "test.json");
			expect(result.success).toBe(true);
		}
	});

	test("convergence_wait_ms of 0 is valid", () => {
		const manifest = {
			...validManifest,
			conformance_tests: {
				expected_behavior: {
					convergence_wait_ms: 0,
				},
			},
		};
		const result = validateManifest(manifest, "test.json");

		expect(result.success).toBe(true);
		if (result.success) {
			expect(getConvergenceWaitMs(result.data)).toBe(0);
		}
	});
});
