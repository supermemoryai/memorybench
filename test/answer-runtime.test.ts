import { describe, expect, test } from "bun:test"
import {
  aggregateAnswerAttemptUsage,
  generateAnswerWithRetries,
  normalizeAnsweringUsage,
  shouldRunAnswerPhase,
} from "../src/orchestrator/phases/answer"
import type { AnswerAttemptMetrics } from "../src/types/checkpoint"
import { hasEvaluableAnswer } from "../src/orchestrator/phases/evaluate"
import { resolveAnsweringRuntimeIdentity } from "../src/utils/models"

describe("answering runtime identity and usage", () => {
  test("resolves the effective model defaults instead of persisting only an alias", () => {
    expect(resolveAnsweringRuntimeIdentity("gpt-4.1-mini")).toEqual({
      schemaVersion: 1,
      transport: "ai-sdk-generate-text-v1",
      modelAlias: "gpt-4.1-mini",
      provider: "openai",
      modelId: "gpt-4.1-mini",
      supportsTemperature: true,
      effectiveDefaultTemperature: 0,
      effectiveDefaultMaxOutputTokens: 1000,
    })

    expect(resolveAnsweringRuntimeIdentity("gpt-5").effectiveDefaultTemperature).toBeNull()
  })

  test("retains generateText token usage and derives a missing total", () => {
    expect(
      normalizeAnsweringUsage({ inputTokens: 120, outputTokens: 30, totalTokens: 150 })
    ).toEqual({ requestCount: 1, inputTokens: 120, outputTokens: 30, totalTokens: 150 })
    expect(normalizeAnsweringUsage({ inputTokens: 10, outputTokens: 2 })).toEqual({
      requestCount: 1,
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
    })
  })

  test("retries empty and failed answers with durable attempt usage", async () => {
    const attempts: AnswerAttemptMetrics[] = []
    const delays: number[] = []
    const scripted = [
      {
        text: "",
        finishReason: "length",
        usage: { inputTokens: 10, outputTokens: 2, reasoningTokens: 2, totalTokens: 12 },
      },
      new Error("transport failed"),
      {
        text: " final answer ",
        finishReason: "stop",
        usage: { inputTokens: 11, outputTokens: 3, reasoningTokens: 1, totalTokens: 14 },
      },
    ]

    const outcome = await generateAnswerWithRetries({
      maxAttempts: 5,
      timeoutMs: 120_000,
      retryBackoffMs: 2_000,
      execute: async () => {
        const next = scripted.shift()!
        if (next instanceof Error) throw next
        return next
      },
      onAttempt: (attempt) => {
        const index = attempts.findIndex((candidate) => candidate.attempt === attempt.attempt)
        if (index >= 0) attempts[index] = attempt
        else attempts.push(attempt)
      },
      sleep: async (delayMs) => {
        delays.push(delayMs)
      },
    })

    expect(outcome).toEqual({ hypothesis: "final answer", terminalEmptyAccepted: false })
    expect(delays).toEqual([2_000, 4_000])
    expect(attempts.map(({ status, error }) => ({ status, error }))).toEqual([
      { status: "failed", error: "Answering model returned an empty hypothesis" },
      { status: "failed", error: "transport failed" },
      { status: "completed", error: undefined },
    ])
    expect(
      attempts.map(({ finishReason, reasoningTokens }) => ({ finishReason, reasoningTokens }))
    ).toEqual([
      { finishReason: "length", reasoningTokens: 2 },
      { finishReason: undefined, reasoningTokens: undefined },
      { finishReason: "stop", reasoningTokens: 1 },
    ])
    expect(aggregateAnswerAttemptUsage(attempts)).toEqual({
      requestCount: 3,
      tokenUsageCompleteRequestCount: 2,
      tokenUsageUnknownRequestCount: 1,
      inputTokens: 21,
      outputTokens: 5,
      reasoningTokens: 3,
      totalTokens: 26,
    })
  })

  test("accepts terminal exhausted output only when the protocol explicitly owns that policy", async () => {
    const attempts: AnswerAttemptMetrics[] = []
    const outcome = await generateAnswerWithRetries({
      maxAttempts: 5,
      terminalEmptyOutputPolicy: "accept-and-evaluate",
      execute: async () => ({ text: "", finishReason: "length" }),
      onAttempt: (attempt) => {
        const index = attempts.findIndex((candidate) => candidate.attempt === attempt.attempt)
        if (index >= 0) attempts[index] = attempt
        else attempts.push(attempt)
      },
    })

    expect(outcome).toEqual({ hypothesis: "", terminalEmptyAccepted: true })
    expect(attempts).toHaveLength(5)
    expect(attempts.every((attempt) => attempt.status === "failed")).toBe(true)

    await expect(
      generateAnswerWithRetries({
        maxAttempts: 2,
        execute: async () => ({ text: "" }),
        onAttempt: () => {},
      })
    ).rejects.toThrow("failed after 2 attempts")

    await expect(
      generateAnswerWithRetries({
        maxAttempts: 2,
        terminalEmptyOutputPolicy: "accept-and-evaluate",
        execute: async (attempt) => {
          if (attempt === 1) throw new Error("transport failure")
          return { text: "" }
        },
        onAttempt: () => {},
      })
    ).resolves.toEqual({ hypothesis: "", terminalEmptyAccepted: true })
  })

  test("includes only explicitly accepted empty hypotheses in evaluation", () => {
    expect(
      hasEvaluableAnswer({
        status: "completed",
        hypothesis: "",
        terminalEmptyAccepted: true,
      })
    ).toBe(true)
    expect(hasEvaluableAnswer({ status: "completed", hypothesis: "" })).toBe(false)
    expect(hasEvaluableAnswer({ status: "completed", hypothesis: "answer" })).toBe(true)
    expect(hasEvaluableAnswer(undefined)).toBe(false)
  })

  test("does not rerun a completed accepted-empty answer on resume", () => {
    expect(
      shouldRunAnswerPhase({
        search: { status: "completed" },
        answer: {
          status: "completed",
          hypothesis: "",
          terminalEmptyAccepted: true,
        },
        evaluate: { status: "pending" },
      })
    ).toBe(false)
    expect(
      shouldRunAnswerPhase({
        search: { status: "completed" },
        answer: { status: "failed" },
        evaluate: { status: "pending" },
      })
    ).toBe(true)
  })
})
