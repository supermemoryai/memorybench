import { describe, expect, test } from "bun:test"
import type { Benchmark } from "../src/types/benchmark"
import { CHECKPOINT_SCHEMA_VERSION, type RunCheckpoint } from "../src/types/checkpoint"
import type { BenchmarkProtocol, ProtocolIdentity } from "../src/types/protocol"
import type { UnifiedQuestion } from "../src/types/unified"
import { generateReport } from "../src/orchestrator/phases/report"
import { stableSha256 } from "../src/utils/stable"

const identity: ProtocolIdentity = {
  id: "test.continuous-score",
  version: "1.0.0",
  configFingerprint: "config",
  implementationFingerprint: "implementation",
  ingestionPolicyHash: "ingestion",
  retrievalPolicyHash: "retrieval",
  answerPromptHash: "answer",
  evaluatorHash: "evaluator",
  aggregationHash: "aggregation",
}

function questions(): UnifiedQuestion[] {
  return [0, 1, 2].map((index) => ({
    questionId: `q${index}`,
    question: `Question ${index}`,
    questionType: "ability",
    groundTruth: `Ground truth ${index}`,
    haystackSessionIds: ["s1"],
  }))
}

function reportProtocol(): BenchmarkProtocol {
  return {
    identity,
    auxiliaryRetrievalEvaluation: "disabled",
    ingestionExecutionPolicy: {
      readinessBarrier: "after-build",
      processingMode: "provider-default",
    },
    validateQuestion() {},
    createIngestionPlan() {
      return []
    },
    createRetrievalPlan({ question }) {
      return { query: question.question, requestedTopK: 5, answerCutoff: 5 }
    },
    createAnswerPlan() {
      return {
        request: { prompt: "answer" },
        baseRequest: { prompt: "answer" },
        answerEvidenceCount: 0,
      }
    },
    async evaluateQuestion({ question }) {
      return {
        questionId: question.questionId,
        questionType: question.questionType,
        primaryScore: 0,
        passed: false,
        explanation: "unused",
      }
    },
    aggregateQuality({ evaluations }) {
      const averageScore =
        evaluations.length === 0
          ? 0
          : evaluations.reduce((sum, evaluation) => sum + evaluation.primaryScore, 0) /
            evaluations.length
      const passed = evaluations.filter((evaluation) => evaluation.passed).length
      const passAccuracy = evaluations.length === 0 ? 0 : passed / evaluations.length
      return {
        primaryMetric: {
          key: "continuous_score",
          value: averageScore,
          higherIsBetter: true,
        },
        metrics: { averageScore, passAccuracy, passed, total: evaluations.length },
      }
    },
  }
}

function benchmark(values: UnifiedQuestion[]): Benchmark {
  return {
    name: "test-benchmark",
    scope: { displayName: "Test benchmark", includedTiers: ["test"], coverage: "full" },
    protocol: reportProtocol(),
    async load() {},
    getQuestions() {
      return values
    },
    getHaystackSessions() {
      return []
    },
    getGroundTruth(questionId) {
      return values.find((question) => question.questionId === questionId)?.groundTruth ?? ""
    },
    getQuestionTypes() {
      return {
        ability: { id: "ability", alias: "ability", description: "Test ability" },
      }
    },
  }
}

