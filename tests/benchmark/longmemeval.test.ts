/**
 * LongMemEval benchmark tests
 * Validates the LongMemEval benchmark implementation for long-term memory evaluation.
 */

import { describe, expect, mock, test } from "bun:test";
import { BenchmarkRegistry } from "../../src/loaders/benchmarks";
import type { ScopeContext } from "../../types/core";

// Import LongMemEval components directly for unit testing
import {
	getDatasetStats,
	getQuestionTypes,
	loadLongMemEvalData,
} from "../../benchmarks/LongMemEval/data";
import type { IngestionResult } from "../../benchmarks/LongMemEval/ingestion";
import type { JudgeResult } from "../../benchmarks/LongMemEval/judge";
import {
	aggregateScores,
	calculateScores,
	determineStatus,
	groupScoresByType,
} from "../../benchmarks/LongMemEval/metrics";
import type {
	LongMemEvalItem,
	QuestionType,
} from "../../benchmarks/LongMemEval/types";

// =============================================================================
// Test Fixtures
// =============================================================================

const mockJudgeResult: JudgeResult = {
	correctness: 0.85,
	faithfulness: 0.9,
	reasoning: "The answer correctly identifies the date mentioned.",
	typeSpecificScore: 0.8,
};

const mockIngestionResult: IngestionResult = {
	ingestedIds: ["session_1", "session_2"],
	ingestedCount: 2,
	skippedCount: 8,
	totalSessions: 10,
};

const mockRetrievalResults = [
	{
		record: {
			id: "result_1",
			context:
				"=== Session: sess_001 ===\nDate: 2023-05-15\n\n[USER]: Test message",
			metadata: {},
			timestamp: Date.now(),
		},
		score: 0.92,
	},
	{
		record: {
			id: "result_2",
			context:
				"=== Session: sess_002 ===\nDate: 2023-05-16\n\n[USER]: Another test",
			metadata: {},
			timestamp: Date.now(),
		},
		score: 0.85,
	},
];

// =============================================================================
// Data Loading Tests
// =============================================================================

describe("LongMemEval data loading", () => {
	test("loadLongMemEvalData() returns array of items", async () => {
		const data = await loadLongMemEvalData();

		expect(Array.isArray(data)).toBe(true);
		expect(data.length).toBeGreaterThan(0);
	});

	test("LongMemEvalItem has correct structure", async () => {
		const data = await loadLongMemEvalData();
		const item = data[0];

		expect(item).toHaveProperty("question_id");
		expect(item).toHaveProperty("question_type");
		expect(item).toHaveProperty("question");
		expect(item).toHaveProperty("question_date");
		expect(item).toHaveProperty("answer");
		expect(item).toHaveProperty("answer_session_ids");
		expect(item).toHaveProperty("haystack_dates");
		expect(item).toHaveProperty("haystack_session_ids");
		expect(item).toHaveProperty("haystack_sessions");
	});

	test("getQuestionTypes() returns question types from dataset", async () => {
		const types = await getQuestionTypes();

		expect(types.length).toBeGreaterThan(0);
		expect(types.length).toBeLessThanOrEqual(6);
		// Check some expected question types exist
		const expectedTypes = [
			"temporal-reasoning",
			"multi-session",
			"knowledge-update",
			"single-session-user",
			"single-session-assistant",
			"single-session-preference",
		];
		for (const type of types) {
			expect(expectedTypes).toContain(type);
		}
	});

	test("getDatasetStats() returns correct statistics", async () => {
		const data = await loadLongMemEvalData();
		const stats = await getDatasetStats();

		expect(stats).toHaveProperty("total");
		expect(stats).toHaveProperty("byType");
		expect(stats.total).toBe(data.length);

		// All question types should be represented
		const questionTypes = Object.keys(stats.byType);
		expect(questionTypes.length).toBeLessThanOrEqual(6);
	});
});

// =============================================================================
// Metrics Tests
// =============================================================================

