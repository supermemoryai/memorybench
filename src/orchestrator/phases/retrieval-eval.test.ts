import { test, expect } from "bun:test"
import type { LanguageModel } from "ai"
import { calculateRetrievalMetrics } from "./retrieval-eval"

// A minimal LanguageModelV2 stub. `ai/test`'s MockLanguageModelV2 would do this for us but it
// pulls in msw, which isn't a dependency of this project — and a hand-rolled stub is 10 lines.
function stubJudge(respond: () => string): LanguageModel {
  return {
    specificationVersion: "v2",
    provider: "stub",
    modelId: "stub-judge",
    supportedUrls: {},
    doGenerate: async () => ({
      content: [{ type: "text" as const, text: respond() }],
      finishReason: "stop" as const,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
    }),
    doStream: async () => {
      throw new Error("not used")
    },
  } as unknown as LanguageModel
}

const judgeReturning = (text: string) => stubJudge(() => text)
const judgeThatFails = () =>
  stubJudge(() => {
    throw new Error("429 rate limited")
  })

const RESULTS = [{ chunk: "a" }, { chunk: "b" }, { chunk: "c" }, { chunk: "d" }]

test("reports only metrics that are well defined without ground-truth relevance counts", async () => {
  // 2nd and 4th results relevant.
  const judge = judgeReturning(
    JSON.stringify([
      { id: "result_1", relevant: 0 },
      { id: "result_2", relevant: 1 },
      { id: "result_3", relevant: 0 },
      { id: "result_4", relevant: 1 },
    ])
  )

  const metrics = await calculateRetrievalMetrics(judge, "q", "gt", RESULTS)

  expect(metrics).toEqual({
    hitAtK: 1,
    precisionAtK: 0.5,
    mrr: 0.5, // first relevant at rank 2
    k: 4,
    relevantRetrieved: 2,
  })
  // The degenerate trio must not come back: recall was identical to hitAtK by construction,
  // F1 was a re-encoding of precision, and NDCG's ideal set was built from what was found.
  for (const gone of ["recallAtK", "f1AtK", "ndcg", "totalRelevant"]) {
    expect(metrics).not.toHaveProperty(gone)
  }
})

test("precision and MRR distinguish rankings that the old NDCG scored identically", async () => {
  // Old behaviour: IDCG was built from the retrieved relevant count, so "one relevant at rank 1"
  // and "four relevant at ranks 1-4" both scored NDCG 1.0 and recall 100%.
  const onlyFirst = await calculateRetrievalMetrics(
    judgeReturning(
      JSON.stringify([
        { id: "result_1", relevant: 1 },
        { id: "result_2", relevant: 0 },
        { id: "result_3", relevant: 0 },
        { id: "result_4", relevant: 0 },
      ])
    ),
    "q",
    "gt",
    RESULTS
  )
  const allFour = await calculateRetrievalMetrics(
    judgeReturning(
      JSON.stringify([
        { id: "result_1", relevant: 1 },
        { id: "result_2", relevant: 1 },
        { id: "result_3", relevant: 1 },
        { id: "result_4", relevant: 1 },
      ])
    ),
    "q",
    "gt",
    RESULTS
  )

  // Both "hit" and both rank a relevant result first, so those two agree...
  expect(onlyFirst!.hitAtK).toBe(allFour!.hitAtK)
  expect(onlyFirst!.mrr).toBe(allFour!.mrr)
  // ...but precision now separates them, which is the only honest signal available here.
  expect(onlyFirst!.precisionAtK).toBe(0.25)
  expect(allFour!.precisionAtK).toBe(1)
})

test("a judge failure yields no metrics instead of a zero score", async () => {
  // Coercing a rate-limit or timeout to relevant:0 was indistinguishable from "retrieved
  // nothing useful" and quietly dragged the provider's retrieval numbers down.
  const metrics = await calculateRetrievalMetrics(judgeThatFails(), "q", "gt", RESULTS)

  expect(metrics).toBeUndefined()
})

test("an unparseable judge response yields no metrics", async () => {
  const metrics = await calculateRetrievalMetrics(
    judgeReturning("I'm afraid I can't help with that."),
    "q",
    "gt",
    RESULTS
  )

  expect(metrics).toBeUndefined()
})

test("retrieving nothing is a real zero, not a missing measurement", async () => {
  const metrics = await calculateRetrievalMetrics(judgeReturning("[]"), "q", "gt", [])

  expect(metrics).toEqual({ hitAtK: 0, precisionAtK: 0, mrr: 0, k: 0, relevantRetrieved: 0 })
})
