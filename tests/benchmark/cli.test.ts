/**
 * CLI formatting tests for benchmark listing
 */

import { describe, expect, test } from "bun:test";
import {
	formatBenchmarkJson,
	formatBenchmarkTable,
} from "../../src/loaders/benchmarks";
import type { LoadedBenchmarkEntry } from "../../types/benchmark";

// Mock benchmark entries for testing
const mockBenchmarks: LoadedBenchmarkEntry[] = [
	{
		benchmark: {
			meta: {
				name: "test-benchmark-1",
				version: "1.0.0",
				description: "First test benchmark",
				required_capabilities: ["add_memory", "retrieve_memory"],
			},
			cases() {
				return [];
			},
			async run_case() {
				return {
					case_id: "test",
					status: "pass",
					scores: {},
					duration_ms: 0,
				};
			},
		},
		path: "/path/to/benchmark1",
	},
	{
		benchmark: {
			meta: {
				name: "test-benchmark-2",
				version: "2.1.0",
				description: "Second test benchmark",
				required_capabilities: ["add_memory"],
			},
			cases() {
				return [];
			},
			async run_case() {
				return {
					case_id: "test",
					status: "pass",
					scores: {},
					duration_ms: 0,
				};
			},
		},
		path: "/path/to/benchmark2",
	},
];

describe("formatBenchmarkTable", () => {
	test("formats benchmarks as table", () => {
		const table = formatBenchmarkTable(mockBenchmarks);

		expect(table).toContain("Name");
		expect(table).toContain("Version");
		expect(table).toContain("Required Capabilities");
		expect(table).toContain("test-benchmark-1");
		expect(table).toContain("test-benchmark-2");
		expect(table).toContain("1.0.0");
		expect(table).toContain("2.1.0");
	});

	test("handles empty benchmark list", () => {
		const table = formatBenchmarkTable([]);

		expect(table).toContain("No benchmarks found");
	});

	test("includes capability lists in output", () => {
		const table = formatBenchmarkTable(mockBenchmarks);

		expect(table).toContain("add_memory, retrieve_memory");
		expect(table).toContain("add_memory");
	});
});

describe("formatBenchmarkJson", () => {
	test("formats benchmarks as JSON", () => {
		const json = formatBenchmarkJson(mockBenchmarks);
		const parsed = JSON.parse(json);

		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed.length).toBe(2);
		expect(parsed[0]).toHaveProperty("name");
		expect(parsed[0]).toHaveProperty("version");
		expect(parsed[0]).toHaveProperty("required_capabilities");
		expect(parsed[0]).toHaveProperty("path");
	});

	test("includes all metadata fields", () => {
		const json = formatBenchmarkJson(mockBenchmarks);
		const parsed = JSON.parse(json);

		expect(parsed[0].name).toBe("test-benchmark-1");
		expect(parsed[0].version).toBe("1.0.0");
		expect(parsed[0].description).toBe("First test benchmark");
		expect(parsed[0].required_capabilities).toEqual([
			"add_memory",
			"retrieve_memory",
		]);
	});

	test("handles empty benchmark list", () => {
		const json = formatBenchmarkJson([]);
		const parsed = JSON.parse(json);

		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed.length).toBe(0);
	});
});