describe("LongMemEval metrics", () => {
	test("calculateScores() produces correct structure", () => {
		const scores = calculateScores(
			"temporal-reasoning",
			mockJudgeResult,
			mockRetrievalResults,
			["sess_001"],
			mockIngestionResult,
		);

		expect(scores).toHaveProperty("correctness");
		expect(scores).toHaveProperty("faithfulness");
		expect(scores).toHaveProperty("retrieval_precision");
		expect(scores).toHaveProperty("retrieval_recall");
		expect(scores).toHaveProperty("ingested_count");
		expect(scores).toHaveProperty("retrieved_count");
		expect(scores).toHaveProperty("top_retrieval_score");
	});

	test("calculateScores() calculates retrieval precision correctly", () => {
		const scores = calculateScores(
			"temporal-reasoning",
			mockJudgeResult,
			mockRetrievalResults,
			["sess_001"], // Only one of the two retrieved sessions is relevant
			mockIngestionResult,
		);

		// 1 relevant out of 2 retrieved = 0.5 precision
		expect(scores.retrieval_precision).toBe(0.5);
	});

	test("calculateScores() calculates retrieval recall correctly", () => {
		const scores = calculateScores(
			"temporal-reasoning",
			mockJudgeResult,
			mockRetrievalResults,
			["sess_001", "sess_003"], // 2 answer sessions, only 1 retrieved
			mockIngestionResult,
		);

		// 1 retrieved out of 2 answer sessions = 0.5 recall
		expect(scores.retrieval_recall).toBe(0.5);
	});

	test("calculateScores() adds type-specific scores for temporal-reasoning", () => {
		const scores = calculateScores(
			"temporal-reasoning",
			mockJudgeResult,
			mockRetrievalResults,
			["sess_001"],
			mockIngestionResult,
		);

		expect(scores.temporal_accuracy).toBe(0.8);
	});

	test("calculateScores() adds type-specific scores for multi-session", () => {
		const scores = calculateScores(
			"multi-session",
			mockJudgeResult,
			mockRetrievalResults,
			["sess_001"],
			mockIngestionResult,
		);

		expect(scores.aggregation_completeness).toBe(0.8);
	});

	test("determineStatus() returns pass for high scores", () => {
		const scores = calculateScores(
			"temporal-reasoning",
			{ correctness: 0.9, faithfulness: 0.85, reasoning: "Good" },
			mockRetrievalResults,
			["sess_001"],
			mockIngestionResult,
		);

		expect(determineStatus(scores)).toBe("pass");
	});

	test("determineStatus() returns fail for low correctness", () => {
		const scores = calculateScores(
			"temporal-reasoning",
			{ correctness: 0.5, faithfulness: 0.85, reasoning: "Partial" },
			mockRetrievalResults,
			["sess_001"],
			mockIngestionResult,
		);

		expect(determineStatus(scores)).toBe("fail");
	});

	test("determineStatus() returns fail for low faithfulness", () => {
		const scores = calculateScores(
			"temporal-reasoning",
			{ correctness: 0.9, faithfulness: 0.3, reasoning: "Hallucinated" },
			mockRetrievalResults,
			["sess_001"],
			mockIngestionResult,
		);

		expect(determineStatus(scores)).toBe("fail");
	});

	test("aggregateScores() calculates mean, min, max", () => {
		const scores1 = calculateScores(
			"temporal-reasoning",
			{ correctness: 0.9, faithfulness: 0.8, reasoning: "Good" },
			mockRetrievalResults,
			["sess_001"],
			mockIngestionResult,
		);

		const scores2 = calculateScores(
			"temporal-reasoning",
			{ correctness: 0.7, faithfulness: 0.6, reasoning: "OK" },
			mockRetrievalResults,
			["sess_001"],
			mockIngestionResult,
		);

		const aggregated = aggregateScores([scores1, scores2]);

		expect(aggregated.mean.correctness).toBe(0.8);
		expect(aggregated.min.correctness).toBe(0.7);
		expect(aggregated.max.correctness).toBe(0.9);
	});

	test("groupScoresByType() groups scores by question type", () => {
		const results = [
			{
				questionType: "temporal-reasoning" as QuestionType,
				scores: calculateScores(
					"temporal-reasoning",
					mockJudgeResult,
					mockRetrievalResults,
					["sess_001"],
					mockIngestionResult,
				),
			},
			{
				questionType: "multi-session" as QuestionType,
				scores: calculateScores(
					"multi-session",
					mockJudgeResult,
					mockRetrievalResults,
					["sess_001"],
					mockIngestionResult,
				),
			},
		];

		const grouped = groupScoresByType(results);

		expect(grouped["temporal-reasoning"].length).toBe(1);
		expect(grouped["multi-session"].length).toBe(1);
		expect(grouped["knowledge-update"].length).toBe(0);
	});
});

