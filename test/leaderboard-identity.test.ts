import { describe, expect, test } from "bun:test"
import {
  createLeaderboardComparisonIdentity,
  rankLeaderboardEntries,
  validateLeaderboardReportForPublication,
  type LeaderboardAggregationContext,
} from "../src/server/leaderboard-identity"
import type { RunCheckpoint } from "../src/types/checkpoint"
import type { BenchmarkResult, LatencyStats } from "../src/types/unified"
import { sha256Text, stableSha256 } from "../src/utils/stable"
import { resolveAnsweringRuntimeIdentity } from "../src/utils/models"
import { BEAM_ABILITY_IDS, BeamPaperProtocol } from "../src/protocols/beam-paper"

function source(overrides: Record<string, unknown> = {}) {
  return {
    benchmark: "beam-1m",
    benchmarkScope: {
      displayName: "BEAM 1M",
      includedTiers: ["1M"],
      coverage: "full",
    },
    datasetIdentity: {
      datasetFingerprint: "dataset-a",
      revision: "pinned",
    },
    selectedQuestionIdsDigest: "questions-a",
    benchmarkInputFingerprint: "benchmark-input-a",
    protocolIdentity: {
      id: "beam-paper",
      version: "1.1.0",
      configFingerprint: "config-a",
    },
    retrievalTopK: 5,
    judgeModel: "gpt-4.1-mini",
    answeringModel: "gpt-4.1-mini",
    answeringRuntimeIdentity: resolveAnsweringRuntimeIdentity("gpt-4.1-mini"),
    primaryMetric: {
      key: "beamScore",
      value: 0.5,
      higherIsBetter: true,
    },
    accuracy: 0.6,
    ...overrides,
  }
}

describe("leaderboard comparison identity", () => {
  test("score values vary within one cohort", () => {
    const first = createLeaderboardComparisonIdentity(source())
    const second = createLeaderboardComparisonIdentity(
      source({ primaryMetric: { key: "beamScore", value: 0.8, higherIsBetter: true } })
    )

    expect(first.cohortKey).toBe(second.cohortKey)
    expect(first.primaryMetric.value).toBe(0.5)
    expect(second.primaryMetric.value).toBe(0.8)
  })

  test("dataset, question set, protocol, Top-K, models, and metric semantics split cohorts", () => {
    const baseline = createLeaderboardComparisonIdentity(source()).cohortKey
    const variants = [
      source({ datasetIdentity: { datasetFingerprint: "dataset-b" } }),
      source({ selectedQuestionIdsDigest: "questions-b" }),
      source({ benchmarkInputFingerprint: "benchmark-input-b" }),
      source({
        protocolIdentity: {
          id: "beam-paper",
          version: "1.1.0",
          configFingerprint: "config-b",
        },
      }),
      source({ retrievalTopK: 10 }),
      source({ judgeModel: "different-judge" }),
      source({ answeringModel: "different-answering-model" }),
      source({
        answeringRuntimeIdentity: {
          ...resolveAnsweringRuntimeIdentity("gpt-4.1-mini"),
          modelId: "different-effective-model",
        },
      }),
      source({ primaryMetric: { key: "passAccuracy", value: 0.5, higherIsBetter: true } }),
      source({ primaryMetric: { key: "beamScore", value: 0.5, higherIsBetter: false } }),
    ]

    for (const variant of variants) {
      expect(createLeaderboardComparisonIdentity(variant).cohortKey).not.toBe(baseline)
    }
  })

  test("legacy provider-prompt drift splits cohorts", () => {
    const legacyProtocol = { id: "memorybench.legacy", version: "1.0.0" }
    const first = createLeaderboardComparisonIdentity(
      source({ protocolIdentity: legacyProtocol, providerPromptFingerprint: "prompt-a" })
    )
    const second = createLeaderboardComparisonIdentity(
      source({ protocolIdentity: legacyProtocol, providerPromptFingerprint: "prompt-b" })
    )

    expect(first.cohortKey).not.toBe(second.cohortKey)
  })

  test("rejects a run that reports mixed retrieval Top-K values", () => {
    expect(() =>
      createLeaderboardComparisonIdentity(
        source({ questionMetrics: [{ configuredTopK: 5 }, { configuredTopK: 10 }] })
      )
    ).toThrow("mixed retrieval Top-K")
  })

  test("rejects disagreement between configured and recorded retrieval Top-K", () => {
    expect(() =>
      createLeaderboardComparisonIdentity(
        source({ retrievalTopK: 10, questionMetrics: [{ configuredTopK: 5 }] })
      )
    ).toThrow("differs from its recorded question Top-K")
  })
})

