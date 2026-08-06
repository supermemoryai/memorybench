import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Benchmark } from "../../types/benchmark"
import type { RunCheckpoint } from "../../types/checkpoint"
import type { QuestionEvaluation } from "../../types/protocol"
import type {
  BenchmarkResult,
  BuildMetrics,
  CostCoverageMetrics,
  EvaluationResult,
  LatencyStats,
  QuestionMetrics,
  QuestionTypeStats,
  RetrievalAggregates,
  RetrievalMetrics,
  TokenMetrics,
  UsageMetrics,
} from "../../types/unified"
import { logger } from "../../utils/logger"
import { stableSha256 } from "../../utils/stable"
import { canonicalizeSelectedQuestionIds } from "../input-identity"

const REPORTS_DIR = "./data/runs"

function aggregateRetrievalMetrics(metrics: RetrievalMetrics[]): RetrievalAggregates | undefined {
  if (metrics.length === 0) return undefined
  const sum = metrics.reduce(
    (accumulator, metric) => ({
      hitAtK: accumulator.hitAtK + metric.hitAtK,
      precisionAtK: accumulator.precisionAtK + metric.precisionAtK,
      recallAtK: accumulator.recallAtK + metric.recallAtK,
      f1AtK: accumulator.f1AtK + metric.f1AtK,
      mrr: accumulator.mrr + metric.mrr,
      ndcg: accumulator.ndcg + metric.ndcg,
      k: accumulator.k + metric.k,
    }),
    { hitAtK: 0, precisionAtK: 0, recallAtK: 0, f1AtK: 0, mrr: 0, ndcg: 0, k: 0 }
  )
  const count = metrics.length
  return {
    hitAtK: sum.hitAtK / count,
    precisionAtK: sum.precisionAtK / count,
    recallAtK: sum.recallAtK / count,
    f1AtK: sum.f1AtK / count,
    mrr: sum.mrr / count,
    ndcg: sum.ndcg / count,
    k: sum.k / count,
  }
}

export function calculateLatencyStats(durations: number[]): LatencyStats {
  if (durations.length === 0) {
    return { min: 0, max: 0, mean: 0, median: 0, p95: 0, p99: 0, stdDev: 0, count: 0 }
  }
  const sorted = [...durations].sort((left, right) => left - right)
  const count = sorted.length
  const mean = sorted.reduce((sum, value) => sum + value, 0) / count
  const variance = sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / count
  const percentile = (fraction: number) =>
    sorted[Math.min(count - 1, Math.max(0, Math.ceil(count * fraction) - 1))]
  return {
    min: sorted[0],
    max: sorted[count - 1],
    mean,
    median: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    stdDev: Math.sqrt(variance),
    count,
  }
}

function nullableSum(values: Array<number | null | undefined>): number | null {
  if (values.length === 0) return null
  if (values.some((value) => value == null)) return null
  return values.reduce<number>((sum, value) => sum + (value as number), 0)
}

function aggregateCostCoverage(values: Array<number | null>): CostCoverageMetrics {
  const knownCosts = values.filter((value): value is number => value != null)
  return {
    totalCostUsd:
      values.length > 0 && knownCosts.length === values.length
        ? knownCosts.reduce((sum, value) => sum + value, 0)
        : null,
    knownCostCount: knownCosts.length,
    totalCostCount: values.length,
  }
}

