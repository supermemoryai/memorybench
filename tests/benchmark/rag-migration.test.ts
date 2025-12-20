/**
 * RAG benchmark migration tests
 * Validates the migrated RAG benchmark implementation
 */

import { describe, expect, test } from "bun:test";
import { BenchmarkRegistry } from "../../src/loaders/benchmarks";
import type { ScopeContext } from "../../types/core";
import { mockProvider } from "./fixtures/mock-provider";

describe("RAG benchmark migration", () => {
	test("RAG benchmark loads successfully", async () => {
		const registry = BenchmarkRegistry.getInstance();
		registry.reset();

		const result = await registry.initialize();

		const ragBenchmark = result.benchmarks.find(
			(b) => b.benchmark.meta.name === "RAG-template-benchmark",
		);

		expect(ragBenchmark).toBeDefined();
		expect(ragBenchmark?.benchmark.meta.version).toBe("1.0.0");
		expect(ragBenchmark?.benchmark.meta.required_capabilities).toEqual([
			"add_memory",
			"retrieve_memory",
		]);
	});

	test("RAG benchmark cases() returns all test cases", async () => {
		const registry = BenchmarkRegistry.getInstance();
		registry.reset();

		await registry.initialize();

		const ragEntry = registry.get("RAG-template-benchmark");
		expect(ragEntry).toBeDefined();

		const cases = Array.from(ragEntry!.benchmark.cases());

		expect(cases.length).toBe(3); // ragBenchmarkData has 3 items
		expect(cases[0]!.id).toBe("rag_001");
		expect(cases[1]!.id).toBe("rag_002");
		expect(cases[2]!.id).toBe("rag_003");

		// Verify case structure
		expect(cases[0]!).toHaveProperty("id");
		expect(cases[0]!).toHaveProperty("description");
		expect(cases[0]!).toHaveProperty("input");
		expect(cases[0]!).toHaveProperty("expected");
		expect(cases[0]!).toHaveProperty("metadata");

		// Verify metadata mapping
		expect(cases[0]!.metadata?.difficulty).toBe("easy");
		expect(cases[0]!.metadata?.category).toBe("geography");
	});

	test("RAG benchmark run_case() executes and returns CaseResult", async () => {
		const registry = BenchmarkRegistry.getInstance();
		registry.reset();

		await registry.initialize();

		const ragEntry = registry.get("RAG-template-benchmark");
		expect(ragEntry).toBeDefined();

		const cases = Array.from(ragEntry!.benchmark.cases());
		const firstCase = cases[0]!;

		const scope: ScopeContext = {
			user_id: "test_user",
			run_id: "test_run",
			session_id: "test_session",
		};

		const result = await ragEntry!.benchmark.run_case(
			mockProvider,
			scope,
			firstCase,
		);

		// Validate CaseResult structure
		expect(result.case_id).toBe(firstCase.id);
		expect(result.status).toMatch(/pass|fail|error/);
		expect(typeof result.scores).toBe("object");
		expect(typeof result.duration_ms).toBe("number");
		expect(result.duration_ms).toBeGreaterThanOrEqual(0);

		// Verify millisecond precision timing (T044)
		expect(result.duration_ms).toBeGreaterThan(0);
		expect(Number.isFinite(result.duration_ms)).toBe(true);

		// Verify scores structure
		expect(result.scores).toHaveProperty("precision");
		expect(result.scores).toHaveProperty("retrieval_count");
		expect(result.scores).toHaveProperty("top_score");
	});

	test("RAG benchmark maintains backward compatibility", async () => {
		// Import the old exports to verify they still work
		const { ragBenchmarkData } = await import(
			"../../benchmarks/RAG-template-benchmark"
		);

		expect(ragBenchmarkData).toBeDefined();
		expect(Array.isArray(ragBenchmarkData)).toBe(true);
		expect(ragBenchmarkData.length).toBe(3);

		// Verify data structure hasn't changed
		expect(ragBenchmarkData[0]).toHaveProperty("id");
		expect(ragBenchmarkData[0]).toHaveProperty("question");
		expect(ragBenchmarkData[0]).toHaveProperty("expected_answer");
		expect(ragBenchmarkData[0]).toHaveProperty("documents");
		expect(ragBenchmarkData[0]).toHaveProperty("metadata");
	});

	test("RAG benchmark run_case() handles errors gracefully", async () => {
		const registry = BenchmarkRegistry.getInstance();
		registry.reset();

		await registry.initialize();

		const ragEntry = registry.get("RAG-template-benchmark");
		expect(ragEntry).toBeDefined();

		// Create a provider that throws errors
		const errorProvider = {
			...mockProvider,
			add_memory: async () => {
				throw new Error("Test error");
			},
		};

		const cases = Array.from(ragEntry!.benchmark.cases());
		const scope: ScopeContext = {
			user_id: "test_user",
			run_id: "test_run",
			session_id: "test_session",
		};

		const result = await ragEntry!.benchmark.run_case(
			errorProvider,
			scope,
			cases[0]!,
		);

		expect(result.status).toBe("error");
		expect(result.error).toBeDefined();
		expect(result.error?.message).toContain("Test error");
	});

	test("RAG benchmark timing precision is millisecond-level", async () => {
		const registry = BenchmarkRegistry.getInstance();
		registry.reset();

		await registry.initialize();

		const ragEntry = registry.get("RAG-template-benchmark");
		const cases = Array.from(ragEntry!.benchmark.cases());

		const scope: ScopeContext = {
			user_id: "test_user",
			run_id: "test_run",
			session_id: "test_session",
		};

		const result = await ragEntry!.benchmark.run_case(
			mockProvider,
			scope,
			cases[0]!,
		);

		// Verify duration_ms has decimal precision (millisecond level)
		expect(result.duration_ms).toBeGreaterThan(0);
		expect(Number.isFinite(result.duration_ms)).toBe(true);

		// Should have sub-second precision
		expect(result.duration_ms).toBeLessThan(10000); // Less than 10 seconds
	});
});
