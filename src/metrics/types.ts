/**
 * Shared Types for Metrics
 *
 * This module defines the interfaces for metrics calculations
 * used by data-driven benchmarks.
 *
 * @module src/metrics/types
 * @see specs/006-benchmark-interface/data-driven-benchmark-design.md
 */

import type { RetrievalItem } from "../../types/core";

/**
 * Retrieval quality metrics
 */
export interface RetrievalMetrics {
	/** Precision: relevant items in retrieved / total retrieved */
	precision: number;
	/** Recall: retrieved relevant items / total relevant items */
	recall: number;
	/** F1 score: harmonic mean of precision and recall */
	f1: number;
	/** Number of items retrieved */
	retrievedCount: number;
	/** Best match score from retrieval */
	topScore: number;
	/** Average score across all retrieved items */
	averageScore: number;
}

/**
 * Task success metrics
 */
export interface TaskMetrics {
	/** Overall correctness score (0-1) */
	correctness: number;
	/** Whether answer is grounded in evidence (0-1) */
	faithfulness: number;
	/** Type-specific score if applicable */
	typeSpecificScore?: number;
}

/**
 * Lifecycle metrics (for update/delete testing)
 */
export interface LifecycleMetrics {
	/** Success rate of deletion (deleted info NOT returned) */
	deletionSuccess: number;
	/** Performance retained on non-deleted content */
	retainUtility: number;
	/** Rate of deleted info leaking through queries */
	leakageRate: number;
}

/**
 * Aggregate statistics across multiple runs
 */
export interface AggregateStats<T> {
	/** Mean values */
	mean: Partial<T>;
	/** Minimum values */
	min: Partial<T>;
	/** Maximum values */
	max: Partial<T>;
	/** Standard deviation */
	stdDev?: Partial<T>;
	/** Count of samples */
	count: number;
}

/**
 * Context for metrics calculation
 */
export interface MetricsContext {
	/** Items retrieved from memory */
	retrievalResults: RetrievalItem[];
	/** IDs of relevant items (ground truth) */
	relevantIds: string[];
	/** Total number of items that could be retrieved */
	totalRelevantCount?: number;
}

/**
 * ID extractor function type
 * Used to extract an ID from retrieved content
 */
export type IdExtractor = (content: string) => string | null;