function aggregateUsage(values: Array<UsageMetrics | undefined>): UsageMetrics | undefined {
  const present = values.filter((value): value is UsageMetrics => value !== undefined)
  if (present.length === 0) return undefined
  const sumField = (field: keyof UsageMetrics): number | undefined => {
    const numbers = present
      .map((value) => value[field])
      .filter((value): value is number => value !== undefined)
    return numbers.length > 0 ? numbers.reduce((sum, value) => sum + value, 0) : undefined
  }
  return {
    ...(sumField("requestCount") !== undefined ? { requestCount: sumField("requestCount") } : {}),
    ...(sumField("tokenUsageCompleteRequestCount") !== undefined
      ? { tokenUsageCompleteRequestCount: sumField("tokenUsageCompleteRequestCount") }
      : {}),
    ...(sumField("tokenUsagePartialRequestCount") !== undefined
      ? { tokenUsagePartialRequestCount: sumField("tokenUsagePartialRequestCount") }
      : {}),
    ...(sumField("tokenUsageUnknownRequestCount") !== undefined
      ? { tokenUsageUnknownRequestCount: sumField("tokenUsageUnknownRequestCount") }
      : {}),
    ...(sumField("inputTokens") !== undefined ? { inputTokens: sumField("inputTokens") } : {}),
    ...(sumField("outputTokens") !== undefined ? { outputTokens: sumField("outputTokens") } : {}),
    ...(sumField("reasoningTokens") !== undefined
      ? { reasoningTokens: sumField("reasoningTokens") }
      : {}),
    ...(sumField("totalTokens") !== undefined ? { totalTokens: sumField("totalTokens") } : {}),
  }
}

function elapsedMs(startedAt?: string, completedAt?: string): number {
  if (!startedAt || !completedAt) return 0
  return Math.max(0, Date.parse(completedAt) - Date.parse(startedAt))
}