function checkpoint(values: UnifiedQuestion[]): RunCheckpoint {
  const scores = [0, 0.5, 1]
  const searchDurations = [10, 20, 0]
  const answerDurations = [20, 20, 30]
  const checkpointQuestions: RunCheckpoint["questions"] = {}
  for (let index = 0; index < values.length; index++) {
    const question = values[index]
    const score = scores[index]
    checkpointQuestions[question.questionId] = {
      questionId: question.questionId,
      buildId: "build-1",
      question: question.question,
      groundTruth: question.groundTruth,
      questionType: question.questionType,
      phases: {
        search: {
          status: "completed",
          results: [],
          retrievalPlan: {
            query: question.question,
            requestedTopK: 5,
            answerCutoff: 5,
            threshold: 0,
          },
          requestedCount: 5,
          returnedCount: 0,
          normalizedCount: 0,
          droppedCount: 0,
          providerRequests: [{ operation: "fake.search", limit: 5 }],
          answerCutoff: 5,
          answerEvidenceCount: 0,
          durationMs: searchDurations[index],
          usage: { requestCount: 1, totalTokens: index + 1 },
          costUsd: 0.1,
        },
        answer: {
          status: "completed",
          hypothesis: `Answer ${index}`,
          durationMs: answerDurations[index],
          contextTokens: index,
          evidenceCount: 0,
          usage: { requestCount: 1, totalTokens: index + 2 },
          costUsd: 0.2,
        },
        evaluate: {
          status: "completed",
          durationMs: 1000,
          usage: {
            requestCount: 1,
            ...(index === 0
              ? { tokenUsageUnknownRequestCount: 1 }
              : { tokenUsageCompleteRequestCount: 1 }),
            totalTokens: index + 3,
          },
          costUsd: 0.4,
          evaluation: {
            questionId: question.questionId,
            questionType: question.questionType,
            primaryScore: score,
            passed: score >= 0.5,
            explanation: `Score ${score}`,
          },
        },
      },
    }
  }

  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    runId: "report-run",
    dataSourceRunId: "report-run",
    status: "completed",
    provider: "fake",
    providerAdapterVersion: "1",
    providerPromptFingerprint: "fake-prompts",
    benchmark: "test-benchmark",
    benchmarkScope: {
      displayName: "Test benchmark",
      includedTiers: ["test"],
      coverage: "full",
    },
    selectedQuestionIdsDigest: stableSha256(values.map((question) => question.questionId)),
    benchmarkInputFingerprint: "benchmark-input",
    protocolIdentity: identity,
    judge: "fake-judge",
    answeringModel: "fake-answer",
    answeringRuntimeIdentity: {
      schemaVersion: 1,
      transport: "ai-sdk-generate-text-v1",
      modelAlias: "fake-answer",
      provider: "openai",
      modelId: "fake-answer",
      supportsTemperature: true,
      effectiveDefaultTemperature: 0,
      effectiveDefaultMaxOutputTokens: 1000,
    },
    retrievalTopK: 5,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:02.000Z",
    targetQuestionIds: values.map((question) => question.questionId),
    buildPhaseAttempts: [
      {
        startedAt: "2024-01-01T00:00:00.000Z",
        completedAt: "2024-01-01T00:00:00.120Z",
        durationMs: 120,
        status: "completed",
      },
    ],
    builds: {
      "build-1": {
        buildId: "build-1",
        ingestionGroupId: "chat-1",
        memberQuestionIds: values.map((question) => question.questionId),
        containerTag: "container-1",
        haystack: {
          schemaVersion: 2,
          algorithm: "sha256",
          fingerprint: "haystack",
          orderedSessionIds: ["s1"],
          sessionFingerprints: ["session"],
        },
        buildFingerprint: "build-fingerprint",
        providerIngestionConfigFingerprint: "provider-ingestion-config",
        sessions: [{ sessionId: "s1", documentDate: "2024-01-01", messageCount: 2 }],
        missingDocumentDateCount: 0,
        reused: false,
        ingest: {
          status: "completed",
          completedSessionIds: ["s1"],
          documentIds: ["document-1"],
          taskIds: [],
          startedAt: "2024-01-01T00:00:00.000Z",
          completedAt: "2024-01-01T00:00:00.100Z",
          durationMs: 100,
          attempts: [
            {
              phase: "ingest",
              attempt: 1,
              startedAt: "2024-01-01T00:00:00.000Z",
              completedAt: "2024-01-01T00:00:00.100Z",
              durationMs: 100,
              status: "completed",
              usage: { requestCount: 1, totalTokens: 10 },
              costUsd: 1,
            },
          ],
        },
        indexing: {
          status: "completed",
          completedIds: ["document-1"],
          failedIds: [],
          startedAt: "2024-01-01T00:00:00.100Z",
          completedAt: "2024-01-01T00:00:00.150Z",
          durationMs: 50,
          attempts: [
            {
              phase: "indexing",
              attempt: 1,
              startedAt: "2024-01-01T00:00:00.100Z",
              completedAt: "2024-01-01T00:00:00.150Z",
              durationMs: 50,
              status: "completed",
              usage: { requestCount: 2, totalTokens: 20 },
              costUsd: 2,
            },
          ],
        },
      },
    },
    questions: checkpointQuestions,
  }
}

