import { describe, expect, test } from "bun:test"
import {
  BatchManager,
  comparePrimaryMetrics,
  type CompareManifest,
} from "../src/orchestrator/batch"
import type { BenchmarkResult, LatencyStats } from "../src/types/unified"
import { stableSha256 } from "../src/utils/stable"
import { resolveAnsweringRuntimeIdentity } from "../src/utils/models"

const ZERO_LATENCY: LatencyStats = {
  min: 0,
  max: 0,
  mean: 0,
  median: 0,
  p95: 0,
  p99: 0,
  stdDev: 0,
  count: 0,
}

function report(input: {
  provider: string
  primaryKey?: string
  primaryValue?: number
  higherIsBetter?: boolean
  passAccuracy: number
}): BenchmarkResult {
  const totalQuestions = 10
  const questionIds = Array.from({ length: totalQuestions }, (_, index) => `q${index + 1}`)
  const primaryValue = input.primaryValue ?? 0
  return {
    provider: input.provider,
    providerPromptFingerprint: `prompt-${input.provider}`,
    benchmark: "beam-1m",
    runId: `run-${input.provider}`,
    dataSourceRunId: `run-${input.provider}`,
    judge: "gpt-4.1-mini",
    answeringModel: "gpt-4.1-mini",
    answeringRuntimeIdentity: resolveAnsweringRuntimeIdentity("gpt-4.1-mini"),
    timestamp: "2026-08-03T00:00:00.000Z",
    selectedQuestionIdsDigest: stableSha256(questionIds),
    benchmarkInputFingerprint: "benchmark-input-a",
    retrievalTopK: 5,
    benchmarkScope: {
      displayName: "BEAM 1M",
      includedTiers: ["1M"],
      coverage: "subset",
    },
    datasetIdentity: { datasetFingerprint: "dataset-a" },
    protocolIdentity: { id: "beam-paper", version: "1.1.0" },
    quality: {
      primaryMetric:
        input.primaryValue == null
          ? undefined
          : {
              key: input.primaryKey ?? "beamScore",
              value: input.primaryValue,
              higherIsBetter: input.higherIsBetter ?? true,
            },
      metrics: { passAccuracy: input.passAccuracy },
    },
    summary: {
      totalQuestions,
      correctCount: Math.round(input.passAccuracy * totalQuestions),
      accuracy: input.passAccuracy,
      averageScore: primaryValue,
    },
    builds: {
      uniqueBuildCount: 0,
      sumContainerBuildWorkMs: 0,
      buildPhaseWallClockMs: 0,
      totalBuildCostUsd: null,
      knownCostBuildCount: 0,
      totalCostBuildCount: 0,
      items: [],
    },
    questionMetrics: questionIds.map((questionId) => ({
      questionId,
      buildId: "build-1",
      searchLatencyMs: 0,
      answerLatencyMs: 0,
      onlineQueryLatencyMs: 0,
      evaluationLatencyMs: 0,
      queryCostUsd: null,
      evaluationCostUsd: null,
      configuredTopK: 5,
      providerRequestLimit: 5,
      rawReturnedCount: 5,
      returnedCount: 5,
      normalizedCount: 5,
      droppedCount: 0,
      answerCutoff: 5,
      answerEvidenceCount: 5,
      contextTokens: 0,
      providerRequests: [],
    })),
    latency: {
      ingest: ZERO_LATENCY,
      indexing: ZERO_LATENCY,
      search: ZERO_LATENCY,
      answer: ZERO_LATENCY,
      evaluate: ZERO_LATENCY,
      total: ZERO_LATENCY,
    },
    byQuestionType: {},
    evaluations: [],
  }
}

function manifest(reports: BenchmarkResult[]): CompareManifest {
  return {
    compareId: "compare-test",
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
    benchmark: "beam-1m",
    judge: "gpt-4.1-mini",
    answeringModel: "gpt-4.1-mini",
    answeringRuntimeIdentity: resolveAnsweringRuntimeIdentity("gpt-4.1-mini"),
    targetQuestionIds: Array.from({ length: 10 }, (_, index) => `q${index + 1}`),
    retrievalTopK: 5,
    datasetIdentity: { datasetFingerprint: "dataset-a" } as any,
    benchmarkScope: reports[0].benchmarkScope,
    protocolIdentity: reports[0].protocolIdentity as any,
    selectedQuestionIdsDigest: reports[0].selectedQuestionIdsDigest,
    benchmarkInputFingerprint: reports[0].benchmarkInputFingerprint,
    runs: reports.map((value) => ({
      provider: value.provider,
      runId: value.runId,
      providerPromptFingerprint: value.providerPromptFingerprint,
    })),
  }
}

