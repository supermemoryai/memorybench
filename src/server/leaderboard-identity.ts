import { sha256Text, stableSha256 } from "../utils/stable"
import type { RunCheckpoint } from "../types/checkpoint"
import type { BenchmarkResult } from "../types/unified"
import type { AnsweringRuntimeIdentity } from "../types/model"
import type { BenchmarkProtocol, QuestionEvaluation } from "../types/protocol"
import type { UnifiedQuestion } from "../types/unified"
import { resolveAnsweringRuntimeIdentity } from "../utils/models"

export interface LeaderboardPrimaryMetric {
  key: string
  value: number
  higherIsBetter: boolean
}

export interface LeaderboardComparisonIdentity {
  schemaVersion: 3
  benchmark: string
  benchmarkScope: Record<string, unknown>
  datasetIdentity: Record<string, unknown>
  datasetFingerprint: string
  questionSetFingerprint: string
  benchmarkInputFingerprint: string
  protocolIdentity: Record<string, unknown>
  protocolFingerprint: string
  retrievalTopK: number | null
  judgeModel: string
  answeringModel: string
  answeringRuntimeFingerprint: string
  providerPromptFingerprint: string | null
  primaryMetric: LeaderboardPrimaryMetric
  cohortKey: string
  legacy: boolean
}

export interface LeaderboardIdentitySource {
  benchmark: string
  benchmarkScope?: Record<string, unknown>
  datasetIdentity?: Record<string, unknown>
  selectedQuestionIdsDigest?: string
  benchmarkInputFingerprint?: string
  protocolIdentity?: Record<string, unknown>
  retrievalTopK?: number
  questionMetrics?: Array<{ configuredTopK?: number }>
  judgeModel?: string
  answeringModel?: string
  answeringRuntimeIdentity?: AnsweringRuntimeIdentity
  providerPromptFingerprint?: string | null
  primaryMetric?: Partial<LeaderboardPrimaryMetric>
  accuracy: number
}

export interface RankableLeaderboardEntry {
  id: number
  benchmark: string
  accuracy: number
  judgeModel?: string
  answeringModel?: string
  providerPromptFingerprint?: string | null
  addedAt?: string
  comparisonIdentity?: LeaderboardComparisonIdentity
  quality?: {
    primaryMetric?: Partial<LeaderboardPrimaryMetric>
  }
}

export type RankedLeaderboardEntry<T> = T & {
  comparisonIdentity: LeaderboardComparisonIdentity
  cohortKey: string
  cohortRank: number
  cohortSize: number
}

export interface LeaderboardAggregationContext {
  protocol: Pick<BenchmarkProtocol, "identity" | "aggregateQuality">
  questions: UnifiedQuestion[]
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback
}

function resolveRetrievalTopK(source: LeaderboardIdentitySource): number | null {
  const reported = [
    ...new Set(
      (source.questionMetrics ?? [])
        .map((metric) => metric.configuredTopK)
        .filter(
          (value): value is number =>
            typeof value === "number" && Number.isInteger(value) && value > 0
        )
    ),
  ]

  if (reported.length > 1) {
    throw new Error(
      `Cannot publish a run with mixed retrieval Top-K values: ${reported.join(", ")}`
    )
  }

  if (
    reported.length === 1 &&
    Number.isInteger(source.retrievalTopK) &&
    source.retrievalTopK !== reported[0]
  ) {
    throw new Error(
      `Cannot publish a run whose configured retrieval Top-K (${source.retrievalTopK}) differs from its recorded question Top-K (${reported[0]})`
    )
  }

  if (reported.length === 1) return reported[0]
  return Number.isInteger(source.retrievalTopK) && (source.retrievalTopK ?? 0) > 0
    ? source.retrievalTopK!
    : null
}

/**
 * Build the immutable comparison identity stored with a leaderboard snapshot.
 * The primary metric value is deliberately excluded from cohortKey: scores vary
 * inside a cohort, while every input and metric semantic must remain identical.
 */
