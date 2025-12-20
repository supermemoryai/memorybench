/**
 * Type guard tests for benchmark validation
 * Tests the isBenchmark() function against valid and invalid inputs
 */

import { describe, expect, test } from "bun:test";
import { isBenchmark } from "../../types/benchmark";

describe("isBenchmark type guard", () => {
	test("returns true for valid benchmark object", () => {
		const validBenchmark = {
			meta: {
				name: "test-benchmark",
				version: "1.0.0",
				required_capabilities: ["add_memory"],
			},
			cases() {
				return [];
			},
			async run_case() {
				return {
					case_id: "test",
					status: "pass" as const,
					scores: {},
					duration_ms: 0,
				};
			},
		};

		expect(isBenchmark(validBenchmark)).toBe(true);
	});

	test("returns false for null", () => {
		expect(isBenchmark(null)).toBe(false);
	});

	test("returns false for undefined", () => {
		expect(isBenchmark(undefined)).toBe(false);
	});

	test("returns false for non-object types", () => {
		expect(isBenchmark("string")).toBe(false);
		expect(isBenchmark(123)).toBe(false);
		expect(isBenchmark(true)).toBe(false);
	});

	test("returns false for object missing meta", () => {
		const invalid = {
			cases() {
				return [];
			},
			async run_case() {
				return {
					case_id: "test",
					status: "pass" as const,
					scores: {},
					duration_ms: 0,
				};
			},
		};

		expect(isBenchmark(invalid)).toBe(false);
	});

	test("returns false for meta missing name", () => {
		const invalid = {
			meta: {
				version: "1.0.0",
				required_capabilities: [],
			},
			cases() {
				return [];
			},
			async run_case() {
				return {
					case_id: "test",
					status: "pass" as const,
					scores: {},
					duration_ms: 0,
				};
			},
		};

		expect(isBenchmark(invalid)).toBe(false);
	});

	test("returns false for meta missing version", () => {
		const invalid = {
			meta: {
				name: "test",
				required_capabilities: [],
			},
			cases() {
				return [];
			},
			async run_case() {
				return {
					case_id: "test",
					status: "pass" as const,
					scores: {},
					duration_ms: 0,
				};
			},
		};

		expect(isBenchmark(invalid)).toBe(false);
	});

	test("returns false for meta missing required_capabilities", () => {
		const invalid = {
			meta: {
				name: "test",
				version: "1.0.0",
			},
			cases() {
				return [];
			},
			async run_case() {
				return {
					case_id: "test",
					status: "pass" as const,
					scores: {},
					duration_ms: 0,
				};
			},
		};

		expect(isBenchmark(invalid)).toBe(false);
	});

	test("returns false for missing cases() method", () => {
		const invalid = {
			meta: {
				name: "test",
				version: "1.0.0",
				required_capabilities: [],
			},
			async run_case() {
				return {
					case_id: "test",
					status: "pass" as const,
					scores: {},
					duration_ms: 0,
				};
			},
		};

		expect(isBenchmark(invalid)).toBe(false);
	});

	test("returns false for missing run_case() method", () => {
		const invalid = {
			meta: {
				name: "test",
				version: "1.0.0",
				required_capabilities: [],
			},
			cases() {
				return [];
			},
		};

		expect(isBenchmark(invalid)).toBe(false);
	});

	test("returns true for benchmark with optional description", () => {
		const validBenchmark = {
			meta: {
				name: "test-benchmark",
				version: "1.0.0",
				description: "Test description",
				required_capabilities: ["add_memory", "retrieve_memory"],
			},
			cases() {
				return [];
			},
			async run_case() {
				return {
					case_id: "test",
					status: "pass" as const,
					scores: {},
					duration_ms: 0,
				};
			},
		};

		expect(isBenchmark(validBenchmark)).toBe(true);
	});
});
