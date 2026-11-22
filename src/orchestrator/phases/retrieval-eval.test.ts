import { expect, test } from "bun:test"
import type { LanguageModel } from "ai"
import { calculateRetrievalMetrics } from "./retrieval-eval"

type TestJudge = Exclude<LanguageModel, string>

function fakeJudge(doGenerate: TestJudge["doGenerate"]): TestJudge {
  return {
    specificationVersion: "v2",
    provider: "test",
    modelId: "test",
    supportedUrls: {},
    doGenerate,
    async doStream() {
      throw new Error("Unexpected streaming call")
    },
  }
}

function judgeReturning(text: string): TestJudge {
  return fakeJudge(async () => ({
    content: [{ type: "text", text }],
    finishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    warnings: [],
  }))
}

const results = ["First result", "Second result"]

test.each([
  "No verdict",
  "[truncated",
  "[invalid]",
  '[{"id":"result_1","relevant":1}]',
  '[{"id":"result_1","relevant":1},{"id":"result_1","relevant":0}]',
  '[{"id":"result_1","relevant":1},{"id":"result_3","relevant":0}]',
  '[{"id":"result_1","relevant":1},{"id":"result_2","relevant":2}]',
])("does not score incomplete or invalid verdicts: %s", async (text) => {
  await expect(
    calculateRetrievalMetrics(judgeReturning(text), "Question", "Answer", results)
  ).rejects.toThrow()
})

test("surfaces a judge transport failure", async () => {
  const judge = fakeJudge(async () => {
    throw new Error("Judge unavailable")
  })
  await expect(calculateRetrievalMetrics(judge, "Question", "Answer", results)).rejects.toThrow(
    "Judge unavailable"
  )
})

test("uses result order, rather than response order, to compute reciprocal rank", async () => {
  const judge = judgeReturning('[{"id":"result_2","relevant":1},{"id":"result_1","relevant":0}]')
  const metrics = await calculateRetrievalMetrics(judge, "Question", "Answer", results)
  expect(metrics).toMatchObject({ hitAtK: 1, precisionAtK: 0.5, mrr: 0.5 })
})

test("valid irrelevant verdicts still count as a retrieval miss", async () => {
  const judge = judgeReturning('[{"id":"result_1","relevant":0},{"id":"result_2","relevant":0}]')
  const metrics = await calculateRetrievalMetrics(judge, "Question", "Answer", results)
  expect(metrics).toMatchObject({ hitAtK: 0, precisionAtK: 0, mrr: 0 })
})