describe("leaderboard cohort ranking", () => {
  test("ranks by primary metric only within the same cohort", () => {
    const low = createLeaderboardComparisonIdentity(source())
    const high = createLeaderboardComparisonIdentity(
      source({ primaryMetric: { key: "beamScore", value: 0.8, higherIsBetter: true } })
    )
    const otherDataset = createLeaderboardComparisonIdentity(
      source({
        datasetIdentity: { datasetFingerprint: "dataset-b" },
        primaryMetric: { key: "beamScore", value: 0.99, higherIsBetter: true },
      })
    )

    const ranked = rankLeaderboardEntries([
      {
        id: 1,
        benchmark: "beam-1m",
        accuracy: 0.9,
        comparisonIdentity: low,
      },
      {
        id: 2,
        benchmark: "beam-1m",
        accuracy: 0.1,
        comparisonIdentity: high,
      },
      {
        id: 3,
        benchmark: "beam-1m",
        accuracy: 1,
        comparisonIdentity: otherDataset,
      },
    ])

    expect(ranked.find((entry) => entry.id === 2)).toMatchObject({ cohortRank: 1, cohortSize: 2 })
    expect(ranked.find((entry) => entry.id === 1)).toMatchObject({ cohortRank: 2, cohortSize: 2 })
    expect(ranked.find((entry) => entry.id === 3)).toMatchObject({ cohortRank: 1, cohortSize: 1 })
  })

  test("honors lower-is-better metrics and gives exact ties the same rank", () => {
    const identity = createLeaderboardComparisonIdentity(
      source({ primaryMetric: { key: "latency", value: 20, higherIsBetter: false } })
    )
    const faster = {
      ...identity,
      primaryMetric: { ...identity.primaryMetric, value: 10 },
    }
    const ranked = rankLeaderboardEntries([
      { id: 1, benchmark: "beam-1m", accuracy: 0, comparisonIdentity: identity },
      { id: 2, benchmark: "beam-1m", accuracy: 1, comparisonIdentity: faster },
      { id: 3, benchmark: "beam-1m", accuracy: 0.5, comparisonIdentity: faster },
    ])

    expect(ranked.find((entry) => entry.id === 2)?.cohortRank).toBe(1)
    expect(ranked.find((entry) => entry.id === 3)?.cohortRank).toBe(1)
    expect(ranked.find((entry) => entry.id === 1)?.cohortRank).toBe(3)
  })

  test("legacy rows fall back to benchmark and accuracy semantics", () => {
    const ranked = rankLeaderboardEntries([
      { id: 1, benchmark: "locomo", accuracy: 0.4 },
      { id: 2, benchmark: "locomo", accuracy: 0.7 },
      { id: 3, benchmark: "convomem", accuracy: 0.9 },
    ])

    expect(ranked.find((entry) => entry.id === 2)).toMatchObject({ cohortRank: 1, cohortSize: 2 })
    expect(ranked.find((entry) => entry.id === 1)).toMatchObject({ cohortRank: 2, cohortSize: 2 })
    expect(ranked.find((entry) => entry.id === 3)).toMatchObject({ cohortRank: 1, cohortSize: 1 })
  })
})

const ZERO_LATENCY: LatencyStats = {
  min: 0,
  max: 0,
  mean: 0,
  median: 0,
  p95: 0,
  p99: 0,
  stdDev: 0,
  count: 1,
}

