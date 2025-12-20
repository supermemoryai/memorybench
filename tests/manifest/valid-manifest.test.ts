/**
 * Tests for valid manifest loading
 * @see specs/004-provider-manifest/spec.md User Story 1
 */

import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
	loadAllProviders,
	loadManifest,
	validateManifest,
} from "../../src/loaders/providers";

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures");

describe("Valid Manifest Loading", () => {
	test("T020: valid manifest loads successfully", async () => {
		const manifestPath = path.join(FIXTURES_DIR, "valid/manifest.json");
		const json = await loadManifest(manifestPath);
		const result = validateManifest(json, manifestPath);

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.manifest_version).toBe("1");
			expect(result.data.provider.name).toBe("TestProvider");
			expect(result.data.provider.type).toBe("intelligent_memory");
			expect(result.data.provider.version).toBe("1.0.0");
			expect(result.data.capabilities.core_operations.add_memory).toBe(true);
			expect(result.data.semantic_properties.update_strategy).toBe("eventual");
			expect(
				result.data.conformance_tests.expected_behavior.convergence_wait_ms,
			).toBe(500);
		}
	});

	test("valid manifest preserves unknown fields (forward compatibility)", async () => {
		const manifestPath = path.join(FIXTURES_DIR, "valid/manifest.json");
		const json = await loadManifest(manifestPath);

		// Add an unknown field - cast to object to spread
		const jsonWithExtra = {
			...(json as Record<string, unknown>),
			future_field: "should be preserved",
		};
		const result = validateManifest(jsonWithExtra, manifestPath);

		expect(result.success).toBe(true);
		if (result.success) {
			// Passthrough should preserve unknown fields
			expect((result.data as Record<string, unknown>).future_field).toBe(
				"should be preserved",
			);
		}
	});
});
