/**
 * Retrieval Quality Metrics
 *
 * Calculates precision, recall, F1, and other retrieval metrics
 * for evaluating memory system search quality.
 *
 * Extracted from: benchmarks/LongMemEval/metrics.ts
 *
 * @module src/metrics/retrieval
 * @see specs/006-benchmark-interface/data-driven-benchmark-design.md
 */

import type { RetrievalItem } from "../../types/core";
import type {
	AggregateStats,
	IdExtractor,
	MetricsContext,
	RetrievalMetrics,
} from "./types";

/**
 * Default ID extractor - looks for "Session: <id>" pattern
 * This pattern is used by LongMemEval session formatting
 */
export const defaultIdExtractor: IdExtractor = (content: string) => {
	const match = content.match(/=== Session: ([^\s=]+) ===/);
	return match?.[1] ?? null;
};

/**
 * Simple ID extractor - returns the record ID
 */
export const recordIdExtractor: IdExtractor = (_content: string) => {
	// This is used when the record.id directly corresponds to relevance
	return null; // Signal to use record.id instead
};

/**
 * Extract IDs from retrieval results using a custom extractor
 *
 * @param results - Retrieval results to extract IDs from
 * @param extractor - Function to extract ID from content
 * @returns Array of extracted IDs
 */
export function extractIds(
	results: RetrievalItem[],
	extractor: IdExtractor = defaultIdExtractor,
): string[] {
	const ids: string[] = [];

	for (const result of results) {
		const extractedId = extractor(result.record.context);
		if (extractedId) {
			ids.push(extractedId);
		} else {
			// Fall back to record ID
			ids.push(result.record.id);
		}
	}

	return ids;
}

/**
 * Calculate retrieval metrics
 *
 * @param context - Metrics context with retrieval results and relevant IDs
 * @param idExtractor - Function to extract IDs from content (optional)
 * @returns Retrieval quality metrics
 *
 * @example
 * ```typescript
 * const metrics = calculateRetrievalMetrics({
 *   retrievalResults: results,
 *   relevantIds: ["session_1", "session_5", "session_10"]
 * });
 *
 * console.log(`Precision: ${metrics.precision}, Recall: ${metrics.recall}`);
 * ```
 */
export function calculateRetrievalMetrics(
	context: MetricsContext,
	idExtractor: IdExtractor = defaultIdExtractor,
): RetrievalMetrics {
	const { retrievalResults, relevantIds } = context;

	if (retrievalResults.length === 0) {
		return {
			precision: 0,
			recall: 0,
			f1: 0,
			retrievedCount: 0,
			topScore: 0,
			averageScore: 0,
		};
	}

	// Extract IDs from retrieved results
	const retrievedIds = extractIds(retrievalResults, idExtractor);

	// Calculate relevant items in retrieved set
	const relevantRetrieved = retrievedIds.filter((id) =>
		relevantIds.includes(id),
	);

	// Calculate precision and recall
	const precision =
		retrievalResults.length > 0
			? relevantRetrieved.length / retrievalResults.length
			: 0;

	const totalRelevant = context.totalRelevantCount ?? relevantIds.length;
	const recall =
		totalRelevant > 0 ? relevantRetrieved.length / totalRelevant : 0;

	// Calculate F1 score
	const f1 =
		precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

	// Calculate score statistics
	const scores = retrievalResults.map((r) => r.score);
	const topScore = Math.max(...scores, 0);
	const averageScore =
		scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

	return {
		precision,
		recall,
		f1,
		retrievedCount: retrievalResults.length,
		topScore,
		averageScore,
	};
}

/**
 * Calculate recall at K
 *
 * @param retrievalResults - All retrieval results
 * @param relevantIds - IDs of relevant items
 * @param k - Number of top results to consider
 * @param idExtractor - Function to extract IDs from content
 * @returns Recall@K value (0-1)
 */
export function recallAtK(
	retrievalResults: RetrievalItem[],
	relevantIds: string[],
	k: number,
	idExtractor: IdExtractor = defaultIdExtractor,
): number {
	const topK = retrievalResults.slice(0, k);
	const retrievedIds = extractIds(topK, idExtractor);

	const relevantRetrieved = retrievedIds.filter((id) =>
		relevantIds.includes(id),
	);

	return relevantIds.length > 0
		? relevantRetrieved.length / relevantIds.length
		: 0;
}

