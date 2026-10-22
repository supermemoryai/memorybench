
import { describe, expect, test } from "bun:test"
import { aggregateRetrievalMetrics } from "./report"
import type { RetrievalMetrics } from "../../types/unified"

function metric(k: number, retrievedCount: number): RetrievalMetrics {
  return {
    hitAtK: 0,
    precisionAtK: 0,
    recallAtK: 0,
    f1AtK: 0,
    mrr: 0,
    ndcg: 0,
    k,
    retrievedCount,
    relevantRetrieved: 0,
    totalRelevant: 1,
  }
}

describe("aggregateRetrievalMetrics", () => {
  test("preserves configured K when questions return different result counts", () => {
    const emptyThenFull = aggregateRetrievalMetrics([
      metric(10, 0),
      metric(10, 10),
    ])

    const fullThenEmpty = aggregateRetrievalMetrics([
      metric(10, 10),
      metric(10, 0),
    ])

    expect(emptyThenFull?.k).toBe(10)
    expect(fullThenEmpty?.k).toBe(10)
    expect(emptyThenFull?.underfilledCount).toBe(1)
    expect(fullThenEmpty?.underfilledCount).toBe(1)
  })

  test("uses the highest K when metrics have different cutoffs", () => {
    const result = aggregateRetrievalMetrics([
      metric(5, 5),
      metric(10, 8),
    ])

    expect(result?.k).toBe(10)
    expect(result?.underfilledCount).toBe(1)
  })

  test("returns undefined for no metrics", () => {
    expect(aggregateRetrievalMetrics([])).toBeUndefined()
  })
})
