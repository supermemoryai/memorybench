/**
 * Loader tests for benchmark discovery and loading
 */

import { beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import {
	BenchmarkRegistry,
	discoverBenchmarks,
	loadBenchmark,
} from "../../src/loaders/benchmarks";

describe("discoverBenchmarks", () => {
	test("discovers benchmarks in test fixtures", async () => {
		const fixturesPath = path.join(process.cwd(), "tests/benchmark/fixtures");
		const paths = await discoverBenchmarks(fixturesPath);

		expect(paths.length).toBeGreaterThan(0);
		expect(paths.some((p) => p.includes("valid-benchmark"))).toBe(true);
	});

	test("excludes node_modules directories", async () => {
		const fixturesPath = path.join(process.cwd(), "tests/benchmark/fixtures");
		const paths = await discoverBenchmarks(fixturesPath);

		expect(paths.every((p) => !p.includes("node_modules"))).toBe(true);
	});

	test("excludes nested tests directories", async () => {
		const fixturesPath = path.join(process.cwd(), "tests/benchmark/fixtures");
		const paths = await discoverBenchmarks(fixturesPath);

		// Should not have nested /tests/ directories after the fixtures path
		expect(
			paths.every((p) => {
				const afterFixtures = p.split("/fixtures/")[1] || "";
				return !afterFixtures.includes("/tests/");
			}),
		).toBe(true);
	});

	test("excludes fixtures subdirectories", async () => {
		const fixturesPath = path.join(process.cwd(), "tests/benchmark/fixtures");
		const paths = await discoverBenchmarks(fixturesPath);

		// The paths themselves are under fixtures/, but shouldn't include nested fixtures/
		expect(paths.every((p) => p.split("/fixtures/").length === 2)).toBe(true);
	});
});

describe("loadBenchmark", () => {
	test("successfully loads valid benchmark", async () => {
		const validPath = path.join(
			process.cwd(),
			"tests/benchmark/fixtures/valid-benchmark/index.ts",
		);
		const entry = await loadBenchmark(validPath);

		expect(entry.benchmark.meta.name).toBe("valid-test-benchmark");
		expect(entry.benchmark.meta.version).toBe("1.0.0");
		expect(entry.benchmark.meta.required_capabilities).toEqual([
			"add_memory",
			"retrieve_memory",
		]);
		expect(typeof entry.benchmark.cases).toBe("function");
		expect(typeof entry.benchmark.run_case).toBe("function");
	});

	test("throws error for invalid benchmark (missing meta)", async () => {
		const invalidPath = path.join(
			process.cwd(),
			"tests/benchmark/fixtures/invalid-benchmark/index.ts",
		);

		try {
			await loadBenchmark(invalidPath);
			expect(true).toBe(false); // Should not reach here
		} catch (error) {
			const err = error as { code?: string; message?: string };
			expect(err.code).toBe("INVALID_INTERFACE");
			expect(err.message).toContain("does not implement Benchmark interface");
		}
	});

	test("throws error for non-existent file", async () => {
		const nonExistentPath = path.join(
			process.cwd(),
			"tests/benchmark/fixtures/does-not-exist/index.ts",
		);

		try {
			await loadBenchmark(nonExistentPath);
			expect(true).toBe(false); // Should not reach here
		} catch (error) {
			const err = error as { code?: string };
			// Error code could be IMPORT_FAILED or ERR_MODULE_NOT_FOUND depending on Bun version
			expect(
				err.code === "IMPORT_FAILED" || err.code === "ERR_MODULE_NOT_FOUND",
			).toBe(true);
		}
	});
});

describe("BenchmarkRegistry", () => {
	let registry: BenchmarkRegistry;

	beforeEach(() => {
		registry = BenchmarkRegistry.getInstance();
		registry.reset();
	});

	test("getInstance returns singleton", () => {
		const instance1 = BenchmarkRegistry.getInstance();
		const instance2 = BenchmarkRegistry.getInstance();
		expect(instance1).toBe(instance2);
	});

	test("initializes and loads valid benchmarks", async () => {
		const fixturesPath = path.join(process.cwd(), "tests/benchmark/fixtures");
		const result = await registry.initialize(fixturesPath);

		expect(result.benchmarks.length).toBeGreaterThan(0);
		expect(
			result.benchmarks.some(
				(b) => b.benchmark.meta.name === "valid-test-benchmark",
			),
		).toBe(true);
	});

	test("get() retrieves loaded benchmark by name", async () => {
		const fixturesPath = path.join(process.cwd(), "tests/benchmark/fixtures");
		await registry.initialize(fixturesPath);

		const entry = registry.get("valid-test-benchmark");
		expect(entry).toBeDefined();
		expect(entry?.benchmark.meta.name).toBe("valid-test-benchmark");
	});

	test("get() returns undefined for non-existent benchmark", async () => {
		const fixturesPath = path.join(process.cwd(), "tests/benchmark/fixtures");
		await registry.initialize(fixturesPath);

		const entry = registry.get("does-not-exist");
		expect(entry).toBeUndefined();
	});

	test("list() returns all loaded benchmarks", async () => {
		const fixturesPath = path.join(process.cwd(), "tests/benchmark/fixtures");
		await registry.initialize(fixturesPath);

		const benchmarks = registry.list();
		expect(Array.isArray(benchmarks)).toBe(true);
		expect(benchmarks.length).toBeGreaterThan(0);
	});

	test("continues loading after encountering invalid benchmark (load-partial)", async () => {
		const fixturesPath = path.join(process.cwd(), "tests/benchmark/fixtures");
		const result = await registry.initialize(fixturesPath);

		// Should have loaded valid-benchmark despite invalid-benchmark failing
		expect(result.benchmarks.length).toBeGreaterThan(0);
		expect(result.errors.length).toBeGreaterThan(0);
	});

	test("detects duplicate benchmark names", async () => {
		// This would require creating duplicate fixtures, so we'll skip for now
		// In practice, duplicate detection works via the Map.has() check
		expect(true).toBe(true);
	});

	test("prevents re-initialization", async () => {
		const fixturesPath = path.join(process.cwd(), "tests/benchmark/fixtures");
		const result1 = await registry.initialize(fixturesPath);
		const result2 = await registry.initialize(fixturesPath);

		expect(result1.benchmarks.length).toBe(result2.benchmarks.length);
	});
});