/**
 * Calculate precision at K
 *
 * @param retrievalResults - All retrieval results
 * @param relevantIds - IDs of relevant items
 * @param k - Number of top results to consider
 * @param idExtractor - Function to extract IDs from content
 * @returns Precision@K value (0-1)
 */
export function precisionAtK(
	retrievalResults: RetrievalItem[],
	relevantIds: string[],
	k: number,
	idExtractor: IdExtractor = defaultIdExtractor,
): number {
	const topK = retrievalResults.slice(0, k);
	const retrievedIds = extractIds(topK, idExtractor);

	const relevantRetrieved = retrievedIds.filter((id) =>
		relevantIds.includes(id),
	);

	return topK.length > 0 ? relevantRetrieved.length / topK.length : 0;
}

/**
 * Calculate normalized Discounted Cumulative Gain (nDCG)
 *
 * @param retrievalResults - All retrieval results
 * @param relevantIds - IDs of relevant items (all considered equally relevant)
 * @param k - Number of top results to consider
 * @param idExtractor - Function to extract IDs from content
 * @returns nDCG@K value (0-1)
 */
export function ndcgAtK(
	retrievalResults: RetrievalItem[],
	relevantIds: string[],
	k: number,
	idExtractor: IdExtractor = defaultIdExtractor,
): number {
	const topK = retrievalResults.slice(0, k);
	const retrievedIds = extractIds(topK, idExtractor);

	// Calculate DCG
	let dcg = 0;
	for (let i = 0; i < retrievedIds.length; i++) {
		const isRelevant = relevantIds.includes(retrievedIds[i]!) ? 1 : 0;
		dcg += isRelevant / Math.log2(i + 2); // +2 because log2(1) = 0
	}

	// Calculate ideal DCG
	const idealK = Math.min(relevantIds.length, k);
	let idcg = 0;
	for (let i = 0; i < idealK; i++) {
		idcg += 1 / Math.log2(i + 2);
	}

	return idcg > 0 ? dcg / idcg : 0;
}

/**
 * Calculate Mean Average Precision (MAP)
 * For a single query, this is Average Precision (AP)
 *
 * @param retrievalResults - All retrieval results
 * @param relevantIds - IDs of relevant items
 * @param idExtractor - Function to extract IDs from content
 * @returns Average Precision value (0-1)
 */
export function averagePrecision(
	retrievalResults: RetrievalItem[],
	relevantIds: string[],
	idExtractor: IdExtractor = defaultIdExtractor,
): number {
	const retrievedIds = extractIds(retrievalResults, idExtractor);

	let relevantSoFar = 0;
	let sumPrecision = 0;

	for (let i = 0; i < retrievedIds.length; i++) {
		if (relevantIds.includes(retrievedIds[i]!)) {
			relevantSoFar++;
			sumPrecision += relevantSoFar / (i + 1);
		}
	}

	return relevantIds.length > 0 ? sumPrecision / relevantIds.length : 0;
}

/**
 * Aggregate metrics across multiple runs
 *
 * @param allMetrics - Array of retrieval metrics from multiple runs
 * @returns Aggregate statistics (mean, min, max)
 */
export function aggregateRetrievalMetrics(
	allMetrics: RetrievalMetrics[],
): AggregateStats<RetrievalMetrics> {
	if (allMetrics.length === 0) {
		return { mean: {}, min: {}, max: {}, count: 0 };
	}

	const keys: (keyof RetrievalMetrics)[] = [
		"precision",
		"recall",
		"f1",
		"retrievedCount",
		"topScore",
		"averageScore",
	];

	const mean: Partial<RetrievalMetrics> = {};
	const min: Partial<RetrievalMetrics> = {};
	const max: Partial<RetrievalMetrics> = {};

	for (const key of keys) {
		const values = allMetrics.map((m) => m[key]);
		(mean as Record<string, number>)[key] =
			values.reduce((a, b) => a + b, 0) / values.length;
		(min as Record<string, number>)[key] = Math.min(...values);
		(max as Record<string, number>)[key] = Math.max(...values);
	}

	return { mean, min, max, count: allMetrics.length };
}
