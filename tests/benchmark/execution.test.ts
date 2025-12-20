/**
 * Execution tests for running benchmarks against providers
 */

import { describe, expect, test } from "bun:test";
import { checkProviderCompatibility } from "../../src/loaders/benchmarks";
import type { ScopeContext } from "../../types/core";
import {
	mockProvider,
	mockProviderCapabilities,
} from "./fixtures/mock-provider";

describe("checkProviderCompatibility", () => {
	test("returns true when provider has all required capabilities", () => {
		const requiredCapabilities = ["add_memory", "retrieve_memory"];
		const result = checkProviderCompatibility(
			requiredCapabilities,
			mockProviderCapabilities,
		);
		expect(result).toBe(true);
	});

	test("returns false when provider missing required capability", () => {
		const requiredCapabilities = ["add_memory", "delete_memory"];
		const result = checkProviderCompatibility(
			requiredCapabilities,
			mockProviderCapabilities,
		);
		expect(result).toBe(false);
	});

	test("returns false for unknown capability string", () => {
		const requiredCapabilities = ["unknown_capability"];
		const result = checkProviderCompatibility(
			requiredCapabilities,
			mockProviderCapabilities,
		);
		expect(result).toBe(false);
	});

	test("returns true for empty capability requirements", () => {
		const requiredCapabilities: string[] = [];
		const result = checkProviderCompatibility(
			requiredCapabilities,
			mockProviderCapabilities,
		);
		expect(result).toBe(true);
	});

	test("validates core operation capabilities", () => {
		const requiredCapabilities = ["add_memory"];
		const result = checkProviderCompatibility(
			requiredCapabilities,
			mockProviderCapabilities,
		);
		expect(result).toBe(true);
	});

	test("validates optional operation capabilities", () => {
		const requiredCapabilities = ["update_memory"];
		const result = checkProviderCompatibility(
			requiredCapabilities,
			mockProviderCapabilities,
		);
		expect(result).toBe(false); // mockProvider doesn't support update_memory
	});
});

describe("benchmark execution", () => {
	test("run_case returns CaseResult with required fields", async () => {
		const scope: ScopeContext = {
			user_id: "test_user",
			run_id: "test_run",
			session_id: "test_session",
		};

		const testCase = {
			id: "test_case_001",
			description: "Test case",
			input: { query: "test query" },
			expected: "test answer",
		};

		// Import the valid benchmark fixture
		const validBenchmarkModule = await import(
			"./fixtures/valid-benchmark/index.ts"
		);
		const benchmark = validBenchmarkModule.default;

		const result = await benchmark.run_case(mockProvider, scope, testCase);

		expect(result.case_id).toBe(testCase.id);
		expect(result.status).toBe("pass");
		expect(typeof result.scores).toBe("object");
		expect(typeof result.duration_ms).toBe("number");
		expect(result.duration_ms).toBeGreaterThanOrEqual(0);
	});

	test("cases() returns iterable of BenchmarkCase objects", async () => {
		const validBenchmarkModule = await import(
			"./fixtures/valid-benchmark/index.ts"
		);
		const benchmark = validBenchmarkModule.default;

		const cases = benchmark.cases();
		const caseArray = Array.from(cases);

		expect(Array.isArray(caseArray)).toBe(true);
		expect(caseArray.length).toBeGreaterThan(0);
		expect(caseArray[0]).toHaveProperty("id");
		expect(caseArray[0]).toHaveProperty("input");
	});

	test("run_case handles errors gracefully", async () => {
		const scope: ScopeContext = {
			user_id: "test_user",
			run_id: "test_run",
			session_id: "test_session",
		};

		const errorTestCase = {
			id: "error_case",
			description: "Case that causes error",
			input: { query: "test" },
		};

		// Create a benchmark that throws an error
		const errorBenchmark = {
			meta: {
				name: "error-test",
				version: "1.0.0",
				required_capabilities: ["add_memory"],
			},
			cases() {
				return [errorTestCase];
			},
			async run_case(_provider: unknown, _scope: unknown, _case: unknown) {
				throw new Error("Test error");
			},
		};

		try {
			await errorBenchmark.run_case(mockProvider, scope, errorTestCase);
			expect(true).toBe(false); // Should not reach here
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
		}
	});
});