// =============================================================================
// Benchmark Registry Integration Tests
// =============================================================================

describe("LongMemEval benchmark registry", () => {
	test("LongMemEval benchmark loads successfully via registry", async () => {
		const registry = BenchmarkRegistry.getInstance();
		registry.reset();

		const result = await registry.initialize();

		const longMemEval = result.benchmarks.find(
			(b) => b.benchmark.meta.name === "LongMemEval",
		);

		expect(longMemEval).toBeDefined();
		expect(longMemEval?.benchmark.meta.version).toBe("1.0.0");
		expect(longMemEval?.benchmark.meta.required_capabilities).toEqual([
			"add_memory",
			"retrieve_memory",
		]);
	});

	test("LongMemEval benchmark meta includes description", async () => {
		const registry = BenchmarkRegistry.getInstance();
		registry.reset();

		await registry.initialize();

		const entry = registry.get("LongMemEval");
		expect(entry).toBeDefined();
		expect(entry?.benchmark.meta.description).toContain("LLM-as-judge");
		expect(entry?.benchmark.meta.description).toContain("6 question types");
	});

	test("LongMemEval cases() throws for async iteration requirement", async () => {
		const registry = BenchmarkRegistry.getInstance();
		registry.reset();

		await registry.initialize();

		const entry = registry.get("LongMemEval");
		expect(entry).toBeDefined();

		// cases() should throw because LongMemEval requires async iteration
		expect(() => {
			Array.from(entry!.benchmark.cases());
		}).toThrow("casesAsync");
	});
});

// =============================================================================
// Benchmark Async Cases Tests
// =============================================================================

describe("LongMemEval async cases", () => {
	test("getCasesAsync() returns BenchmarkCase array", async () => {
		const { getCasesAsync } = await import(
			"../../benchmarks/LongMemEval/benchmark"
		);

		const cases = await getCasesAsync();

		expect(Array.isArray(cases)).toBe(true);
		expect(cases.length).toBeGreaterThan(0);

		// Verify BenchmarkCase structure
		const firstCase = cases[0];
		expect(firstCase).toHaveProperty("id");
		expect(firstCase).toHaveProperty("description");
		expect(firstCase).toHaveProperty("input");
		expect(firstCase).toHaveProperty("expected");
		expect(firstCase).toHaveProperty("metadata");
	});

	test("BenchmarkCase metadata contains question type", async () => {
		const { getCasesAsync } = await import(
			"../../benchmarks/LongMemEval/benchmark"
		);

		const cases = await getCasesAsync();
		const firstCase = cases[0]!;

		expect(firstCase.metadata?.questionType).toBeDefined();
		expect(firstCase.metadata?.numSessions).toBeGreaterThan(0);
		expect(firstCase.metadata?.category).toBeDefined();
	});

	test("casesAsyncGenerator() yields BenchmarkCases", async () => {
		const { casesAsyncGenerator } = await import(
			"../../benchmarks/LongMemEval/benchmark"
		);

		let count = 0;
		const maxToCheck = 5;

		for await (const benchmarkCase of casesAsyncGenerator()) {
			expect(benchmarkCase).toHaveProperty("id");
			expect(benchmarkCase).toHaveProperty("description");
			count++;
			if (count >= maxToCheck) break;
		}

		expect(count).toBe(maxToCheck);
	});
});

// =============================================================================
// Serialization Tests
// =============================================================================

describe("LongMemEval serialization", () => {
	test("serializeItem and deserializeItem are inverse operations", async () => {
		const { serializeItem, deserializeItem } = await import(
			"../../benchmarks/LongMemEval/benchmark"
		);
		const data = await loadLongMemEvalData();
		const original = data[0]!;

		const serialized = serializeItem(original);
		const deserialized = deserializeItem(serialized);

		expect(deserialized.question_id).toBe(original.question_id);
		expect(deserialized.question_type).toBe(original.question_type);
		expect(deserialized.question).toBe(original.question);
		expect(deserialized.answer).toBe(original.answer);
		expect(deserialized.answer_session_ids).toEqual(
			original.answer_session_ids,
		);
	});
});
