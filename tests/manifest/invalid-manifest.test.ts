/**
 * Tests for invalid manifest handling
 * @see specs/004-provider-manifest/spec.md User Story 1
 */

import { describe, test, expect } from "bun:test";
import {
	loadManifest,
	validateManifest,
	formatValidationError,
} from "../../src/loaders/providers";
import { SUPPORTED_MANIFEST_VERSIONS } from "../../types/manifest";
import path from "node:path";

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures");

describe("Invalid Manifest Handling", () => {
	test("T021: missing required fields returns specific error", async () => {
		const manifestPath = path.join(FIXTURES_DIR, "invalid/missing-required.json");
		const json = await loadManifest(manifestPath);
		const result = validateManifest(json, manifestPath);

		expect(result.success).toBe(false);
		if (!result.success) {
			// Should identify the missing field (provider.version)
			const errorMessage = formatValidationError(result.error);
			expect(errorMessage).toContain("provider.version");
			// Zod reports missing fields as "Expected string. Received undefined"
			expect(errorMessage).toMatch(/Expected|Required/);
		}
	});

	test("T022: invalid enum values returns specific error", async () => {
		const manifestPath = path.join(FIXTURES_DIR, "invalid/invalid-enum.json");
		const json = await loadManifest(manifestPath);
		const result = validateManifest(json, manifestPath);

		expect(result.success).toBe(false);
		if (!result.success) {
			const errorMessage = formatValidationError(result.error);
			// Should mention the field and valid options
			expect(errorMessage).toContain("provider.type");
			expect(errorMessage).toMatch(
				/intelligent_memory|hybrid|framework/,
			);
		}
	});

	test("T023: unsupported manifest_version lists supported versions", async () => {
		const manifestPath = path.join(FIXTURES_DIR, "invalid/invalid-version.json");
		const json = await loadManifest(manifestPath);
		const result = validateManifest(json, manifestPath);

		expect(result.success).toBe(false);
		if (!result.success) {
			const errorMessage = formatValidationError(result.error);
			// Should mention the unsupported version and list supported ones
			expect(errorMessage).toContain("manifest_version");
			// Should list supported versions
			for (const version of SUPPORTED_MANIFEST_VERSIONS) {
				expect(errorMessage).toContain(version);
			}
		}
	});

	test("validation error includes field, rule, and expected format (FR-009)", async () => {
		const manifestPath = path.join(FIXTURES_DIR, "invalid/invalid-enum.json");
		const json = await loadManifest(manifestPath);
		const result = validateManifest(json, manifestPath);

		expect(result.success).toBe(false);
		if (!result.success) {
			const errorMessage = formatValidationError(result.error);
			// FR-009: Must include field name, validation rule, expected format
			expect(errorMessage).toContain("provider.type"); // field
			expect(errorMessage).toMatch(/Invalid|Expected/i); // rule indication
			// Expected values should be listed
			expect(errorMessage).toMatch(/intelligent_memory|hybrid|framework/);
		}
	});
});