function publishableFixture(): {
  checkpoint: RunCheckpoint
  report: BenchmarkResult
  aggregation: LeaderboardAggregationContext
} {
  const questionIds = ["q1"]
  const digest = stableSha256(questionIds)
  const benchmarkScope = {
    displayName: "BEAM 1M",
    includedTiers: ["1M"],
    coverage: "subset" as const,
  }
  const datasetIdentity = { datasetFingerprint: "dataset-a" }
  const protocolIdentity = { id: "test-paper-protocol", version: "1.0.0" }
  const checkpoint = {
    runId: "run-a",
    provider: "supermemory",
    providerPromptFingerprint: "provider-prompt-a",
    benchmark: "beam-1m",
    benchmarkScope,
    datasetIdentity,
    selectedQuestionIdsDigest: digest,
    benchmarkInputFingerprint: "benchmark-input-a",
    protocolIdentity,
    judge: "gpt-4.1-mini",
    answeringModel: "gpt-4.1-mini",
    answeringRuntimeIdentity: resolveAnsweringRuntimeIdentity("gpt-4.1-mini"),
    retrievalTopK: 5,
    targetQuestionIds: questionIds,
    builds: {},
    questions: {
      q1: {
        questionId: "q1",
        question: "When?",
        questionType: "temporal",
        groundTruth: "Tuesday",
        phases: {
          evaluate: {
            status: "completed",
            evaluation: {
              questionId: "q1",
              questionType: "temporal",
              primaryScore: 0.5,
              passed: true,
              explanation: "ok",
            },
          },
        },
      },
    },
  } as unknown as RunCheckpoint
  const report: BenchmarkResult = {
    provider: "supermemory",
    providerPromptFingerprint: "provider-prompt-a",
    benchmark: "beam-1m",
    runId: "run-a",
    dataSourceRunId: "run-a",
    judge: "gpt-4.1-mini",
    answeringModel: "gpt-4.1-mini",
    answeringRuntimeIdentity: resolveAnsweringRuntimeIdentity("gpt-4.1-mini"),
    timestamp: "2026-08-03T00:00:00.000Z",
    selectedQuestionIdsDigest: digest,
    benchmarkInputFingerprint: "benchmark-input-a",
    retrievalTopK: 5,
    benchmarkScope,
    datasetIdentity,
    protocolIdentity,
    quality: {
      primaryMetric: { key: "beamScore", value: 0.5, higherIsBetter: true },
      metrics: { passAccuracy: 1 },
    },
    summary: { totalQuestions: 1, correctCount: 1, accuracy: 1, averageScore: 0.5 },
    builds: {
      uniqueBuildCount: 0,
      sumContainerBuildWorkMs: 0,
      buildPhaseWallClockMs: 0,
      totalBuildCostUsd: null,
      knownCostBuildCount: 0,
      totalCostBuildCount: 0,
      items: [],
    },
    questionMetrics: [
      {
        questionId: "q1",
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
      },
    ],
    latency: {
      ingest: ZERO_LATENCY,
      indexing: ZERO_LATENCY,
      search: ZERO_LATENCY,
      answer: ZERO_LATENCY,
      evaluate: ZERO_LATENCY,
      total: ZERO_LATENCY,
    },
    byQuestionType: {},
    evaluations: [
      {
        questionId: "q1",
        questionType: "temporal",
        question: "When?",
        score: 0.5,
        primaryScore: 0.5,
        passed: true,
        label: "correct",
        explanation: "ok",
        hypothesis: "Tuesday",
        groundTruth: "Tuesday",
        searchResults: [],
      },
    ],
  }
  const aggregation: LeaderboardAggregationContext = {
    protocol: {
      identity: protocolIdentity as RunCheckpoint["protocolIdentity"],
      aggregateQuality({ evaluations }) {
        const score =
          evaluations.reduce((sum, evaluation) => sum + evaluation.primaryScore, 0) /
          evaluations.length
        return {
          primaryMetric: { key: "beamScore", value: score, higherIsBetter: true },
          metrics: {
            passAccuracy:
              evaluations.filter((evaluation) => evaluation.passed).length / evaluations.length,
          },
        }
      },
    },
    questions: [
      {
        questionId: "q1",
        question: "When?",
        questionType: "temporal",
        groundTruth: "Tuesday",
        haystackSessionIds: [],
      },
    ],
  }
  return { checkpoint, report, aggregation }
}