export function generateReport(benchmark: Benchmark, checkpoint: RunCheckpoint): BenchmarkResult {
  if (!checkpoint.benchmarkInputFingerprint?.trim()) {
    throw new Error("Cannot generate report without a benchmark input fingerprint")
  }
  if (!checkpoint.answeringRuntimeIdentity) {
    throw new Error("Cannot generate report without an answering runtime identity")
  }
  if (!Number.isInteger(checkpoint.retrievalTopK) || checkpoint.retrievalTopK <= 0) {
    throw new Error("Cannot generate report without an effective retrieval Top-K")
  }
  const allQuestions = benchmark.getQuestions()
  const questionById = new Map(allQuestions.map((question) => [question.questionId, question]))
  const requestedQuestionIds =
    checkpoint.targetQuestionIds && checkpoint.targetQuestionIds.length > 0
      ? [...checkpoint.targetQuestionIds]
      : Object.keys(checkpoint.questions)
  const selectedQuestionIds = canonicalizeSelectedQuestionIds(allQuestions, requestedQuestionIds)
  if (stableSha256(selectedQuestionIds) !== checkpoint.selectedQuestionIdsDigest) {
    throw new Error("Cannot report a checkpoint with non-canonical selected-question identity")
  }
  const checkpointOnlyIds = Object.keys(checkpoint.questions).filter(
    (questionId) => !selectedQuestionIds.includes(questionId)
  )
  if (checkpointOnlyIds.length > 0) {
    throw new Error(
      `Cannot report unselected checkpoint questions: ${checkpointOnlyIds.join(", ")}`
    )
  }
  const questions = selectedQuestionIds.map((questionId) => questionById.get(questionId)!)
  const incompleteQuestionIds = questions
    .filter(
      (question) =>
        checkpoint.questions[question.questionId]?.phases.evaluate.status !== "completed" ||
        !checkpoint.questions[question.questionId]?.phases.evaluate.evaluation
    )
    .map((question) => question.questionId)
  if (incompleteQuestionIds.length > 0) {
    throw new Error(
      `Cannot generate a scored report with incomplete evaluations (${incompleteQuestionIds.length}), starting with ${incompleteQuestionIds[0]}`
    )
  }
  const evaluations: EvaluationResult[] = []
  const protocolEvaluations: QuestionEvaluation[] = []
  const evaluatedQuestions = [] as typeof questions
  const questionMetrics: QuestionMetrics[] = []
  const allRetrievalMetrics: RetrievalMetrics[] = []
  const byType = new Map<
    string,
    {
      total: number
      passed: number
      search: number[]
      answer: number[]
      online: number[]
      retrieval: RetrievalMetrics[]
    }
  >()

  const completedQuestionCountByBuild = new Map<string, number>()
  for (const question of questions) {
    const questionCheckpoint = checkpoint.questions[question.questionId]
    if (questionCheckpoint?.phases.evaluate.status === "completed") {
      completedQuestionCountByBuild.set(
        questionCheckpoint.buildId,
        (completedQuestionCountByBuild.get(questionCheckpoint.buildId) || 0) + 1
      )
    }
  }

  const buildMetrics: BuildMetrics[] = Object.values(checkpoint.builds).map((build) => {
    const allAttempts = [...build.ingest.attempts, ...build.indexing.attempts]
    const reusedPhases = build.reusedPhases ?? {
      ingest: build.reused,
      indexing: build.reused,
    }
    const currentAttempts = allAttempts.filter((attempt) => !reusedPhases[attempt.phase])
    const currentWork = currentAttempts.reduce((sum, attempt) => sum + (attempt.durationMs ?? 0), 0)
    const costUsd = nullableSum(currentAttempts.map((attempt) => attempt.costUsd))
    const currentStart = currentAttempts.map((attempt) => attempt.startedAt).sort()[0]
    const currentEnd = currentAttempts
      .flatMap((attempt) => (attempt.completedAt ? [attempt.completedAt] : []))
      .sort()
      .at(-1)
    return {
      buildId: build.buildId,
      containerTag: build.containerTag,
      providerIngestionConfigFingerprint: build.providerIngestionConfigFingerprint,
      sourceRunId: build.sourceRunId,
      reused: build.reused,
      reusedPhases,
      ingestLatencyMs: reusedPhases.ingest ? 0 : (build.ingest.durationMs ?? 0),
      indexingLatencyMs: reusedPhases.indexing ? 0 : (build.indexing.durationMs ?? 0),
      buildWallClockMs: elapsedMs(currentStart, currentEnd),
      buildWorkMs: currentWork,
      attemptCount: currentAttempts.length,
      attempts: currentAttempts.map((attempt) => ({ ...attempt })),
      ...(aggregateUsage(currentAttempts.map((attempt) => attempt.usage))
        ? { usage: aggregateUsage(currentAttempts.map((attempt) => attempt.usage)) }
        : {}),
      costUsd,
      sessionCount: new Set(build.haystack.orderedSessionIds).size,
      documentCount: new Set(build.ingest.documentIds).size,
      taskCount: new Set(build.ingest.taskIds).size,
      completedIndexingCount: new Set(build.indexing.completedIds).size,
      failedIndexingCount: new Set(build.indexing.failedIds).size,
    }
  })
  const buildMetricsById = new Map(buildMetrics.map((metrics) => [metrics.buildId, metrics]))

  for (const question of questions) {
    const questionCheckpoint = checkpoint.questions[question.questionId]
    if (!questionCheckpoint || questionCheckpoint.phases.evaluate.status !== "completed") continue
    const evaluation = questionCheckpoint.phases.evaluate.evaluation
    if (!evaluation) {
      throw new Error(`Completed question ${question.questionId} is missing protocol evaluation`)
    }
    if (typeof evaluation.passed !== "boolean") {
      throw new Error(`Completed question ${question.questionId} is missing protocol pass state`)
    }
    const search = questionCheckpoint.phases.search
    const answer = questionCheckpoint.phases.answer
    const evaluate = questionCheckpoint.phases.evaluate
    const searchLatencyMs = search.durationMs ?? 0
    const answerLatencyMs = answer.durationMs ?? 0
    const evaluationLatencyMs = evaluate.durationMs ?? 0
    const onlineQueryLatencyMs = searchLatencyMs + answerLatencyMs
    const buildMetric = buildMetricsById.get(questionCheckpoint.buildId)
    const denominator = completedQuestionCountByBuild.get(questionCheckpoint.buildId) || 0
    const allocatedBuildWorkMs =
      buildMetric && denominator > 0 ? buildMetric.buildWorkMs / denominator : undefined
    const passed = evaluation.passed

    protocolEvaluations.push(evaluation)
    evaluatedQuestions.push(question)
    if (evaluate.retrievalMetrics) allRetrievalMetrics.push(evaluate.retrievalMetrics)
    evaluations.push({
      questionId: question.questionId,
      questionType: question.questionType,
      question: question.question,
      score: evaluation.primaryScore,
      primaryScore: evaluation.primaryScore,
      passed,
      label: passed ? "correct" : "incorrect",
      explanation: evaluation.explanation,
      metrics: evaluation.metrics,
      hypothesis: answer.hypothesis || "",
      groundTruth: question.groundTruth,
      searchResults: search.results || [],
      searchDurationMs: searchLatencyMs,
      answerDurationMs: answerLatencyMs,
      totalDurationMs: onlineQueryLatencyMs,
      retrievalMetrics: evaluate.retrievalMetrics,
      details: evaluation.details,
    })
    questionMetrics.push({
      questionId: question.questionId,
      buildId: questionCheckpoint.buildId,
      searchLatencyMs,
      answerLatencyMs,
      onlineQueryLatencyMs,
      evaluationLatencyMs,
      ...(aggregateUsage([search.usage, answer.usage])
        ? { queryUsage: aggregateUsage([search.usage, answer.usage]) }
        : {}),
      ...(evaluate.usage ? { evaluationUsage: { ...evaluate.usage } } : {}),
      queryCostUsd: nullableSum([search.costUsd, answer.costUsd]),
      evaluationCostUsd: evaluate.costUsd ?? null,
      configuredTopK: search.retrievalPlan?.requestedTopK ?? search.requestedCount ?? 0,
      providerRequestLimit:
        search.providerRequests?.reduce((sum, request) => sum + request.limit, 0) ??
        search.requestedCount ??
        0,
      rawReturnedCount:
        search.rawReturnedCount ?? search.returnedCount ?? search.results?.length ?? 0,
      returnedCount: search.normalizedCount ?? search.returnedCount ?? search.results?.length ?? 0,
      normalizedCount: search.normalizedCount ?? search.results?.length ?? 0,
      droppedCount: search.droppedCount ?? 0,
      droppedResults: search.droppedResults ?? [],
      answerCutoff: search.retrievalPlan?.answerCutoff ?? search.answerCutoff ?? 0,
      answerEvidenceCount: search.answerEvidenceCount ?? answer.evidenceCount ?? 0,
      contextTokens: answer.contextTokens ?? 0,
      ...(search.retrievalPlan?.searchMode ? { searchMode: search.retrievalPlan.searchMode } : {}),
      ...(search.retrievalPlan?.threshold !== undefined
        ? { threshold: search.retrievalPlan.threshold }
        : {}),
      providerRequests: search.providerRequests ?? [],
      buildAllocationQuestionCount: denominator,
      ...(allocatedBuildWorkMs != null
        ? {
            allocatedBuildWorkMs,
            amortizedOnlinePlusBuildWorkMs: onlineQueryLatencyMs + allocatedBuildWorkMs,
          }
        : {}),
    })

    const type = byType.get(question.questionType) || {
      total: 0,
      passed: 0,
      search: [],
      answer: [],
      online: [],
      retrieval: [],
    }
    type.total++
    if (passed) type.passed++
    type.search.push(searchLatencyMs)
    type.answer.push(answerLatencyMs)
    type.online.push(onlineQueryLatencyMs)
    if (evaluate.retrievalMetrics) type.retrieval.push(evaluate.retrievalMetrics)
    byType.set(question.questionType, type)
  }

  const quality = benchmark.protocol.aggregateQuality({
    questions: evaluatedQuestions,
    evaluations: protocolEvaluations,
  })
  const byQuestionType: Record<string, QuestionTypeStats> = {}
  for (const [questionType, values] of byType) {
    byQuestionType[questionType] = {
      total: values.total,
      correct: values.passed,
      accuracy: values.total > 0 ? values.passed / values.total : 0,
      latency: {
        search: calculateLatencyStats(values.search),
        answer: calculateLatencyStats(values.answer),
        total: calculateLatencyStats(values.online),
      },
      retrieval: aggregateRetrievalMetrics(values.retrieval),
    }
  }

  const promptTokens = evaluations.map(
    (evaluation) => checkpoint.questions[evaluation.questionId].phases.answer.promptTokens
  )
  let tokenMetrics: TokenMetrics | undefined
  if (promptTokens.length > 0 && promptTokens.every((value) => value != null)) {
    const base = evaluations.map(
      (evaluation) =>
        checkpoint.questions[evaluation.questionId].phases.answer.basePromptTokens ?? 0
    )
    const context = evaluations.map(
      (evaluation) => checkpoint.questions[evaluation.questionId].phases.answer.contextTokens ?? 0
    )
    const totalTokens = (promptTokens as number[]).reduce((sum, value) => sum + value, 0)
    const basePromptTokens = base.reduce((sum, value) => sum + value, 0)
    const contextTokens = context.reduce((sum, value) => sum + value, 0)
    tokenMetrics = {
      totalTokens,
      basePromptTokens,
      contextTokens,
      avgTokensPerQuestion: totalTokens / promptTokens.length,
      avgBasePromptTokens: basePromptTokens / promptTokens.length,
      avgContextTokens: contextTokens / promptTokens.length,
    }
  }

  const totalQuestions = evaluations.length
  const correctCount = protocolEvaluations.filter((evaluation) => evaluation.passed).length
  const accuracy = totalQuestions > 0 ? correctCount / totalQuestions : 0
  const averageScore =
    totalQuestions > 0
      ? protocolEvaluations.reduce((sum, evaluation) => sum + evaluation.primaryScore, 0) /
        totalQuestions
      : 0
  const currentBuilds = buildMetrics.filter((build) => !build.reused)
  const knownBuildCosts = currentBuilds.filter((build) => build.costUsd != null)
  const totalBuildCostUsd =
    currentBuilds.length > 0 && knownBuildCosts.length === currentBuilds.length
      ? knownBuildCosts.reduce((sum, build) => sum + (build.costUsd as number), 0)
      : null
  const buildPhaseWallClockMs = checkpoint.buildPhaseAttempts.reduce(
    (sum, attempt) => sum + (attempt.durationMs ?? 0),
    0
  )
  const searchDurations = questionMetrics.map((metrics) => metrics.searchLatencyMs)
  const answerDurations = questionMetrics.map((metrics) => metrics.answerLatencyMs)
  const onlineDurations = questionMetrics.map((metrics) => metrics.onlineQueryLatencyMs)
  const evaluateDurations = questionMetrics.map((metrics) => metrics.evaluationLatencyMs)
  const queryCosts = aggregateCostCoverage(questionMetrics.map((metrics) => metrics.queryCostUsd))
  const evaluationCosts = aggregateCostCoverage(
    questionMetrics.map((metrics) => metrics.evaluationCostUsd)
  )
  const ingestDurations = currentBuilds.flatMap((build) =>
    build.reusedPhases?.ingest ? [] : [build.ingestLatencyMs]
  )
  const indexingDurations = currentBuilds.flatMap((build) =>
    build.reusedPhases?.indexing ? [] : [build.indexingLatencyMs]
  )
  const qualityPct = quality.primaryMetric
    ? Math.round(quality.primaryMetric.value * 100)
    : undefined
  const searchLatency = calculateLatencyStats(searchDurations)
  const memscore =
    tokenMetrics && qualityPct != null
      ? `${qualityPct}% / ${Math.round(searchLatency.mean)}ms / ${Math.round(tokenMetrics.avgContextTokens)}tok`
      : undefined

  return {
    provider: checkpoint.provider,
    providerPromptFingerprint: checkpoint.providerPromptFingerprint,
    benchmark: checkpoint.benchmark,
    runId: checkpoint.runId,
    dataSourceRunId: checkpoint.dataSourceRunId,
    judge: checkpoint.judge,
    answeringModel: checkpoint.answeringModel,
    answeringRuntimeIdentity: checkpoint.answeringRuntimeIdentity,
    timestamp: new Date().toISOString(),
    selectedQuestionIdsDigest: checkpoint.selectedQuestionIdsDigest,
    retrievalTopK: checkpoint.retrievalTopK,
    benchmarkScope: checkpoint.benchmarkScope,
    datasetIdentity: checkpoint.datasetIdentity as unknown as Record<string, unknown> | undefined,
    benchmarkInputFingerprint: checkpoint.benchmarkInputFingerprint,
    protocolIdentity: checkpoint.protocolIdentity as unknown as Record<string, unknown>,
    quality,
    summary: { totalQuestions, correctCount, accuracy, averageScore },
    builds: {
      uniqueBuildCount: buildMetrics.length,
      sumContainerBuildWorkMs: currentBuilds.reduce((sum, build) => sum + build.buildWorkMs, 0),
      buildPhaseWallClockMs,
      totalBuildCostUsd,
      knownCostBuildCount: knownBuildCosts.length,
      totalCostBuildCount: currentBuilds.length,
      items: buildMetrics,
    },
    costs: {
      query: queryCosts,
      evaluation: evaluationCosts,
    },
    questionMetrics,
    latency: {
      ingest: calculateLatencyStats(ingestDurations),
      indexing: calculateLatencyStats(indexingDurations),
      search: searchLatency,
      answer: calculateLatencyStats(answerDurations),
      evaluate: calculateLatencyStats(evaluateDurations),
      total: calculateLatencyStats(onlineDurations),
    },
    tokens: tokenMetrics,
    memscore,
    memscoreComponents:
      tokenMetrics && qualityPct != null
        ? {
            quality: qualityPct,
            latencyMs: searchLatency.mean,
            contextTokens: tokenMetrics.avgContextTokens,
          }
        : undefined,
    retrieval: aggregateRetrievalMetrics(allRetrievalMetrics),
    byQuestionType,
    questionTypeRegistry: benchmark.getQuestionTypes(),
    evaluations,
  }
}