describe("continuous quality reporting", () => {
  test("reports the average score and >=0.5 pass accuracy independently", () => {
    const values = questions()
    const report = generateReport(benchmark(values), checkpoint(values))

    expect(report.summary.totalQuestions).toBe(3)
    expect(report.summary.averageScore).toBe(0.5)
    expect(report.summary.correctCount).toBe(2)
    expect(report.summary.accuracy).toBeCloseTo(2 / 3)
    expect(report.quality.primaryMetric).toEqual({
      key: "continuous_score",
      value: 0.5,
      higherIsBetter: true,
    })
    expect(report.quality.metrics.averageScore).toBe(0.5)
    expect(report.quality.metrics.passAccuracy).toBeCloseTo(2 / 3)
    expect(report.evaluations.map((evaluation) => evaluation.score)).toEqual([0, 0.5, 1])
    expect(report.evaluations.map((evaluation) => evaluation.primaryScore)).toEqual([0, 0.5, 1])
    expect(report.evaluations.map((evaluation) => evaluation.passed)).toEqual([false, true, true])
    expect(report.evaluations.map((evaluation) => evaluation.label)).toEqual([
      "incorrect",
      "correct",
      "correct",
    ])
  })

  test("refuses to score a selected question set with incomplete evaluation state", () => {
    const values = questions()
    const state = checkpoint(values)
    state.questions[values[0]!.questionId]!.phases.evaluate = { status: "pending" }

    expect(() => generateReport(benchmark(values), state)).toThrow(
      "Cannot generate a scored report with incomplete evaluations"
    )
  })

  test("never turns a protocol-declared failure into a pass because its score is 1", () => {
    const values = questions()
    const state = checkpoint(values)
    state.questions.q2.phases.evaluate.evaluation!.passed = false

    const report = generateReport(benchmark(values), state)
    expect(report.evaluations.at(-1)).toMatchObject({
      primaryScore: 1,
      passed: false,
      label: "incorrect",
    })
    expect(report.summary.correctCount).toBe(1)
    expect(report.quality.metrics.passAccuracy).toBeCloseTo(1 / 3)
  })
})