function captureConsoleLog(run: () => void): string {
  const lines: string[] = []
  const original = console.log
  console.log = (...values: unknown[]) => lines.push(values.map(String).join(" "))
  try {
    run()
  } finally {
    console.log = original
  }
  return lines.join("\n")
}

describe("batch comparison primary metric semantics", () => {
  test("ranks by the comparable primary metric while keeping pass accuracy secondary", () => {
    const alpha = report({ provider: "alpha", primaryValue: 0.75, passAccuracy: 0.5 })
    const beta = report({ provider: "beta", primaryValue: 0.7, passAccuracy: 0.9 })
    const reports = [
      { provider: beta.provider, report: beta },
      { provider: alpha.provider, report: alpha },
    ]

    const comparison = comparePrimaryMetrics(reports)
    expect(comparison.comparable).toBe(true)
    expect(comparison.rows.map(({ provider }) => provider)).toEqual(["alpha", "beta"])
    expect(comparison.rows[0].deltaFromBest).toBe(0)
    expect(comparison.rows[1].deltaFromBest).toBeCloseTo(-0.05)
    expect(comparison.winners).toEqual(["alpha"])

    const manager = new BatchManager()
    manager.getReports = () => reports
    const output = captureConsoleLog(() => manager.printComparisonReport(manifest([beta, alpha])))
    expect(output).toContain("QUALITY — beamScore (higher is better)")
    expect(output).toContain("Pass accuracy")
    expect(output).toContain("-0.0500")
    expect(output).toContain(
      "WINNER: alpha (beamScore=0.7500; pass accuracy secondary: alpha 50.0%)"
    )
    expect(output).not.toContain("WINNER: beta")
  })

  test("honors lower-is-better primary metrics", () => {
    const alpha = report({
      provider: "alpha",
      primaryKey: "errorRate",
      primaryValue: 0.2,
      higherIsBetter: false,
      passAccuracy: 0.9,
    })
    const beta = report({
      provider: "beta",
      primaryKey: "errorRate",
      primaryValue: 0.1,
      higherIsBetter: false,
      passAccuracy: 0.5,
    })

    const comparison = comparePrimaryMetrics([
      { provider: alpha.provider, report: alpha },
      { provider: beta.provider, report: beta },
    ])
    expect(comparison.rows.map(({ provider }) => provider)).toEqual(["beta", "alpha"])
    expect(comparison.rows.map(({ deltaFromBest }) => deltaFromBest)).toEqual([0, 0.1])
    expect(comparison.winners).toEqual(["beta"])
  })

  test("does not rank or declare a winner when primary metric identities differ", () => {
    const beam = report({ provider: "beam", primaryValue: 0.75, passAccuracy: 0.6 })
    const legacy = report({
      provider: "legacy",
      primaryKey: "accuracy",
      primaryValue: 0.9,
      passAccuracy: 0.9,
    })
    const reports = [
      { provider: beam.provider, report: beam },
      { provider: legacy.provider, report: legacy },
    ]

    const comparison = comparePrimaryMetrics(reports)
    expect(comparison.comparable).toBe(false)
    expect(comparison.rows.map(({ provider }) => provider)).toEqual(["beam", "legacy"])
    expect(comparison.rows.every(({ deltaFromBest }) => deltaFromBest === undefined)).toBe(true)
    expect(comparison.winners).toEqual([])

    const manager = new BatchManager()
    manager.getReports = () => reports
    const output = captureConsoleLog(() => manager.printComparisonReport(manifest([beam, legacy])))
    expect(output).toContain("suppressing ranking, deltas, and winner")
    expect(output).toContain("NO WINNER: reports are not like-for-like")
    expect(output).not.toContain("WINNER: beam (")
    expect(output).not.toContain("WINNER: legacy (")
  })

  test("requires matching dataset, question set, protocol, Top-K, judge, and answering model", () => {
    const baseline = report({ provider: "alpha", primaryValue: 0.75, passAccuracy: 0.6 })
    const variants: BenchmarkResult[] = [
      {
        ...report({ provider: "beta", primaryValue: 0.7, passAccuracy: 0.6 }),
        datasetIdentity: { datasetFingerprint: "dataset-b" },
      },
      {
        ...report({ provider: "beta", primaryValue: 0.7, passAccuracy: 0.6 }),
        selectedQuestionIdsDigest: "different-questions",
      },
      {
        ...report({ provider: "beta", primaryValue: 0.7, passAccuracy: 0.6 }),
        benchmarkInputFingerprint: "different-transformed-input",
      },
      {
        ...report({ provider: "beta", primaryValue: 0.7, passAccuracy: 0.6 }),
        protocolIdentity: { id: "beam-paper", version: "different" },
      },
      {
        ...report({ provider: "beta", primaryValue: 0.7, passAccuracy: 0.6 }),
        retrievalTopK: 10,
        questionMetrics: baseline.questionMetrics.map((metric) => ({
          ...metric,
          configuredTopK: 10,
        })),
      },
      {
        ...report({ provider: "beta", primaryValue: 0.7, passAccuracy: 0.6 }),
        judge: "different-judge",
      },
      {
        ...report({ provider: "beta", primaryValue: 0.7, passAccuracy: 0.6 }),
        answeringModel: "different-answering-model",
      },
    ]

    for (const variant of variants) {
      const comparison = comparePrimaryMetrics([
        { provider: baseline.provider, report: baseline },
        { provider: variant.provider, report: variant },
      ])
      expect(comparison.comparable).toBe(false)
      expect(comparison.winners).toEqual([])
    }
  })

  test("keeps combined BEAM non-comparable when no scalar cross-tier primary metric exists", () => {
    const alpha = report({ provider: "alpha", passAccuracy: 0.9 })
    const beta = report({ provider: "beta", passAccuracy: 0.8 })
    const comparison = comparePrimaryMetrics([
      { provider: alpha.provider, report: alpha },
      { provider: beta.provider, report: beta },
    ])

    expect(comparison.comparable).toBe(false)
    expect(comparison.rows[0].primaryMetric).toBeUndefined()
    expect(comparison.mismatchReasons.join(" ")).toContain("no scalar primary metric")
    expect(comparison.winners).toEqual([])
  })

  test("compares legacy providers with derived input identity and rejects input drift", () => {
    const legacyReport = (provider: string, accuracy: number): BenchmarkResult => ({
      ...report({
        provider,
        primaryKey: "accuracy",
        primaryValue: accuracy,
        passAccuracy: accuracy,
      }),
      benchmark: "locomo",
      benchmarkScope: { displayName: "LoCoMo", includedTiers: [], coverage: "full" },
      datasetIdentity: undefined,
      benchmarkInputFingerprint: "legacy-selected-input-a",
      protocolIdentity: { id: "memorybench.legacy", version: "1.0.0" },
      providerPromptFingerprint: "shared-legacy-prompt",
    })
    const alpha = legacyReport("alpha", 0.7)
    const beta = legacyReport("beta", 0.8)

    const comparable = comparePrimaryMetrics([
      { provider: alpha.provider, report: alpha },
      { provider: beta.provider, report: beta },
    ])
    expect(comparable.comparable).toBe(true)
    expect(comparable.winners).toEqual(["beta"])

    const drifted = {
      ...beta,
      benchmarkInputFingerprint: "legacy-selected-input-with-haystack-drift",
    }
    const mismatch = comparePrimaryMetrics([
      { provider: alpha.provider, report: alpha },
      { provider: drifted.provider, report: drifted },
    ])
    expect(mismatch.comparable).toBe(false)
    expect(mismatch.winners).toEqual([])
  })

  test("does not rank a partial provider set", () => {
    const alpha = report({ provider: "alpha", primaryValue: 0.8, passAccuracy: 0.8 })
    const comparison = comparePrimaryMetrics([{ provider: alpha.provider, report: alpha }], 2)

    expect(comparison.comparable).toBe(false)
    expect(comparison.mismatchReasons).toContain("only 1 of 2 provider reports are complete")
    expect(comparison.winners).toEqual([])
  })
})

