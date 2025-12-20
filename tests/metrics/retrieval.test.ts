/**
 * Tests for retrieval metrics
 *
 * @see src/metrics/retrieval.ts
 */

import { describe, expect, test } from "bun:test";
import type { RetrievalItem } from "../../types/core";
import {
	averagePrecision,
	calculateRetrievalMetrics,
	extractIds,
	ndcgAtK,
	precisionAtK,
	recallAtK,
} from "../../src/metrics/retrieval";

/**
 * Create a mock retrieval item
 */
function mockRetrievalItem(
	id: string,
	context: string,
	score: number,
): RetrievalItem {
	return {
		record: {
			id,
			context,
			timestamp: Date.now(),
		},
		score,
	};
}

describe("extractIds", () => {
	test("extracts session IDs from LongMemEval format", () => {
		const results: RetrievalItem[] = [
			mockRetrievalItem("r1", "=== Session: session_1 ===\nContent", 0.9),
			mockRetrievalItem("r2", "=== Session: session_5 ===\nContent", 0.8),
		];

		const ids = extractIds(results);

		expect(ids).toEqual(["session_1", "session_5"]);
	});

	test("falls back to record ID when pattern not found", () => {
		const results: RetrievalItem[] = [
			mockRetrievalItem("r1", "Plain content without session", 0.9),
		];

		const ids = extractIds(results);

		expect(ids).toEqual(["r1"]);
	});

	test("uses custom extractor when provided", () => {
		const results: RetrievalItem[] = [
			mockRetrievalItem("r1", "DOC:doc_123", 0.9),
		];

		const customExtractor = (content: string) => {
			const match = content.match(/DOC:(\w+)/);
			return match?.[1] ?? null;
		};

		const ids = extractIds(results, customExtractor);

		expect(ids).toEqual(["doc_123"]);
	});
});

describe("calculateRetrievalMetrics", () => {
	test("returns zero metrics for empty results", () => {
		const metrics = calculateRetrievalMetrics({
			retrievalResults: [],
			relevantIds: ["id1", "id2"],
		});

		expect(metrics.precision).toBe(0);
		expect(metrics.recall).toBe(0);
		expect(metrics.f1).toBe(0);
		expect(metrics.retrievedCount).toBe(0);
		expect(metrics.topScore).toBe(0);
	});

	test("calculates perfect precision when all retrieved are relevant", () => {
		const results: RetrievalItem[] = [
			mockRetrievalItem("r1", "=== Session: s1 ===", 0.9),
			mockRetrievalItem("r2", "=== Session: s2 ===", 0.8),
		];

		const metrics = calculateRetrievalMetrics({
			retrievalResults: results,
			relevantIds: ["s1", "s2", "s3"],
		});

		expect(metrics.precision).toBe(1.0);
		expect(metrics.recall).toBeCloseTo(2 / 3, 5);
	});

	test("calculates precision when some retrieved are not relevant", () => {
		const results: RetrievalItem[] = [
			mockRetrievalItem("r1", "=== Session: s1 ===", 0.9),
			mockRetrievalItem("r2", "=== Session: s2 ===", 0.8),
			mockRetrievalItem("r3", "=== Session: s99 ===", 0.7), // not relevant
		];

		const metrics = calculateRetrievalMetrics({
			retrievalResults: results,
			relevantIds: ["s1", "s2"],
		});

		expect(metrics.precision).toBeCloseTo(2 / 3, 5);
		expect(metrics.recall).toBe(1.0);
	});

	test("calculates F1 score correctly", () => {
		const results: RetrievalItem[] = [
			mockRetrievalItem("r1", "=== Session: s1 ===", 0.9),
			mockRetrievalItem("r2", "=== Session: s2 ===", 0.8),
		];

		const metrics = calculateRetrievalMetrics({
			retrievalResults: results,
			relevantIds: ["s1", "s2", "s3", "s4"], // 4 relevant, 2 retrieved
		});

		// precision = 1.0 (2/2), recall = 0.5 (2/4)
		// F1 = 2 * 1.0 * 0.5 / (1.0 + 0.5) = 0.667
		expect(metrics.f1).toBeCloseTo(2 / 3, 5);
	});

	test("calculates score statistics", () => {
		const results: RetrievalItem[] = [
			mockRetrievalItem("r1", "=== Session: s1 ===", 0.9),
			mockRetrievalItem("r2", "=== Session: s2 ===", 0.7),
			mockRetrievalItem("r3", "=== Session: s3 ===", 0.5),
		];

		const metrics = calculateRetrievalMetrics({
			retrievalResults: results,
			relevantIds: ["s1", "s2", "s3"],
		});

		expect(metrics.topScore).toBe(0.9);
		expect(metrics.averageScore).toBeCloseTo(0.7, 5);
		expect(metrics.retrievedCount).toBe(3);
	});
});

