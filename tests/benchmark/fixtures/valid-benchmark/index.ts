/**
 * Valid benchmark fixture for testing
 */

import type {
	Benchmark,
	BenchmarkCase,
	CaseResult,
} from "../../../../types/benchmark";
import type { ScopeContext } from "../../../../types/core";
import type { BaseProvider } from "../../../../types/provider";

const testCases: BenchmarkCase[] = [
	{
		id: "test_001",
		description: "Basic test case",
		input: { query: "test query" },
		expected: "test answer",
		metadata: {
			difficulty: "easy",
			category: "test",
		},
	},
];

const validBenchmark: Benchmark = {
	meta: {
		name: "valid-test-benchmark",
		version: "1.0.0",
		description: "A valid benchmark for testing discovery and loading",
		required_capabilities: ["add_memory", "retrieve_memory"],
	},

	cases() {
		return testCases;
	},

	async run_case(
		provider: BaseProvider,
		scope: ScopeContext,
		benchmarkCase: BenchmarkCase,
	): Promise<CaseResult> {
		const start = performance.now();

		return {
			case_id: benchmarkCase.id,
			status: "pass",
			scores: { accuracy: 1.0 },
			duration_ms: performance.now() - start,
		};
	},
};

export default validBenchmark;