describe("leaderboard publication report gate", () => {
  test("accepts a complete report whose full identity matches its checkpoint", () => {
    const { checkpoint, report, aggregation } = publishableFixture()
    const identity = validateLeaderboardReportForPublication(checkpoint, report, 1, aggregation)

    expect(identity.judgeModel).toBe("gpt-4.1-mini")
    expect(identity.answeringModel).toBe("gpt-4.1-mini")
    expect(identity.benchmarkInputFingerprint).toBe("benchmark-input-a")
    expect(identity.retrievalTopK).toBe(5)
  })

  test("rejects reports without a scalar official primary metric", () => {
    const { checkpoint, report, aggregation } = publishableFixture()
    report.quality.primaryMetric = undefined

    expect(() =>
      validateLeaderboardReportForPublication(checkpoint, report, 1, aggregation)
    ).toThrow("protocol quality aggregation")
  })

  test("rejects a sampled single-tier BEAM run from ranked publication", () => {
    const { checkpoint, report, aggregation } = publishableFixture()
    const protocol = new BeamPaperProtocol({ retrievalTopK: 5 })
    const question = aggregation.questions[0]!
    question.questionType = "temporal_reasoning"
    question.metadata = { scale: "1M", rubric: ["expected detail"] }
    const evaluation = {
      questionId: question.questionId,
      questionType: question.questionType,
      primaryScore: 0.5,
      passed: true,
      explanation: "ok",
    }

    checkpoint.protocolIdentity = protocol.identity
    checkpoint.questions.q1!.questionType = question.questionType
    checkpoint.questions.q1!.phases.evaluate = { status: "completed", evaluation }
    report.protocolIdentity = protocol.identity
    report.evaluations[0]!.questionType = question.questionType
    report.quality = protocol.aggregateQuality({ questions: [question], evaluations: [evaluation] })

    expect(report.quality.primaryMetric?.key).toBe("beamScorePartial")
    expect(() =>
      validateLeaderboardReportForPublication(checkpoint, report, 1, {
        protocol,
        questions: [question],
      })
    ).toThrow("official complete-tier BEAM")
  })

  test("accepts the exact full 1M question set using the manifest digest scheme", () => {
    const { checkpoint, report } = publishableFixture()
    const protocol = new BeamPaperProtocol({ retrievalTopK: 5 })
    const questions = BEAM_ABILITY_IDS.flatMap((ability) =>
      Array.from({ length: 70 }, (_, index) => ({
        questionId: `official-1m-${ability}-${index}`,
        question: `Question ${ability} ${index}`,
        questionType: ability,
        groundTruth: "Expected answer",
        haystackSessionIds: [],
        metadata: { scale: "1M", rubric: ["Expected detail", "Second detail"] },
      }))
    )
    const evaluations = questions.map((question) => ({
      questionId: question.questionId,
      questionType: question.questionType,
      primaryScore: 0.5,
      passed: true,
      explanation: "ok",
    }))
    const questionIds = questions.map((question) => question.questionId)
    const selectedQuestionIdsDigest = stableSha256(questionIds)
    const datasetIdentity = {
      datasetFingerprint: "official-dataset",
      orderedQuestionIdsDigest: { "1M": sha256Text(questionIds.join("\n")) },
    } as RunCheckpoint["datasetIdentity"]

    checkpoint.protocolIdentity = protocol.identity
    checkpoint.datasetIdentity = datasetIdentity
    checkpoint.targetQuestionIds = questionIds
    checkpoint.selectedQuestionIdsDigest = selectedQuestionIdsDigest
    checkpoint.questions = Object.fromEntries(
      questions.map((question, index) => [
        question.questionId,
        {
          questionId: question.questionId,
          question: question.question,
          questionType: question.questionType,
          groundTruth: question.groundTruth,
          phases: { evaluate: { status: "completed", evaluation: evaluations[index] } },
        },
      ])
    ) as RunCheckpoint["questions"]

    report.protocolIdentity = protocol.identity
    report.datasetIdentity = datasetIdentity
    report.selectedQuestionIdsDigest = selectedQuestionIdsDigest
    report.quality = protocol.aggregateQuality({ questions, evaluations })
    report.summary = {
      totalQuestions: questions.length,
      correctCount: questions.length,
      accuracy: 1,
      averageScore: 0.5,
    }
    report.evaluations = questions.map((question) => ({
      questionId: question.questionId,
      questionType: question.questionType,
      question: question.question,
      score: 0.5,
      primaryScore: 0.5,
      passed: true,
      label: "correct",
      explanation: "ok",
      hypothesis: "answer",
      groundTruth: question.groundTruth,
      searchResults: [],
    }))
    report.questionMetrics = questions.map((question, index) => ({
      ...report.questionMetrics[0]!,
      questionId: question.questionId,
      buildId: `build-${index}`,
    }))

    const identity = validateLeaderboardReportForPublication(
      checkpoint,
      report,
      questions.length,
      { protocol, questions }
    )
    expect(identity.primaryMetric).toMatchObject({ key: "beamScore", value: 0.5 })
  })

  test("rejects report identity or aggregation drift", () => {
    const { checkpoint, report, aggregation } = publishableFixture()
    report.answeringModel = "different-model"
    report.summary.correctCount = 0

    expect(() =>
      validateLeaderboardReportForPublication(checkpoint, report, 1, aggregation)
    ).toThrow(/answering model.*correct-count aggregation/)
  })

  test("rejects effective answering-runtime or benchmark-input drift", () => {
    const { checkpoint, report, aggregation } = publishableFixture()
    report.answeringRuntimeIdentity = {
      ...report.answeringRuntimeIdentity,
      modelId: "same-alias-different-effective-model",
    }
    report.benchmarkInputFingerprint = "benchmark-input-b"

    expect(() =>
      validateLeaderboardReportForPublication(checkpoint, report, 1, aggregation)
    ).toThrow(/answering runtime.*benchmark-input fingerprint/)
  })

  test("rejects deletion of an official report dataset identity", () => {
    const { checkpoint, report, aggregation } = publishableFixture()
    report.datasetIdentity = undefined

    expect(() =>
      validateLeaderboardReportForPublication(checkpoint, report, 1, aggregation)
    ).toThrow("missing dataset identity")
  })

  test("rejects tampered protocol-owned primary and secondary quality metrics", () => {
    const { checkpoint, report, aggregation } = publishableFixture()
    report.quality.primaryMetric!.value = 0.99
    report.quality.metrics.passAccuracy = 0

    expect(() =>
      validateLeaderboardReportForPublication(checkpoint, report, 1, aggregation)
    ).toThrow("protocol quality aggregation")
  })

  test("rejects a coherently rewritten report evaluation against checkpoint state", () => {
    const { checkpoint, report, aggregation } = publishableFixture()
    report.evaluations[0]!.score = 0.99
    report.evaluations[0]!.primaryScore = 0.99
    report.summary.averageScore = 0.99
    report.quality.primaryMetric!.value = 0.99

    expect(() =>
      validateLeaderboardReportForPublication(checkpoint, report, 1, aggregation)
    ).toThrow(/report\/checkpoint evaluations.*protocol quality aggregation/)
  })

  test("keeps combined BEAM without an official scalar out of the leaderboard", () => {
    const { checkpoint, report } = publishableFixture()
    const protocol = new BeamPaperProtocol({ retrievalTopK: 5 })
    const questions = [
      {
        questionId: "q1",
        question: "Question one",
        questionType: "temporal_reasoning",
        groundTruth: "Answer one",
        haystackSessionIds: [],
        metadata: { scale: "1M" },
      },
      {
        questionId: "q2",
        question: "Question two",
        questionType: "temporal_reasoning",
        groundTruth: "Answer two",
        haystackSessionIds: [],
        metadata: { scale: "10M" },
      },
    ]
    const evaluations = questions.map((question) => ({
      questionId: question.questionId,
      questionType: question.questionType,
      primaryScore: 0.5,
      passed: true,
      explanation: "ok",
    }))
    const digest = stableSha256(questions.map((question) => question.questionId))

    checkpoint.benchmark = "beam-1m-10m"
    checkpoint.benchmarkScope = {
      displayName: "BEAM 1M/10M",
      includedTiers: ["1M", "10M"],
      coverage: "subset",
    }
    checkpoint.protocolIdentity = protocol.identity
    checkpoint.selectedQuestionIdsDigest = digest
    checkpoint.targetQuestionIds = ["q1", "q2"]
    checkpoint.questions = Object.fromEntries(
      questions.map((question, index) => [
        question.questionId,
        {
          questionId: question.questionId,
          question: question.question,
          questionType: question.questionType,
          groundTruth: question.groundTruth,
          phases: {
            evaluate: { status: "completed", evaluation: evaluations[index] },
          },
        },
      ])
    ) as RunCheckpoint["questions"]

    report.benchmark = checkpoint.benchmark
    report.benchmarkScope = checkpoint.benchmarkScope
    report.protocolIdentity = protocol.identity
    report.selectedQuestionIdsDigest = digest
    report.summary = { totalQuestions: 2, correctCount: 2, accuracy: 1, averageScore: 0.5 }
    report.quality = protocol.aggregateQuality({ questions, evaluations })
    report.evaluations = questions.map((question) => ({
      questionId: question.questionId,
      questionType: question.questionType,
      question: question.question,
      score: 0.5,
      primaryScore: 0.5,
      passed: true,
      label: "correct",
      explanation: "ok",
      hypothesis: "answer",
      groundTruth: question.groundTruth,
      searchResults: [],
      searchDurationMs: 0,
      answerDurationMs: 0,
      totalDurationMs: 0,
    }))
    report.questionMetrics = questions.map((question, index) => ({
      ...report.questionMetrics[0]!,
      questionId: question.questionId,
      buildId: `build-${index + 1}`,
    }))
    const aggregation = { protocol, questions }

    expect(() =>
      validateLeaderboardReportForPublication(checkpoint, report, 2, aggregation)
    ).toThrow("finite scalar primary metric")

    report.quality.primaryMetric = {
      key: "beamScore",
      value: 0.5,
      higherIsBetter: true,
    }
    expect(() =>
      validateLeaderboardReportForPublication(checkpoint, report, 2, aggregation)
    ).toThrow("protocol quality aggregation")
  })
})