export function createLeaderboardComparisonIdentity(
  source: LeaderboardIdentitySource
): LeaderboardComparisonIdentity {
  const benchmarkScope = source.benchmarkScope ?? {
    displayName: source.benchmark,
    includedTiers: [],
    coverage: "subset",
  }
  const questionSetFingerprint = nonEmptyString(
    source.selectedQuestionIdsDigest,
    stableSha256({ benchmark: source.benchmark, questionSet: "unknown" })
  )
  const benchmarkInputFingerprint = nonEmptyString(
    source.benchmarkInputFingerprint,
    `derived:${stableSha256({ benchmark: source.benchmark, questionSetFingerprint })}`
  )
  const datasetIdentity = source.datasetIdentity ?? {
    identityKind: "derived-from-question-set",
    benchmark: source.benchmark,
    questionSetFingerprint,
  }
  const datasetFingerprint = nonEmptyString(
    datasetIdentity.datasetFingerprint,
    stableSha256(datasetIdentity)
  )
  const protocolIdentity = source.protocolIdentity ?? {
    id: "memorybench.legacy",
    version: "unknown",
  }
  const protocolFingerprint = stableSha256(protocolIdentity)
  const retrievalTopK = resolveRetrievalTopK(source)
  const judgeModel = nonEmptyString(source.judgeModel, "unknown")
  const answeringModel = nonEmptyString(source.answeringModel, "unknown")
  const answeringRuntimeIdentity =
    source.answeringRuntimeIdentity ?? resolveAnsweringRuntimeIdentity(answeringModel)
  const answeringRuntimeFingerprint = stableSha256(answeringRuntimeIdentity)
  const providerPromptFingerprint =
    protocolIdentity.id === "memorybench.legacy"
      ? nonEmptyString(source.providerPromptFingerprint, "unknown")
      : null
  const primaryMetric: LeaderboardPrimaryMetric = {
    key: nonEmptyString(source.primaryMetric?.key, "accuracy"),
    value: finiteNumber(source.primaryMetric?.value, source.accuracy),
    higherIsBetter: source.primaryMetric?.higherIsBetter !== false,
  }

  const cohortKey = stableSha256({
    schemaVersion: 3,
    benchmark: source.benchmark,
    benchmarkScope,
    datasetFingerprint,
    questionSetFingerprint,
    benchmarkInputFingerprint,
    protocolFingerprint,
    retrievalTopK,
    judgeModel,
    answeringModel,
    answeringRuntimeFingerprint,
    providerPromptFingerprint,
    primaryMetric: {
      key: primaryMetric.key,
      higherIsBetter: primaryMetric.higherIsBetter,
    },
  })

  return {
    schemaVersion: 3,
    benchmark: source.benchmark,
    benchmarkScope,
    datasetIdentity,
    datasetFingerprint,
    questionSetFingerprint,
    benchmarkInputFingerprint,
    protocolIdentity,
    protocolFingerprint,
    retrievalTopK,
    judgeModel,
    answeringModel,
    answeringRuntimeFingerprint,
    providerPromptFingerprint,
    primaryMetric,
    cohortKey,
    legacy:
      !source.datasetIdentity ||
      !source.protocolIdentity ||
      !source.benchmarkInputFingerprint ||
      !source.judgeModel ||
      !source.answeringModel ||
      !source.answeringRuntimeIdentity ||
      (protocolIdentity.id === "memorybench.legacy" && !source.providerPromptFingerprint),
  }
}

function approximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-12
}

function checkpointDatasetIdentity(checkpoint: RunCheckpoint): Record<string, unknown> {
  if (checkpoint.datasetIdentity) {
    return checkpoint.datasetIdentity as unknown as Record<string, unknown>
  }
  return {
    identityKind: "selected-provider-visible-haystacks-v1",
    benchmark: checkpoint.benchmark,
    selectedQuestionIdsDigest: checkpoint.selectedQuestionIdsDigest,
    builds: Object.values(checkpoint.builds)
      .map((build) => ({
        ingestionGroupId: build.ingestionGroupId,
        memberQuestionIds: build.memberQuestionIds,
        haystackFingerprint: build.haystack.fingerprint,
      }))
      .sort((left, right) => left.ingestionGroupId.localeCompare(right.ingestionGroupId)),
  }
}

