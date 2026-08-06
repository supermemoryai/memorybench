import { describe, expect, test } from "bun:test"
import type { JudgeInput, JudgeResult } from "../src/types/judge"
import type { EvaluationRuntime, StructuredModelRequest } from "../src/types/protocol"
import type { UnifiedSearchResult } from "../src/types/unified"
import {
  calculateProtocolRetrievalMetrics,
  calculateRetrievalMetrics,
} from "../src/orchestrator/phases/retrieval-eval"

class RetrievalRuntime implements EvaluationRuntime {
  readonly requests: StructuredModelRequest<unknown>[] = []

  constructor(
    private readonly output: unknown,
    private readonly failure?: Error
  ) {}

  async evaluateLegacy(_input: JudgeInput): Promise<JudgeResult> {
    throw new Error("Legacy answer evaluation is not expected")
  }

  async generateStructured<T>(request: StructuredModelRequest<T>): Promise<T> {
    this.requests.push(request as StructuredModelRequest<unknown>)
    if (this.failure) throw this.failure
    return request.schema.parse(this.output)
  }
}

function results(): UnifiedSearchResult[] {
  return [
    {
      id: "one",
      rank: 1,
      text: "Unrelated normalized text",
      provider: "supermemory",
      resultType: "memory",
      rawArtifactRef: "debug/secret-raw-result.json",
    },
    {
      id: "two",
      rank: 2,
      text: "Vedant moved to Pune.",
      score: 0.9,
      sessionId: "session-2",
      documentDate: "2025-01-02",
      provider: "supermemory",
      resultType: "chunk",
    },
  ]
}

describe("protocol-owned retrieval relevance diagnostics", () => {
  test("does not run the non-paper auxiliary judge for BEAM", async () => {
    const runtime = new RetrievalRuntime(undefined, new Error("must not be called"))
    const metrics = await calculateProtocolRetrievalMetrics(
      "disabled",
      runtime,
      "Where did Vedant move?",
      "Pune",
      results(),
      2
    )

    expect(metrics).toBeUndefined()
    expect(runtime.requests).toHaveLength(0)
  })

  test("uses structured runtime output and only normalized prompt fields for legacy diagnostics", async () => {
    const runtime = new RetrievalRuntime({
      results: [
        { id: "result_1", relevant: 0 },
        { id: "result_2", relevant: 1 },
      ],
    })
    const metrics = await calculateRetrievalMetrics(
      runtime,
      "Where did Vedant move?",
      "Pune",
      results(),
      2
    )

    expect(metrics).toMatchObject({
      hitAtK: 1,
      precisionAtK: 0.5,
      recallAtK: 1,
      mrr: 0.5,
      k: 2,
      relevantRetrieved: 1,
    })
    expect(runtime.requests).toHaveLength(1)
    expect(runtime.requests[0]?.schemaName).toBe("legacy_retrieval_relevance")
    expect(runtime.requests[0]?.prompt).toContain("Vedant moved to Pune.")
    expect(runtime.requests[0]?.prompt).not.toContain("secret-raw-result")
  })

  test("fails on mismatched IDs and propagates judge errors instead of fabricating zeros", async () => {
    const mismatched = new RetrievalRuntime({
      results: [
        { id: "result_2", relevant: 0 },
        { id: "result_1", relevant: 1 },
      ],
    })
    await expect(
      calculateRetrievalMetrics(mismatched, "question", "answer", results(), 2)
    ).rejects.toThrow("output ID mismatch")

    const failed = new RetrievalRuntime(undefined, new Error("judge unavailable"))
    await expect(
      calculateRetrievalMetrics(failed, "question", "answer", results(), 2)
    ).rejects.toThrow("judge unavailable")
  })
})
