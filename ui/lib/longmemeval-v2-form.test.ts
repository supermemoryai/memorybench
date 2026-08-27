import { describe, expect, test } from "bun:test"
import {
  parseLongMemEvalV2QuestionIds,
  requiresFullScopeResumeConfirmation,
  toStartLongMemEvalV2RunParams,
  validateLongMemEvalV2Launch,
  type LongMemEvalV2LaunchValues,
} from "./longmemeval-v2-form"

const validValues: LongMemEvalV2LaunchValues = {
  runId: "lme-v2-ui-test",
  provider: "supermemory",
  datasetPath: "/prepared/longmemeval-v2",
  tier: "small",
  allowMedium: false,
  domain: "all",
  selectionMode: "all-haystacks",
  haystackLimit: 1,
  questionIds: "",
  canary: false,
  topK: 20,
  evidenceTopK: 20,
  readerModel: "gpt-5",
  evaluatorModel: "gpt-5",
  reasoningEffort: "high",
  evaluatorReasoningEffort: "high",
  buildConcurrency: 2,
  questionConcurrency: 5,
  trajectoryConcurrency: 4,
  maxInFlightRequests: 20,
  indexingTimeoutMinutes: 30,
  maxTrajectoryAttempts: 4,
  strictIngestion: false,
  runThrough: "plan",
  allowFullRun: false,
  forceBuild: false,
  freshQuery: false,
}

describe("LongMemEval-V2 launch form", () => {
  test("normalizes and deduplicates question IDs", () => {
    expect(parseLongMemEvalV2QuestionIds(" q-1, q-2\nq-1 ")).toEqual(["q-1", "q-2"])
  })

  test("matches the server run-ID contract", () => {
    expect(validateLongMemEvalV2Launch({ ...validValues, runId: "valid_run-1" })).toBeNull()
    expect(validateLongMemEvalV2Launch({ ...validValues, runId: "invalid.run" })).toContain(
      "1–100 characters"
    )
    expect(validateLongMemEvalV2Launch({ ...validValues, runId: "x".repeat(101) })).toContain(
      "1–100 characters"
    )
  })

  test("requires one exact question for a canary", () => {
    expect(validateLongMemEvalV2Launch({ ...validValues, canary: true, runThrough: "query" })).toBe(
      "A canary requires exactly one question ID"
    )
    expect(
      validateLongMemEvalV2Launch({
        ...validValues,
        canary: true,
        selectionMode: "questions",
        questionIds: "q-1",
        runThrough: "query",
      })
    ).toBeNull()
  })

  test("rejects evidence beyond the retrieved top K and unconfirmed medium runs", () => {
    expect(validateLongMemEvalV2Launch({ ...validValues, evidenceTopK: 21 })).toBe(
      "Evidence Top K cannot be greater than Top K"
    )
    expect(
      validateLongMemEvalV2Launch({ ...validValues, tier: "medium", runThrough: "build" })
    ).toBe("Confirm the high-cost medium tier before starting")
    expect(validateLongMemEvalV2Launch({ ...validValues, tier: "medium" })).toBeNull()
  })

  test("requires explicit confirmation for every full-scope live stage", () => {
    for (const runThrough of ["build", "query", "evaluate", "run"] as const) {
      expect(validateLongMemEvalV2Launch({ ...validValues, runThrough })).toBe(
        "Confirm the full-tier run before starting a non-Plan stage without question IDs"
      )
      expect(
        validateLongMemEvalV2Launch({ ...validValues, runThrough, allowFullRun: true })
      ).toBeNull()
    }
    expect(validateLongMemEvalV2Launch(validValues)).toBeNull()
  })

  test("builds the API payload with milliseconds and safe defaults", () => {
    expect(
      toStartLongMemEvalV2RunParams({
        ...validValues,
        selectionMode: "questions",
        questionIds: "q-1, q-1, q-2",
      })
    ).toEqual({
      runId: "lme-v2-ui-test",
      provider: "supermemory",
      datasetPath: "/prepared/longmemeval-v2",
      tier: "small",
      allowMedium: false,
      domain: "all",
      questionIds: ["q-1", "q-2"],
      mode: "benchmark",
      topK: 20,
      evidenceTopK: 20,
      readerModel: "gpt-5",
      evaluatorModel: "gpt-5",
      reasoningEffort: "high",
      evaluatorReasoningEffort: "high",
      buildConcurrency: 2,
      questionConcurrency: 5,
      trajectoryConcurrency: 4,
      maxInFlightRequests: 20,
      indexingTimeoutMs: 1_800_000,
      maxTrajectoryAttempts: 4,
      strictIngestion: false,
      runThrough: "plan",
      allowFullRun: false,
      forceBuild: false,
      freshQuery: false,
    })
  })

  test("sends allowFullRun only for a confirmed full-scope live run", () => {
    expect(
      toStartLongMemEvalV2RunParams({
        ...validValues,
        runThrough: "build",
        allowFullRun: true,
      }).allowFullRun
    ).toBe(true)
    expect(
      toStartLongMemEvalV2RunParams({
        ...validValues,
        runThrough: "build",
        allowFullRun: true,
        selectionMode: "questions",
        questionIds: "q-1",
      }).allowFullRun
    ).toBe(false)
  })

  test("uses an explicit haystack limit as a bounded build selection", () => {
    const params = toStartLongMemEvalV2RunParams({
      ...validValues,
      selectionMode: "haystack-limit",
      haystackLimit: 1,
      runThrough: "build",
    })
    expect(params.haystackLimit).toBe(1)
    expect(params.questionIds).toBeUndefined()
    expect(params.allowFullRun).toBe(false)
  })

  test("requires fresh confirmation when a full-scope checkpoint continues beyond Plan", () => {
    expect(requiresFullScopeResumeConfirmation({}, "build")).toBe(true)
    expect(requiresFullScopeResumeConfirmation({}, "plan")).toBe(false)
    expect(requiresFullScopeResumeConfirmation({}, null)).toBe(false)
    expect(requiresFullScopeResumeConfirmation({ questionIds: ["q-1"] }, "run")).toBe(false)
    expect(requiresFullScopeResumeConfirmation({ limit: 1 }, "query")).toBe(false)
    expect(requiresFullScopeResumeConfirmation({ perCategory: 1 }, "evaluate")).toBe(false)
    expect(requiresFullScopeResumeConfirmation({ haystackLimit: 1 }, "build")).toBe(false)
  })
})