/** Fail closed before a report snapshot is admitted to a ranked leaderboard. */
export function validateLeaderboardReportForPublication(
  checkpoint: RunCheckpoint,
  report: BenchmarkResult,
  evaluatedQuestionCount: number,
  aggregation: LeaderboardAggregationContext
): LeaderboardComparisonIdentity {
  const errors: string[] = []
  if (report.runId !== checkpoint.runId) errors.push("run ID")
  if (report.provider !== checkpoint.provider) errors.push("provider")
  if (report.providerPromptFingerprint !== checkpoint.providerPromptFingerprint) {
    errors.push("provider-prompt fingerprint")
  }
  if (report.benchmark !== checkpoint.benchmark) errors.push("benchmark")
  if (report.judge !== checkpoint.judge) errors.push("judge model")
  if (report.answeringModel !== checkpoint.answeringModel) errors.push("answering model")
  if (
    !report.answeringRuntimeIdentity ||
    !checkpoint.answeringRuntimeIdentity ||
    stableSha256(report.answeringRuntimeIdentity ?? null) !==
      stableSha256(checkpoint.answeringRuntimeIdentity ?? null)
  ) {
    errors.push("answering runtime")
  }
  if (stableSha256(report.benchmarkScope) !== stableSha256(checkpoint.benchmarkScope)) {
    errors.push("benchmark scope")
  }
  const effectiveDatasetIdentity = checkpointDatasetIdentity(checkpoint)
  if (checkpoint.datasetIdentity && !report.datasetIdentity) {
    errors.push("missing dataset identity")
  } else if (
    report.datasetIdentity &&
    stableSha256(report.datasetIdentity) !== stableSha256(effectiveDatasetIdentity)
  ) {
    errors.push("dataset identity")
  }
  if (stableSha256(report.protocolIdentity) !== stableSha256(checkpoint.protocolIdentity)) {
    errors.push("protocol identity")
  }
  if (stableSha256(aggregation.protocol.identity) !== stableSha256(checkpoint.protocolIdentity)) {
    errors.push("loaded aggregation protocol identity")
  }
  if (report.selectedQuestionIdsDigest !== checkpoint.selectedQuestionIdsDigest) {
    errors.push("selected-question fingerprint")
  }
  if (report.benchmarkInputFingerprint !== checkpoint.benchmarkInputFingerprint) {
    errors.push("benchmark-input fingerprint")
  }

  const selectedQuestionIds = checkpoint.targetQuestionIds?.length
    ? checkpoint.targetQuestionIds
    : Object.keys(checkpoint.questions)
  const evaluationQuestionIds = report.evaluations.map((evaluation) => evaluation.questionId)
  const metricQuestionIds = report.questionMetrics.map((metric) => metric.questionId)
  if (
    selectedQuestionIds.length !== evaluatedQuestionCount ||
    report.summary.totalQuestions !== evaluatedQuestionCount ||
    evaluationQuestionIds.length !== evaluatedQuestionCount ||
    metricQuestionIds.length !== evaluatedQuestionCount
  ) {
    errors.push("complete question count")
  }
  if (stableSha256(evaluationQuestionIds) !== checkpoint.selectedQuestionIdsDigest) {
    errors.push("evaluation question set/order")
  }
  if (stableSha256(metricQuestionIds) !== checkpoint.selectedQuestionIdsDigest) {
    errors.push("question-metric set/order")
  }

  const aggregationQuestionIds = aggregation.questions.map((question) => question.questionId)
  if (stableSha256(aggregationQuestionIds) !== checkpoint.selectedQuestionIdsDigest) {
    errors.push("aggregation question set/order")
  }

  const checkpointEvaluations: QuestionEvaluation[] = []
  for (const questionId of selectedQuestionIds) {
    const evaluation = checkpoint.questions[questionId]?.phases?.evaluate?.evaluation
    if (!evaluation) {
      errors.push(`checkpoint evaluation ${questionId}`)
      continue
    }
    checkpointEvaluations.push(evaluation)
  }

  const reportAggregationEvaluations = report.evaluations.map((evaluation) => ({
    questionId: evaluation.questionId,
    questionType: evaluation.questionType,
    primaryScore: evaluation.primaryScore ?? evaluation.score,
    passed: evaluation.passed,
    explanation: evaluation.explanation,
    metrics: evaluation.metrics,
    details: evaluation.details,
  }))
  const checkpointAggregationEvaluations = checkpointEvaluations.map((evaluation) => ({
    questionId: evaluation.questionId,
    questionType: evaluation.questionType,
    primaryScore: evaluation.primaryScore,
    passed: evaluation.passed,
    explanation: evaluation.explanation,
    metrics: evaluation.metrics,
    details: evaluation.details,
  }))
  if (
    stableSha256(reportAggregationEvaluations) !== stableSha256(checkpointAggregationEvaluations)
  ) {
    errors.push("report/checkpoint evaluations")
  }

  let expectedQuality: BenchmarkResult["quality"] | undefined
  try {
    expectedQuality = aggregation.protocol.aggregateQuality({
      questions: aggregation.questions,
      evaluations: checkpointEvaluations,
    })
    if (stableSha256(report.quality) !== stableSha256(expectedQuality)) {
      errors.push("protocol quality aggregation")
    }
  } catch (error) {
    errors.push(
      `protocol quality aggregation failed: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  const primaryMetric = expectedQuality?.primaryMetric
  if (!primaryMetric || !primaryMetric.key.trim() || !Number.isFinite(primaryMetric.value)) {
    errors.push("finite scalar primary metric")
  }
  if (checkpoint.protocolIdentity.id === "beam-paper") {
    if (primaryMetric?.key !== "beamScore") {
      errors.push("official complete-tier BEAM primary metric")
    }
    const includedTiers = checkpoint.benchmarkScope.includedTiers
    const orderedQuestionIdsDigest = effectiveDatasetIdentity.orderedQuestionIdsDigest
    const tier = includedTiers.length === 1 ? includedTiers[0] : undefined
    const expectedQuestionCount = tier === "1M" ? 700 : tier === "10M" ? 200 : undefined
    const officialTierDigest =
      tier && orderedQuestionIdsDigest && typeof orderedQuestionIdsDigest === "object"
        ? (orderedQuestionIdsDigest as Record<string, unknown>)[tier]
        : undefined
    if (
      (tier !== "1M" && tier !== "10M") ||
      selectedQuestionIds.length !== expectedQuestionCount ||
      typeof officialTierDigest !== "string" ||
      sha256Text(selectedQuestionIds.join("\n")) !== officialTierDigest
    ) {
      errors.push("official complete-tier BEAM question set")
    }
  }
  const invalidEvaluation = report.evaluations.some(
    (evaluation) =>
      typeof evaluation.passed !== "boolean" || !Number.isFinite(evaluation.primaryScore)
  )
  if (invalidEvaluation) errors.push("complete protocol evaluations")

  const correctCount = checkpointEvaluations.filter((evaluation) => evaluation.passed).length
  const averageScore =
    checkpointEvaluations.length > 0
      ? checkpointEvaluations.reduce((sum, evaluation) => sum + evaluation.primaryScore, 0) /
        checkpointEvaluations.length
      : 0
  const accuracy =
    checkpointEvaluations.length > 0 ? correctCount / checkpointEvaluations.length : 0
  if (report.summary.correctCount !== correctCount) errors.push("correct-count aggregation")
  if (!approximatelyEqual(report.summary.accuracy, accuracy)) errors.push("accuracy aggregation")
  if (!approximatelyEqual(report.summary.averageScore, averageScore)) {
    errors.push("average-score aggregation")
  }

  let identity: LeaderboardComparisonIdentity | undefined
  try {
    identity = createLeaderboardComparisonIdentity({
      benchmark: report.benchmark,
      benchmarkScope: report.benchmarkScope,
      datasetIdentity: effectiveDatasetIdentity,
      selectedQuestionIdsDigest: report.selectedQuestionIdsDigest,
      benchmarkInputFingerprint: report.benchmarkInputFingerprint,
      protocolIdentity: report.protocolIdentity,
      retrievalTopK: report.retrievalTopK,
      questionMetrics: report.questionMetrics,
      judgeModel: report.judge,
      answeringModel: report.answeringModel,
      answeringRuntimeIdentity: report.answeringRuntimeIdentity,
      providerPromptFingerprint: report.providerPromptFingerprint,
      primaryMetric: primaryMetric!,
      accuracy: report.summary.accuracy,
    })
    if (checkpoint.retrievalTopK != null && identity.retrievalTopK !== checkpoint.retrievalTopK) {
      errors.push("retrieval Top-K")
    }
    if (identity.retrievalTopK == null) errors.push("recorded retrieval Top-K")
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "comparison identity")
  }

  if (errors.length > 0 || !identity) {
    throw new Error(`Report is not publishable: ${[...new Set(errors)].join(", ")}`)
  }
  return identity
}

function fallbackIdentity(entry: RankableLeaderboardEntry): LeaderboardComparisonIdentity {
  const primary = entry.quality?.primaryMetric
  return createLeaderboardComparisonIdentity({
    benchmark: entry.benchmark,
    accuracy: entry.accuracy,
    judgeModel: entry.judgeModel,
    answeringModel: entry.answeringModel,
    providerPromptFingerprint: entry.providerPromptFingerprint,
    primaryMetric: {
      key: primary?.key,
      value: primary?.value,
      higherIsBetter: primary?.higherIsBetter,
    },
  })
}

/** Sort and rank only inside exact comparison cohorts. Cross-cohort order is lexical. */
export function rankLeaderboardEntries<T extends RankableLeaderboardEntry>(
  entries: T[]
): Array<RankedLeaderboardEntry<T>> {
  const cohorts = new Map<string, Array<{ entry: T; identity: LeaderboardComparisonIdentity }>>()

  for (const entry of entries) {
    const identity = entry.comparisonIdentity ?? fallbackIdentity(entry)
    const values = cohorts.get(identity.cohortKey) ?? []
    values.push({ entry, identity })
    cohorts.set(identity.cohortKey, values)
  }

  const result: Array<RankedLeaderboardEntry<T>> = []
  for (const cohortKey of [...cohorts.keys()].sort()) {
    const cohort = cohorts.get(cohortKey)!
    const higherIsBetter = cohort[0].identity.primaryMetric.higherIsBetter
    cohort.sort((left, right) => {
      const leftValue = left.identity.primaryMetric.value
      const rightValue = right.identity.primaryMetric.value
      const scoreOrder = higherIsBetter ? rightValue - leftValue : leftValue - rightValue
      if (scoreOrder !== 0) return scoreOrder
      const dateOrder = (left.entry.addedAt ?? "").localeCompare(right.entry.addedAt ?? "")
      return dateOrder || left.entry.id - right.entry.id
    })

    let priorValue: number | undefined
    let priorRank = 0
    cohort.forEach(({ entry, identity }, index) => {
      const value = identity.primaryMetric.value
      const rank = priorValue !== undefined && value === priorValue ? priorRank : index + 1
      result.push({
        ...entry,
        comparisonIdentity: identity,
        cohortKey,
        cohortRank: rank,
        cohortSize: cohort.length,
      })
      priorValue = value
      priorRank = rank
    })
  }

  return result
}