describe("batch comparison preflight barrier", () => {
  test("preflights every run without starting provider execution", async () => {
    const alpha = report({ provider: "alpha", primaryValue: 0.7, passAccuracy: 0.7 })
    const beta = report({ provider: "beta", primaryValue: 0.6, passAccuracy: 0.6 })
    const calls: Array<{ runId: string; preflightOnly?: boolean }> = []
    const manager = new BatchManager({
      async run(options) {
        calls.push({ runId: options.runId, preflightOnly: options.preflightOnly })
      },
    })

    await manager.preflightRuns(manifest([alpha, beta]))

    expect(calls).toEqual([
      { runId: alpha.runId, preflightOnly: true },
      { runId: beta.runId, preflightOnly: true },
    ])
  })

  test("reports every provider preflight failure before execution starts", async () => {
    const alpha = report({ provider: "alpha", primaryValue: 0.7, passAccuracy: 0.7 })
    const beta = report({ provider: "beta", primaryValue: 0.6, passAccuracy: 0.6 })
    const manager = new BatchManager({
      async run(options) {
        if (options.runId === beta.runId) throw new Error("resume identity changed")
      },
    })

    await expect(manager.preflightRuns(manifest([alpha, beta]))).rejects.toThrow(
      "beta: resume identity changed"
    )
  })
})