export function saveReport(result: BenchmarkResult): string {
  const reportsDir = join(REPORTS_DIR, result.runId)
  if (!existsSync(reportsDir)) mkdirSync(reportsDir, { recursive: true })
  const reportPath = join(reportsDir, "report.json")
  writeFileSync(reportPath, JSON.stringify(result, null, 2))
  logger.success(`Report saved to ${reportPath}`)
  return reportPath
}

export function printReport(result: BenchmarkResult): void {
  console.log("\n" + "=".repeat(60))
  console.log("MEMORYBENCH RESULTS")
  console.log("=".repeat(60))
  console.log(`Provider: ${result.provider}`)
  console.log(`Benchmark: ${result.benchmarkScope.displayName} (${result.benchmark})`)
  console.log(`Run ID: ${result.runId}`)
  console.log(`Protocol: ${result.protocolIdentity.id}@${result.protocolIdentity.version}`)
  console.log("-".repeat(60))
  if (result.quality.primaryMetric) {
    console.log(
      `Primary ${result.quality.primaryMetric.key}: ${result.quality.primaryMetric.value.toFixed(4)}`
    )
  } else {
    console.log("Primary metric: none (official tier scores are reported separately)")
  }
  console.log(`Average question score: ${result.summary.averageScore.toFixed(4)}`)
  console.log(`Pass accuracy: ${(result.summary.accuracy * 100).toFixed(2)}%`)
  console.log(`Unique builds: ${result.builds.uniqueBuildCount}`)
  console.log(`Build work: ${result.builds.sumContainerBuildWorkMs}ms`)
  console.log(`Build phase wall-clock: ${result.builds.buildPhaseWallClockMs}ms`)
  console.log(`Online query latency (mean): ${result.latency.total.mean.toFixed(1)}ms`)
  console.log(`Offline evaluation latency (mean): ${result.latency.evaluate.mean.toFixed(1)}ms`)
  if (result.memscore) console.log(`MemScore: ${result.memscore}`)
  console.log("=".repeat(60) + "\n")
}