describe("build and query metrics", () => {
  test("charges one shared build once and keeps evaluation outside online latency", () => {
    const values = questions()
    const report = generateReport(benchmark(values), checkpoint(values))

    expect(report.builds.uniqueBuildCount).toBe(1)
    expect(report.builds.sumContainerBuildWorkMs).toBe(150)
    expect(report.builds.buildPhaseWallClockMs).toBe(120)
    expect(report.builds.totalBuildCostUsd).toBe(3)
    expect(report.costs.query).toMatchObject({ knownCostCount: 3, totalCostCount: 3 })
    expect(report.costs.query.totalCostUsd).toBeCloseTo(0.9)
    expect(report.costs.evaluation).toMatchObject({ knownCostCount: 3, totalCostCount: 3 })
    expect(report.costs.evaluation.totalCostUsd).toBeCloseTo(1.2)
    expect(report.builds.items[0]).toMatchObject({
      ingestLatencyMs: 100,
      indexingLatencyMs: 50,
      buildWorkMs: 150,
      attemptCount: 2,
      attempts: [
        { phase: "ingest", attempt: 1, durationMs: 100 },
        { phase: "indexing", attempt: 1, durationMs: 50 },
      ],
      usage: { requestCount: 3, totalTokens: 30 },
      costUsd: 3,
      sessionCount: 1,
      documentCount: 1,
      taskCount: 0,
      completedIndexingCount: 1,
      failedIndexingCount: 0,
    })

    expect(report.latency.ingest).toMatchObject({ count: 1, mean: 100 })
    expect(report.latency.indexing).toMatchObject({ count: 1, mean: 50 })
    expect(report.latency.total.count).toBe(3)
    expect(report.latency.total.mean).toBeCloseTo((30 + 40 + 30) / 3)
    expect(report.latency.evaluate).toMatchObject({ count: 3, mean: 1000 })
    expect(report.evaluations.map((evaluation) => evaluation.totalDurationMs)).toEqual([30, 40, 30])

    expect(report.questionMetrics).toHaveLength(3)
    expect(report.questionMetrics[0]).toMatchObject({
      configuredTopK: 5,
      providerRequestLimit: 5,
      rawReturnedCount: 0,
      returnedCount: 0,
      normalizedCount: 0,
      droppedCount: 0,
      answerCutoff: 5,
      answerEvidenceCount: 0,
      contextTokens: 0,
      threshold: 0,
      providerRequests: [{ operation: "fake.search", limit: 5 }],
    })
    for (const metrics of report.questionMetrics) {
      expect(metrics.evaluationLatencyMs).toBe(1000)
      expect(metrics.buildAllocationQuestionCount).toBe(3)
      expect(metrics.allocatedBuildWorkMs).toBe(50)
      expect(metrics.amortizedOnlinePlusBuildWorkMs).toBe(metrics.onlineQueryLatencyMs + 50)
      expect(metrics.queryCostUsd).toBeCloseTo(0.3)
      expect(metrics.evaluationCostUsd).toBe(0.4)
      expect(metrics.queryUsage?.requestCount).toBe(2)
      expect(metrics.evaluationUsage?.requestCount).toBe(1)
    }
    expect(report.questionMetrics[0]?.evaluationUsage?.tokenUsageUnknownRequestCount).toBe(1)
    expect(report.questionMetrics[1]?.evaluationUsage?.tokenUsageCompleteRequestCount).toBe(1)
  })

  test("reports query and evaluation totals only with complete cost coverage", () => {
    const values = questions()
    const state = checkpoint(values)
    state.questions.q1.phases.search.costUsd = null
    state.questions.q2.phases.evaluate.costUsd = null

    const report = generateReport(benchmark(values), state)

    expect(
      report.questionMetrics.find((metrics) => metrics.questionId === "q1")?.queryCostUsd
    ).toBeNull()
    expect(
      report.questionMetrics.find((metrics) => metrics.questionId === "q2")?.evaluationCostUsd
    ).toBeNull()
    expect(report.costs.query).toEqual({
      totalCostUsd: null,
      knownCostCount: 2,
      totalCostCount: 3,
    })
    expect(report.costs.evaluation).toEqual({
      totalCostUsd: null,
      knownCostCount: 2,
      totalCostCount: 3,
    })
  })

  test("does not recharge a reused build", () => {
    const values = questions()
    const reusedCheckpoint = checkpoint(values)
    reusedCheckpoint.builds["build-1"].reused = true
    reusedCheckpoint.builds["build-1"].sourceRunId = "original-run"
    const report = generateReport(benchmark(values), reusedCheckpoint)

    expect(report.builds.uniqueBuildCount).toBe(1)
    expect(report.builds.sumContainerBuildWorkMs).toBe(0)
    expect(report.builds.totalBuildCostUsd).toBeNull()
    expect(report.builds.items[0]).toMatchObject({
      reused: true,
      sourceRunId: "original-run",
      ingestLatencyMs: 0,
      indexingLatencyMs: 0,
      buildWorkMs: 0,
      attemptCount: 0,
      costUsd: null,
    })
  })

  test("charges only indexing when a copied run reuses ingestion", () => {
    const values = questions()
    const partialCheckpoint = checkpoint(values)
    const build = partialCheckpoint.builds["build-1"]
    build.sourceRunId = "original-run"
    build.reused = false
    build.reusedPhases = { ingest: true, indexing: false }

    const report = generateReport(benchmark(values), partialCheckpoint)
    expect(report.builds.sumContainerBuildWorkMs).toBe(50)
    expect(report.builds.totalBuildCostUsd).toBe(2)
    expect(report.builds.items[0]).toMatchObject({
      reused: false,
      reusedPhases: { ingest: true, indexing: false },
      ingestLatencyMs: 0,
      indexingLatencyMs: 50,
      buildWallClockMs: 50,
      buildWorkMs: 50,
      attemptCount: 1,
      attempts: [{ phase: "indexing", attempt: 1 }],
      costUsd: 2,
    })
    expect(report.latency.ingest.count).toBe(0)
    expect(report.latency.indexing).toMatchObject({ count: 1, mean: 50 })
  })

  test("retains zero build durations and reports unknown incurred cost with coverage", () => {
    const values = questions()
    const zeroState = checkpoint(values)
    const zeroBuild = zeroState.builds["build-1"]
    zeroBuild.ingest.durationMs = 0
    zeroBuild.ingest.completedAt = zeroBuild.ingest.startedAt
    zeroBuild.ingest.attempts[0].durationMs = 0
    zeroBuild.ingest.attempts[0].completedAt = zeroBuild.ingest.attempts[0].startedAt
    zeroBuild.indexing.durationMs = 0
    zeroBuild.indexing.startedAt = zeroBuild.ingest.startedAt
    zeroBuild.indexing.completedAt = zeroBuild.ingest.startedAt
    zeroBuild.indexing.attempts[0].startedAt = zeroBuild.ingest.startedAt!
    zeroBuild.indexing.attempts[0].durationMs = 0
    zeroBuild.indexing.attempts[0].completedAt = zeroBuild.indexing.attempts[0].startedAt
    zeroState.buildPhaseAttempts[0].durationMs = 0

    const zeroReport = generateReport(benchmark(values), zeroState)
    expect(zeroReport.builds.items[0]).toMatchObject({
      ingestLatencyMs: 0,
      indexingLatencyMs: 0,
      buildWorkMs: 0,
      buildWallClockMs: 0,
    })
    expect(zeroReport.latency.ingest).toMatchObject({ count: 1, mean: 0 })
    expect(zeroReport.latency.indexing).toMatchObject({ count: 1, mean: 0 })
    expect(zeroReport.builds.buildPhaseWallClockMs).toBe(0)

    const unknownCostState = checkpoint(values)
    unknownCostState.builds["build-1"].ingest.attempts[0].costUsd = null
    const unknownCostReport = generateReport(benchmark(values), unknownCostState)
    expect(unknownCostReport.builds.items[0].costUsd).toBeNull()
    expect(unknownCostReport.builds.totalBuildCostUsd).toBeNull()
    expect(unknownCostReport.builds.knownCostBuildCount).toBe(0)
    expect(unknownCostReport.builds.totalCostBuildCount).toBe(1)
  })

  test("includes failed retry attempts in build work and cost", () => {
    const values = questions()
    const state = checkpoint(values)
    const build = state.builds["build-1"]
    build.ingest.attempts.unshift({
      phase: "ingest",
      attempt: 1,
      startedAt: "2023-12-31T23:59:59.900Z",
      completedAt: "2023-12-31T23:59:59.925Z",
      durationMs: 25,
      status: "failed",
      costUsd: 0.5,
      error: "transient failure",
    })
    build.ingest.attempts[1].attempt = 2
    build.ingest.durationMs = 125

    const report = generateReport(benchmark(values), state)
    expect(report.builds.items[0]).toMatchObject({
      ingestLatencyMs: 125,
      buildWorkMs: 175,
      attemptCount: 3,
      costUsd: 3.5,
      attempts: [
        { phase: "ingest", attempt: 1, status: "failed", durationMs: 25 },
        { phase: "ingest", attempt: 2, status: "completed", durationMs: 100 },
        { phase: "indexing", attempt: 1, status: "completed", durationMs: 50 },
      ],
    })
  })

  test("reports concurrent container work separately from build-phase wall clock", () => {
    const values = questions()
    const state = checkpoint(values)
    const firstBuild = state.builds["build-1"]
    firstBuild.memberQuestionIds = values.slice(0, 2).map((value) => value.questionId)
    const secondBuild = structuredClone(firstBuild)
    secondBuild.buildId = "build-2"
    secondBuild.ingestionGroupId = "chat-2"
    secondBuild.containerTag = "container-2"
    secondBuild.memberQuestionIds = [values[2].questionId]
    state.builds[secondBuild.buildId] = secondBuild
    state.questions[values[2].questionId].buildId = secondBuild.buildId

    const report = generateReport(benchmark(values), state)
    expect(report.builds.uniqueBuildCount).toBe(2)
    expect(report.builds.sumContainerBuildWorkMs).toBe(300)
    expect(report.builds.buildPhaseWallClockMs).toBe(120)
    expect(report.latency.ingest).toMatchObject({ count: 2, mean: 100 })
    expect(report.latency.indexing).toMatchObject({ count: 2, mean: 50 })
    expect(
      report.questionMetrics.map((metrics) => ({
        questionId: metrics.questionId,
        denominator: metrics.buildAllocationQuestionCount,
        allocatedBuildWorkMs: metrics.allocatedBuildWorkMs,
      }))
    ).toEqual([
      { questionId: "q0", denominator: 2, allocatedBuildWorkMs: 75 },
      { questionId: "q1", denominator: 2, allocatedBuildWorkMs: 75 },
      { questionId: "q2", denominator: 1, allocatedBuildWorkMs: 150 },
    ])
  })
})
