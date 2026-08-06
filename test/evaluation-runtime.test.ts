import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { Judge } from "../src/types/judge"
import {
  JudgeEvaluationRuntime,
  executeStructuredWithRetries,
  type StructuredGenerationExecutor,
} from "../src/orchestrator/evaluation-runtime"

const schema = z.object({ score: z.union([z.literal(0), z.literal(0.5), z.literal(1)]) }).strict()

const fakeJudge = {
  name: "fake",
  async initialize() {},
  async evaluate() {
    return { score: 1, label: "correct" as const, explanation: "fixture" }
  },
  getPromptForQuestionType() {
    return "fixture"
  },
  getModel() {
    throw new Error("The injected structured executor should not request a model")
  },
} satisfies Judge

describe("structured evaluation runtime", () => {
  test("retries malformed structured output and preserves a later valid half score", async () => {
    const outputs: unknown[] = [{ score: "0.5" }, { score: 0.75 }, { score: 0.5 }]
    let calls = 0
    const result = await executeStructuredWithRetries(
      {
        schema,
        schemaName: "fixture_score",
        prompt: "score this",
        maxAttempts: 3,
      },
      async () => {
        calls += 1
        return outputs.shift()
      }
    )

    expect(result).toEqual({ score: 0.5 })
    expect(calls).toBe(3)
  })

  test("fails explicitly after exhausting schema-invalid output", async () => {
    let calls = 0
    await expect(
      executeStructuredWithRetries(
        {
          schema,
          schemaName: "fixture_score",
          prompt: "score this",
          maxAttempts: 2,
        },
        async () => {
          calls += 1
          return { score: "1.0 contains 0.5" }
        }
      )
    ).rejects.toThrow("failed after 2 attempts")
    expect(calls).toBe(2)
  })

  test("counts every retry and records complete, partial, and unknown token coverage", async () => {
    const paidFailure = Object.assign(new Error("provider rejected structured output"), {
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    })
    const attempts: Array<{ object: unknown; usage?: unknown } | { error: Error }> = [
      { error: paidFailure },
      { object: { score: "invalid" }, usage: { inputTokens: 3 } },
      { error: new Error("transport failed without usage") },
      {
        object: { score: 0.5 },
        usage: { inputTokens: 7, outputTokens: 1, totalTokens: 8 },
      },
    ]
    const executor: StructuredGenerationExecutor = async () => {
      const attempt = attempts.shift()!
      if ("error" in attempt) throw attempt.error
      return attempt
    }
    const runtime = new JudgeEvaluationRuntime(fakeJudge, executor)

    const result = await runtime.generateStructured({
      schema,
      schemaName: "usage_retry_fixture",
      prompt: "score this",
      maxAttempts: 4,
    })

    expect(result).toEqual({ score: 0.5 })
    expect(runtime.getUsage()).toEqual({
      requestCount: 4,
      tokenUsageCompleteRequestCount: 2,
      tokenUsagePartialRequestCount: 1,
      tokenUsageUnknownRequestCount: 1,
      inputTokens: 20,
      outputTokens: 3,
      totalTokens: 20,
    })
  })

  test("retains unknown paid-attempt coverage after terminal failure", async () => {
    const executor: StructuredGenerationExecutor = async () => {
      throw new Error("timeout without usage")
    }
    const runtime = new JudgeEvaluationRuntime(fakeJudge, executor)

    await expect(
      runtime.generateStructured({
        schema,
        schemaName: "terminal_failure_fixture",
        prompt: "score this",
        maxAttempts: 2,
      })
    ).rejects.toThrow("failed after 2 attempts")
    expect(runtime.getUsage()).toEqual({
      requestCount: 2,
      tokenUsageUnknownRequestCount: 2,
    })
  })
})