describe("recallAtK", () => {
	test("calculates recall for top K items", () => {
		const results: RetrievalItem[] = [
			mockRetrievalItem("r1", "=== Session: s1 ===", 0.9),
			mockRetrievalItem("r2", "=== Session: s99 ===", 0.8), // not relevant
			mockRetrievalItem("r3", "=== Session: s2 ===", 0.7),
			mockRetrievalItem("r4", "=== Session: s3 ===", 0.6),
		];

		const relevantIds = ["s1", "s2", "s3"];

		// At K=1, only s1 is in top 1
		expect(recallAtK(results, relevantIds, 1)).toBeCloseTo(1 / 3, 5);

		// At K=2, s1 is relevant, s99 is not
		expect(recallAtK(results, relevantIds, 2)).toBeCloseTo(1 / 3, 5);

		// At K=3, s1 and s2 are relevant
		expect(recallAtK(results, relevantIds, 3)).toBeCloseTo(2 / 3, 5);

		// At K=4, all 3 relevant are found
		expect(recallAtK(results, relevantIds, 4)).toBe(1.0);
	});
});

describe("precisionAtK", () => {
	test("calculates precision for top K items", () => {
		const results: RetrievalItem[] = [
			mockRetrievalItem("r1", "=== Session: s1 ===", 0.9),
			mockRetrievalItem("r2", "=== Session: s99 ===", 0.8), // not relevant
			mockRetrievalItem("r3", "=== Session: s2 ===", 0.7),
		];

		const relevantIds = ["s1", "s2"];

		// At K=1, 1/1 is relevant
		expect(precisionAtK(results, relevantIds, 1)).toBe(1.0);

		// At K=2, 1/2 is relevant
		expect(precisionAtK(results, relevantIds, 2)).toBe(0.5);

		// At K=3, 2/3 are relevant
		expect(precisionAtK(results, relevantIds, 3)).toBeCloseTo(2 / 3, 5);
	});
});

describe("ndcgAtK", () => {
	test("returns 1.0 for perfect ranking", () => {
		const results: RetrievalItem[] = [
			mockRetrievalItem("r1", "=== Session: s1 ===", 0.9),
			mockRetrievalItem("r2", "=== Session: s2 ===", 0.8),
		];

		const relevantIds = ["s1", "s2"];

		// All relevant items at top positions
		expect(ndcgAtK(results, relevantIds, 2)).toBe(1.0);
	});

	test("penalizes relevant items at lower positions", () => {
		const results: RetrievalItem[] = [
			mockRetrievalItem("r1", "=== Session: s99 ===", 0.9), // not relevant
			mockRetrievalItem("r2", "=== Session: s1 ===", 0.8), // relevant at pos 2
		];

		const relevantIds = ["s1"];

		// DCG = 0 + 1/log2(3) = 0.63
		// IDCG = 1/log2(2) = 1.0
		// nDCG = 0.63 / 1.0 = 0.63
		const ndcg = ndcgAtK(results, relevantIds, 2);
		expect(ndcg).toBeLessThan(1.0);
		expect(ndcg).toBeGreaterThan(0.5);
	});

	test("returns 0 for no relevant items", () => {
		const results: RetrievalItem[] = [
			mockRetrievalItem("r1", "=== Session: s99 ===", 0.9),
		];

		expect(ndcgAtK(results, ["s1"], 1)).toBe(0);
	});
});

describe("averagePrecision", () => {
	test("calculates AP for perfect ranking", () => {
		const results: RetrievalItem[] = [
			mockRetrievalItem("r1", "=== Session: s1 ===", 0.9),
			mockRetrievalItem("r2", "=== Session: s2 ===", 0.8),
		];

		const relevantIds = ["s1", "s2"];

		// AP = (1/1 + 2/2) / 2 = 1.0
		expect(averagePrecision(results, relevantIds)).toBe(1.0);
	});

	test("calculates AP with non-relevant items interspersed", () => {
		const results: RetrievalItem[] = [
			mockRetrievalItem("r1", "=== Session: s1 ===", 0.9), // relevant
			mockRetrievalItem("r2", "=== Session: s99 ===", 0.8), // not relevant
			mockRetrievalItem("r3", "=== Session: s2 ===", 0.7), // relevant
		];

		const relevantIds = ["s1", "s2"];

		// Precision at s1 (pos 1): 1/1 = 1.0
		// Precision at s2 (pos 3): 2/3 = 0.67
		// AP = (1.0 + 0.67) / 2 = 0.83
		const ap = averagePrecision(results, relevantIds);
		expect(ap).toBeCloseTo((1 + 2 / 3) / 2, 5);
	});

	test("returns 0 when no relevant items found", () => {
		const results: RetrievalItem[] = [
			mockRetrievalItem("r1", "=== Session: s99 ===", 0.9),
		];

		expect(averagePrecision(results, ["s1", "s2"])).toBe(0);
	});
});
