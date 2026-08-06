import type { ProviderName } from "../types/provider"
import type { BenchmarkName, BenchmarkScope, DatasetIdentity } from "../types/benchmark"
import type { SamplingConfig } from "../types/checkpoint"
import type { ProtocolIdentity } from "../types/protocol"
import type { AnsweringRuntimeIdentity } from "../types/model"
import type { BenchmarkResult } from "../types/unified"
import {
  orchestrator,
  CheckpointManager,
  resolveEffectiveRetrievalTopK,
  type OrchestratorOptions,
} from "./index"
import { createBenchmark } from "../benchmarks"
import { createProvider } from "../providers"
import { fingerprintProviderPrompts } from "../providers/prompt-identity"
import { logger } from "../utils/logger"
import { resolveAnsweringRuntimeIdentity, resolveModel } from "../utils/models"
import { stableSha256 } from "../utils/stable"
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs"
import { join } from "path"
import { startRun, endRun } from "../server/runState"
import {
  canonicalizeSelectedQuestionIds,
  fingerprintSelectedBenchmarkInput,
} from "./input-identity"

const checkpointManager = new CheckpointManager()

const COMPARE_DIR = "./data/compare"
const RUNS_DIR = "./data/runs"

export interface CompareManifest {
  compareId: string
  createdAt: string
  updatedAt: string
  benchmark: string
  judge: string
  answeringModel: string
  answeringRuntimeIdentity: AnsweringRuntimeIdentity
  sampling?: SamplingConfig
  targetQuestionIds: string[]
  dataPath?: string
  datasetRevision?: string
  retrievalTopK: number
  datasetIdentity?: DatasetIdentity
  benchmarkInputFingerprint: string
  benchmarkScope: BenchmarkScope
  protocolIdentity: ProtocolIdentity
  selectedQuestionIdsDigest: string
  runs: Array<{
    provider: string
    runId: string
    providerPromptFingerprint: string
  }>
}

export interface CompareOptions {
  providers: ProviderName[]
  benchmark: BenchmarkName
  judgeModel: string
  answeringModel: string
  sampling?: SamplingConfig
  force?: boolean
  dataPath?: string
  datasetRevision?: string
  retrievalTopK?: number
}

export interface CompareResult {
  compareId: string
  manifest: CompareManifest
  successes: number
  failures: number
}

type ComparisonReport = { provider: string; report: BenchmarkResult }

type ScalarPrimaryMetric = NonNullable<BenchmarkResult["quality"]["primaryMetric"]>

export interface ComparisonInputIdentity {
  benchmark: string
  benchmarkScopeFingerprint: string
  datasetFingerprint: string
  benchmarkInputFingerprint: string
  questionSetFingerprint: string
  protocolFingerprint: string
  retrievalTopK: number
  judge: string
  answeringModel: string
  answeringRuntimeFingerprint: string
  primaryMetricKey: string
  primaryMetricHigherIsBetter: boolean
  cohortKey: string
}

export interface PrimaryMetricComparisonRow extends ComparisonReport {
  primaryMetric?: ScalarPrimaryMetric
  passAccuracy: number
  deltaFromBest?: number
}

export interface PrimaryMetricComparison {
  comparable: boolean
  identity?: Pick<ScalarPrimaryMetric, "key" | "higherIsBetter">
  identities: string[]
  mismatchReasons: string[]
  rows: PrimaryMetricComparisonRow[]
  bestValue?: number
  winners: string[]
}

function resolveReportRetrievalTopK(report: BenchmarkResult): number {
  const recorded = [
    ...new Set(
      report.questionMetrics
        .map((metric) => metric.configuredTopK)
        .filter((value) => Number.isInteger(value) && value > 0)
    ),
  ]
  if (recorded.length !== 1) {
    throw new Error(
      recorded.length === 0
        ? "report has no recorded retrieval Top-K"
        : `report mixes retrieval Top-K values (${recorded.join(", ")})`
    )
  }
  if (report.retrievalTopK != null && report.retrievalTopK !== recorded[0]) {
    throw new Error(
      `report retrieval Top-K ${report.retrievalTopK} disagrees with question metrics ${recorded[0]}`
    )
  }
  return recorded[0]
}

export function getComparisonInputIdentity(report: BenchmarkResult): ComparisonInputIdentity {
  const primaryMetric = report.quality.primaryMetric
  if (!primaryMetric) throw new Error("report has no scalar primary metric")
  if (!Number.isFinite(primaryMetric.value)) {
    throw new Error("report primary metric is not finite")
  }
  if (!report.selectedQuestionIdsDigest?.trim()) {
    throw new Error("report has no selected-question fingerprint")
  }
  if (!report.benchmarkInputFingerprint?.trim()) {
    throw new Error("report has no derived benchmark-input identity")
  }
  if (!report.judge?.trim()) throw new Error("report has no judge model")
  if (!report.answeringModel?.trim()) throw new Error("report has no answering model")
  if (!report.answeringRuntimeIdentity) {
    throw new Error("report has no resolved answering runtime identity")
  }
  if (
    report.protocolIdentity.id === "memorybench.legacy" &&
    !report.providerPromptFingerprint?.trim()
  ) {
    throw new Error("legacy report has no provider-prompt fingerprint")
  }

  const datasetFingerprint = report.datasetIdentity
    ? typeof report.datasetIdentity.datasetFingerprint === "string" &&
      report.datasetIdentity.datasetFingerprint.trim()
      ? report.datasetIdentity.datasetFingerprint
      : stableSha256(report.datasetIdentity)
    : `derived:${report.benchmarkInputFingerprint}`
  const identityWithoutKey = {
    benchmark: report.benchmark,
    benchmarkScopeFingerprint: stableSha256(report.benchmarkScope),
    datasetFingerprint,
    benchmarkInputFingerprint: report.benchmarkInputFingerprint,
    questionSetFingerprint: report.selectedQuestionIdsDigest,
    protocolFingerprint: stableSha256(report.protocolIdentity),
    retrievalTopK: resolveReportRetrievalTopK(report),
    judge: report.judge,
    answeringModel: report.answeringModel,
    answeringRuntimeFingerprint: stableSha256(report.answeringRuntimeIdentity),
    providerPromptFingerprint:
      report.protocolIdentity.id === "memorybench.legacy" ? report.providerPromptFingerprint : null,
    primaryMetricKey: primaryMetric.key,
    primaryMetricHigherIsBetter: primaryMetric.higherIsBetter,
  }
  return {
    ...identityWithoutKey,
    cohortKey: stableSha256(identityWithoutKey),
  }
}

export function comparePrimaryMetrics(
  reports: ComparisonReport[],
  expectedReportCount = reports.length
): PrimaryMetricComparison {
  const rows = reports.map(({ provider, report }) => ({
    provider,
    report,
    primaryMetric: report.quality.primaryMetric,
    passAccuracy: report.summary.accuracy,
  }))
  const mismatchReasons: string[] = []
  const inputIdentities = rows.flatMap(({ provider, report }) => {
    try {
      return [getComparisonInputIdentity(report)]
    } catch (error) {
      mismatchReasons.push(
        `${provider}: ${error instanceof Error ? error.message : "invalid comparison identity"}`
      )
      return []
    }
  })
  const identities = [...new Set(inputIdentities.map((identity) => identity.cohortKey))]
  if (rows.length === 0) mismatchReasons.push("no reports")
  if (rows.length !== expectedReportCount) {
    mismatchReasons.push(
      `only ${rows.length} of ${expectedReportCount} provider reports are complete`
    )
  }
  if (expectedReportCount < 2) mismatchReasons.push("comparison requires at least two providers")
  if (inputIdentities.length === rows.length && identities.length > 1) {
    mismatchReasons.push(
      "dataset, transformed benchmark input, question set, protocol, retrieval Top-K, judge, answering model, provider prompt, or primary metric semantics differ"
    )
  }
  if (
    rows.length === 0 ||
    rows.length !== expectedReportCount ||
    expectedReportCount < 2 ||
    inputIdentities.length !== rows.length ||
    identities.length !== 1
  ) {
    return { comparable: false, identities, mismatchReasons, rows, winners: [] }
  }

  const firstPrimaryMetric = rows[0].primaryMetric!
  const identity = {
    key: firstPrimaryMetric.key,
    higherIsBetter: firstPrimaryMetric.higherIsBetter,
  }
  const ranked = rows
    .map((row, originalIndex) => ({ row, originalIndex }))
    .sort((left, right) => {
      const delta = identity.higherIsBetter
        ? right.row.primaryMetric!.value - left.row.primaryMetric!.value
        : left.row.primaryMetric!.value - right.row.primaryMetric!.value
      return delta || left.originalIndex - right.originalIndex
    })
    .map(({ row }) => row)
  const bestValue = ranked[0].primaryMetric!.value
  const rankedWithDeltas = ranked.map((row) => ({
    ...row,
    deltaFromBest: row.primaryMetric!.value - bestValue,
  }))

  return {
    comparable: true,
    identity,
    identities,
    mismatchReasons,
    rows: rankedWithDeltas,
    bestValue,
    winners: rankedWithDeltas
      .filter(({ primaryMetric }) => primaryMetric!.value === bestValue)
      .map(({ provider }) => provider),
  }
}

function getQuestionTypeQuality(
  report: BenchmarkResult,
  questionType: string
): {
  value?: number
  key: string
  passAccuracy?: number
} {
  const qualitySlice = report.quality.bySlice?.[questionType]
  if (typeof qualitySlice?.averageScore === "number") {
    return {
      value: qualitySlice.averageScore,
      key: "averageScore",
      passAccuracy:
        typeof qualitySlice.passAccuracy === "number"
          ? qualitySlice.passAccuracy
          : report.byQuestionType[questionType]?.accuracy,
    }
  }
  const legacyAccuracy = report.byQuestionType[questionType]?.accuracy
  return {
    value: legacyAccuracy,
    key: "accuracy",
    passAccuracy: legacyAccuracy,
  }
}

function generateCompareId(): string {
  const now = new Date()
  const date = now.toISOString().slice(0, 10).replace(/-/g, "")
  const time = now.toISOString().slice(11, 19).replace(/:/g, "")
  return `compare-${date}-${time}`
}

function selectQuestionsBySampling(
  allQuestions: { questionId: string; questionType: string }[],
  sampling: SamplingConfig
): string[] {
  if (sampling.mode === "full") {
    return allQuestions.map((q) => q.questionId)
  }
  if (sampling.mode === "limit" && sampling.limit) {
    return allQuestions.slice(0, sampling.limit).map((q) => q.questionId)
  }
  if (sampling.mode === "sample" && sampling.perCategory) {
    const byType: Record<string, { questionId: string; questionType: string }[]> = {}
    for (const q of allQuestions) {
      if (!byType[q.questionType]) byType[q.questionType] = []
      byType[q.questionType].push(q)
    }
    const selected: string[] = []
    for (const questions of Object.values(byType)) {
      if (sampling.sampleType === "random") {
        const shuffled = [...questions].sort(() => Math.random() - 0.5)
        selected.push(...shuffled.slice(0, sampling.perCategory).map((q) => q.questionId))
      } else {
        selected.push(...questions.slice(0, sampling.perCategory).map((q) => q.questionId))
      }
    }
    return selected
  }
  return allQuestions.map((q) => q.questionId)
}

export function assertComparisonReportMatchesManifest(
  manifest: CompareManifest,
  run: CompareManifest["runs"][number],
  report: BenchmarkResult
): void {
  const mismatches: string[] = []
  if (report.runId !== run.runId) mismatches.push("run ID")
  if (report.provider !== run.provider) mismatches.push("provider")
  if (report.benchmark !== manifest.benchmark) mismatches.push("benchmark")
  if (report.judge !== manifest.judge) mismatches.push("judge model")
  if (report.answeringModel !== manifest.answeringModel) mismatches.push("answering model")
  if (
    stableSha256(report.answeringRuntimeIdentity ?? null) !==
    stableSha256(manifest.answeringRuntimeIdentity)
  ) {
    mismatches.push("answering runtime")
  }
  if (report.providerPromptFingerprint !== run.providerPromptFingerprint) {
    mismatches.push("provider-prompt fingerprint")
  }
  if (stableSha256(report.benchmarkScope) !== stableSha256(manifest.benchmarkScope)) {
    mismatches.push("benchmark scope")
  }
  if (
    stableSha256(report.datasetIdentity ?? null) !== stableSha256(manifest.datasetIdentity ?? null)
  ) {
    mismatches.push("dataset identity")
  }
  if (report.benchmarkInputFingerprint !== manifest.benchmarkInputFingerprint) {
    mismatches.push("benchmark input")
  }
  if (stableSha256(report.protocolIdentity) !== stableSha256(manifest.protocolIdentity)) {
    mismatches.push("protocol identity")
  }
  if (report.selectedQuestionIdsDigest !== manifest.selectedQuestionIdsDigest) {
    mismatches.push("selected-question fingerprint")
  }
  let reportedTopK: number | undefined
  try {
    reportedTopK = resolveReportRetrievalTopK(report)
  } catch (error) {
    mismatches.push(error instanceof Error ? error.message : "retrieval Top-K")
  }
  if (reportedTopK !== manifest.retrievalTopK) mismatches.push("retrieval Top-K")
  if (report.summary.totalQuestions !== manifest.targetQuestionIds.length) {
    mismatches.push("question count")
  }
  const evaluationQuestionIds = report.evaluations.map((evaluation) => evaluation.questionId)
  if (
    evaluationQuestionIds.length !== manifest.targetQuestionIds.length ||
    stableSha256(evaluationQuestionIds) !== manifest.selectedQuestionIdsDigest
  ) {
    mismatches.push("evaluation question set/order")
  }
  const metricQuestionIds = report.questionMetrics.map((metric) => metric.questionId)
  if (
    metricQuestionIds.length !== manifest.targetQuestionIds.length ||
    stableSha256(metricQuestionIds) !== manifest.selectedQuestionIdsDigest
  ) {
    mismatches.push("question-metric set/order")
  }
  if (mismatches.length > 0) {
    throw new Error(
      `Report ${report.runId} does not match comparison ${manifest.compareId}: ${[
        ...new Set(mismatches),
      ].join(", ")}`
    )
  }
}

export class BatchManager {
  constructor(
    private readonly runner: { run(options: OrchestratorOptions): Promise<void> } = orchestrator
  ) {}

  private getComparePath(compareId: string): string {
    return join(COMPARE_DIR, compareId)
  }

  private getManifestPath(compareId: string): string {
    return join(this.getComparePath(compareId), "manifest.json")
  }

  exists(compareId: string): boolean {
    return existsSync(this.getManifestPath(compareId))
  }

  saveManifest(manifest: CompareManifest): void {
    const comparePath = this.getComparePath(manifest.compareId)
    if (!existsSync(comparePath)) {
      mkdirSync(comparePath, { recursive: true })
    }
    manifest.updatedAt = new Date().toISOString()
    writeFileSync(this.getManifestPath(manifest.compareId), JSON.stringify(manifest, null, 2))
  }

  loadManifest(compareId: string): CompareManifest | null {
    const path = this.getManifestPath(compareId)
    if (!existsSync(path)) return null
    try {
      return JSON.parse(readFileSync(path, "utf8")) as CompareManifest
    } catch {
      return null
    }
  }

  delete(compareId: string): void {
    // Read the run ids before removing the manifest that owns them.
    const manifest = this.loadManifest(compareId)
    const comparePath = this.getComparePath(compareId)
    if (existsSync(comparePath)) {
      rmSync(comparePath, { recursive: true })
    }
    if (manifest) {
      for (const run of manifest.runs) {
        const runPath = join(RUNS_DIR, run.runId)
        if (existsSync(runPath)) {
          rmSync(runPath, { recursive: true })
        }
      }
    }
  }

  loadReport(runId: string): BenchmarkResult | null {
    const reportPath = join(RUNS_DIR, runId, "report.json")
    if (!existsSync(reportPath)) return null
    try {
      return JSON.parse(readFileSync(reportPath, "utf8")) as BenchmarkResult
    } catch {
      return null
    }
  }

  async compare(options: CompareOptions): Promise<CompareResult> {
    const manifest = await this.createManifest(options)
    try {
      await this.preflightRuns(manifest)
      return this.executeRuns(manifest)
    } catch (error) {
      this.delete(manifest.compareId)
      throw error
    }
  }

  async createManifest(options: CompareOptions): Promise<CompareManifest> {
    const {
      providers,
      benchmark,
      judgeModel,
      answeringModel,
      sampling,
      dataPath,
      datasetRevision,
      retrievalTopK,
    } = options
    const compareId = generateCompareId()

    logger.info(`Loading benchmark: ${benchmark}`)
    const benchmarkInstance = createBenchmark(benchmark)
    await benchmarkInstance.load({ dataPath, datasetRevision, retrievalTopK })
    const requiredJudge = benchmarkInstance.protocol.requiredJudge
    if (requiredJudge) {
      const resolvedJudge = resolveModel(judgeModel)
      if (
        resolvedJudge.provider !== requiredJudge.provider ||
        resolvedJudge.id !== requiredJudge.modelId
      ) {
        throw new Error(
          `Protocol ${benchmarkInstance.protocol.identity.id} requires judge ${requiredJudge.provider}/${requiredJudge.modelId}; received ${resolvedJudge.provider}/${resolvedJudge.id}`
        )
      }
    }
    const allQuestions = benchmarkInstance.getQuestions()

    let requestedQuestionIds: string[]
    if (sampling) {
      requestedQuestionIds = selectQuestionsBySampling(allQuestions, sampling)
    } else {
      requestedQuestionIds = allQuestions.map((q) => q.questionId)
    }
    const targetQuestionIds = canonicalizeSelectedQuestionIds(allQuestions, requestedQuestionIds)
    if (targetQuestionIds.length === 0) {
      throw new Error("Comparison question selection is empty")
    }
    if (new Set(providers).size !== providers.length) {
      throw new Error("Comparison providers must be unique")
    }
    const questionById = new Map(allQuestions.map((question) => [question.questionId, question]))
    const selectedQuestions = targetQuestionIds.map((questionId) => {
      const question = questionById.get(questionId)
      if (!question) throw new Error(`Unknown comparison question ID: ${questionId}`)
      benchmarkInstance.protocol.validateQuestion(question)
      return question
    })
    const benchmarkInputFingerprint = fingerprintSelectedBenchmarkInput(
      benchmarkInstance,
      selectedQuestions
    )
    const resolvedRetrievalTopK = resolveEffectiveRetrievalTopK(
      benchmarkInstance.protocol,
      selectedQuestions,
      retrievalTopK
    )

    const manifest: CompareManifest = {
      compareId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      benchmark,
      judge: judgeModel,
      answeringModel,
      answeringRuntimeIdentity: resolveAnsweringRuntimeIdentity(answeringModel),
      sampling,
      targetQuestionIds,
      dataPath,
      datasetRevision,
      retrievalTopK: resolvedRetrievalTopK,
      datasetIdentity: benchmarkInstance.getDatasetIdentity?.(),
      benchmarkInputFingerprint,
      benchmarkScope: benchmarkInstance.scope,
      protocolIdentity: benchmarkInstance.protocol.identity,
      selectedQuestionIdsDigest: stableSha256(targetQuestionIds),
      runs: providers.map((provider) => ({
        provider,
        runId: `${compareId}-${provider}`,
        providerPromptFingerprint: fingerprintProviderPrompts(createProvider(provider).prompts),
      })),
    }

    this.saveManifest(manifest)
    logger.info(`Created comparison: ${compareId}`)
    logger.info(`Providers: ${providers.join(", ")}`)
    logger.info(`Questions: ${targetQuestionIds.length}`)

    return manifest
  }

  private runOptions(
    manifest: CompareManifest,
    run: CompareManifest["runs"][number],
    preflightOnly = false
  ): OrchestratorOptions {
    return {
      provider: run.provider as ProviderName,
      benchmark: manifest.benchmark as BenchmarkName,
      judgeModel: manifest.judge,
      runId: run.runId,
      answeringModel: manifest.answeringModel,
      questionIds: manifest.targetQuestionIds,
      dataPath: manifest.dataPath,
      datasetRevision: manifest.datasetRevision,
      retrievalTopK: manifest.retrievalTopK,
      preflightOnly,
    }
  }

  /** Durably validate every run without initializing providers or starting ingestion. */
  async preflightRuns(manifest: CompareManifest): Promise<void> {
    const results = await Promise.allSettled(
      manifest.runs.map((run) => this.runner.run(this.runOptions(manifest, run, true)))
    )
    const failures = results.flatMap((result, index) =>
      result.status === "rejected"
        ? [
            `${manifest.runs[index].provider}: ${
              result.reason instanceof Error ? result.reason.message : String(result.reason)
            }`,
          ]
        : []
    )
    if (failures.length > 0) {
      throw new Error(`Comparison preflight failed (${failures.join("; ")})`)
    }
  }

  async resume(compareId: string, force?: boolean): Promise<CompareResult> {
    if (force) {
      this.delete(compareId)
      throw new Error(`Comparison ${compareId} deleted with --force. Start a new comparison.`)
    }

    const manifest = this.loadManifest(compareId)
    if (!manifest) {
      throw new Error(`Comparison not found: ${compareId}`)
    }

    logger.info(`Resuming comparison: ${manifest.compareId}`)
    return this.executeRuns(manifest)
  }

  async executeRuns(manifest: CompareManifest): Promise<CompareResult> {
    logger.info(`Starting ${manifest.runs.length} parallel runs...`)

    // Register all runs in activeRuns before starting
    for (const run of manifest.runs) {
      startRun(run.runId, manifest.benchmark)
    }

    const results = await Promise.allSettled(
      manifest.runs.map(async (run) => {
        try {
          return await this.runner.run(this.runOptions(manifest, run))
        } catch (error) {
          // Update checkpoint status to persist the failure state
          const checkpoint = checkpointManager.load(run.runId)
          if (checkpoint) {
            checkpointManager.updateStatus(checkpoint, "failed")
            await checkpointManager.flush(run.runId)
          }
          throw error
        } finally {
          // Always unregister the run when done (success or failure)
          endRun(run.runId)
        }
      })
    )

    const failures = results.filter((r) => r.status === "rejected")
    const successes = results.filter((r) => r.status === "fulfilled").length

    if (failures.length > 0) {
      logger.warn(`${failures.length} run(s) failed`)
      for (let i = 0; i < results.length; i++) {
        const result = results[i]
        if (result.status === "rejected") {
          logger.error(`  ${manifest.runs[i].provider}: ${result.reason}`)
        }
      }
    }

    if (successes > 0) {
      logger.success(`${successes} run(s) completed successfully`)
    }

    this.saveManifest(manifest)

    return {
      compareId: manifest.compareId,
      manifest,
      successes,
      failures: failures.length,
    }
  }

  getReports(manifest: CompareManifest): Array<{ provider: string; report: BenchmarkResult }> {
    const reports: Array<{ provider: string; report: BenchmarkResult }> = []
    for (const run of manifest.runs) {
      const report = this.loadReport(run.runId)
      if (report) {
        assertComparisonReportMatchesManifest(manifest, run, report)
        reports.push({ provider: run.provider, report })
      }
    }
    return reports
  }

  printComparisonReport(manifest: CompareManifest): void {
    const reports = this.getReports(manifest)

    if (reports.length === 0) {
      logger.error("No reports found to compare")
      return
    }

    const pad = (s: string, n: number) => s.padEnd(n)
    const padNum = (n: number, width: number) => n.toString().padStart(width)
    const padPct = (n: number, width: number) => `${(n * 100).toFixed(1)}%`.padStart(width)

    console.log("\n" + "═".repeat(80))
    console.log(`                    COMPARISON: ${manifest.compareId}`)
    console.log(
      `                    Benchmark: ${manifest.benchmark} | Questions: ${manifest.targetQuestionIds.length} | Judge: ${manifest.judge}`
    )
    console.log("═".repeat(80))

    const primaryComparison = comparePrimaryMetrics(reports, manifest.runs.length)
    const metricWidth = Math.max(
      "Metric".length,
      ...primaryComparison.rows.map(({ primaryMetric }) => (primaryMetric?.key ?? "none").length)
    )
    const passValues = primaryComparison.rows.map(
      ({ report, passAccuracy }) =>
        `${(passAccuracy * 100).toFixed(1)}% (${report.summary.correctCount}/${report.summary.totalQuestions})`
    )
    const passWidth = Math.max("Pass accuracy".length, ...passValues.map((value) => value.length))
    const qualityBorder = (left: string, middle: string, right: string) =>
      left +
      [17, 12, metricWidth + 2, 12, passWidth + 2].map((width) => "─".repeat(width)).join(middle) +
      right
    const metricDirection = primaryComparison.identity
      ? `${primaryComparison.identity.key} (${primaryComparison.identity.higherIsBetter ? "higher" : "lower"} is better)`
      : "incomparable primary metrics"

    console.log(`\nQUALITY — ${metricDirection}`)
    if (!primaryComparison.comparable) {
      console.log(
        `Reports are not like-for-like (${primaryComparison.mismatchReasons.join("; ")}); preserving provider order and suppressing ranking, deltas, and winner.`
      )
    }
    console.log(qualityBorder("┌", "┬", "┐"))
    console.log(
      "│ " +
        pad("Provider", 15) +
        " │ " +
        pad("Primary", 10) +
        " │ " +
        pad("Metric", metricWidth) +
        " │ " +
        pad("Δ best", 10) +
        " │ " +
        pad("Pass accuracy", passWidth) +
        " │"
    )
    console.log(qualityBorder("├", "┼", "┤"))
    for (const [index, row] of primaryComparison.rows.entries()) {
      const passAccuracy = passValues[index]
      const delta =
        row.deltaFromBest === undefined
          ? "—"
          : `${row.deltaFromBest > 0 ? "+" : ""}${row.deltaFromBest.toFixed(4)}`
      const best = primaryComparison.winners.includes(row.provider) ? " ←" : ""
      const primaryValue = row.primaryMetric ? `${row.primaryMetric.value.toFixed(4)}${best}` : "—"
      console.log(
        "│ " +
          pad(row.provider, 15) +
          " │ " +
          primaryValue.padStart(10) +
          " │ " +
          pad(row.primaryMetric?.key ?? "none", metricWidth) +
          " │ " +
          delta.padStart(10) +
          " │ " +
          passAccuracy.padStart(passWidth) +
          " │"
      )
    }
    console.log(qualityBorder("└", "┴", "┘"))

    console.log("\nLATENCY (avg ms)")
    console.log(
      "┌" +
        "─".repeat(17) +
        "┬" +
        "─".repeat(9) +
        "┬" +
        "─".repeat(9) +
        "┬" +
        "─".repeat(9) +
        "┬" +
        "─".repeat(10) +
        "┬" +
        "─".repeat(9) +
        "┐"
    )
    console.log(
      "│ " +
        pad("Provider", 15) +
        " │ " +
        pad("Ingest", 7) +
        " │ " +
        pad("Search", 7) +
        " │ " +
        pad("Answer", 7) +
        " │ " +
        pad("Evaluate", 8) +
        " │ " +
        pad("Total", 7) +
        " │"
    )
    console.log(
      "├" +
        "─".repeat(17) +
        "┼" +
        "─".repeat(9) +
        "┼" +
        "─".repeat(9) +
        "┼" +
        "─".repeat(9) +
        "┼" +
        "─".repeat(10) +
        "┼" +
        "─".repeat(9) +
        "┤"
    )

    const latencyMins = {
      ingest: Math.min(...reports.map((r) => r.report.latency.ingest.mean)),
      search: Math.min(...reports.map((r) => r.report.latency.search.mean)),
      answer: Math.min(...reports.map((r) => r.report.latency.answer.mean)),
      evaluate: Math.min(...reports.map((r) => r.report.latency.evaluate.mean)),
      total: Math.min(...reports.map((r) => r.report.latency.total.mean)),
    }

    for (const { provider, report } of reports) {
      const ingestMark = report.latency.ingest.mean === latencyMins.ingest ? "←" : " "
      const searchMark = report.latency.search.mean === latencyMins.search ? "←" : " "
      const answerMark = report.latency.answer.mean === latencyMins.answer ? "←" : " "
      const evaluateMark = report.latency.evaluate.mean === latencyMins.evaluate ? "←" : " "
      const totalMark = report.latency.total.mean === latencyMins.total ? "←" : " "
      console.log(
        "│ " +
          pad(provider, 15) +
          " │ " +
          padNum(report.latency.ingest.mean, 6) +
          ingestMark +
          " │ " +
          padNum(report.latency.search.mean, 6) +
          searchMark +
          " │ " +
          padNum(report.latency.answer.mean, 6) +
          answerMark +
          " │ " +
          padNum(report.latency.evaluate.mean, 7) +
          evaluateMark +
          " │ " +
          padNum(report.latency.total.mean, 6) +
          totalMark +
          " │"
      )
    }
    console.log(
      "└" +
        "─".repeat(17) +
        "┴" +
        "─".repeat(9) +
        "┴" +
        "─".repeat(9) +
        "┴" +
        "─".repeat(9) +
        "┴" +
        "─".repeat(10) +
        "┴" +
        "─".repeat(9) +
        "┘"
    )

    const hasRetrieval = reports.some((r) => r.report.retrieval)
    if (hasRetrieval) {
      const k = reports.find((r) => r.report.retrieval)?.report.retrieval?.k || 10
      console.log(`\nRETRIEVAL METRICS (K=${k})`)
      console.log(
        "┌" +
          "─".repeat(17) +
          "┬" +
          "─".repeat(9) +
          "┬" +
          "─".repeat(11) +
          "┬" +
          "─".repeat(10) +
          "┬" +
          "─".repeat(9) +
          "┬" +
          "─".repeat(9) +
          "┬" +
          "─".repeat(9) +
          "┐"
      )
      console.log(
        "│ " +
          pad("Provider", 15) +
          " │ " +
          pad("Hit@K", 7) +
          " │ " +
          pad("Precision", 9) +
          " │ " +
          pad("Recall", 8) +
          " │ " +
          pad("F1", 7) +
          " │ " +
          pad("MRR", 7) +
          " │ " +
          pad("NDCG", 7) +
          " │"
      )
      console.log(
        "├" +
          "─".repeat(17) +
          "┼" +
          "─".repeat(9) +
          "┼" +
          "─".repeat(11) +
          "┼" +
          "─".repeat(10) +
          "┼" +
          "─".repeat(9) +
          "┼" +
          "─".repeat(9) +
          "┼" +
          "─".repeat(9) +
          "┤"
      )

      for (const { provider, report } of reports) {
        if (report.retrieval) {
          const r = report.retrieval
          console.log(
            "│ " +
              pad(provider, 15) +
              " │ " +
              padPct(r.hitAtK, 7) +
              " │ " +
              padPct(r.precisionAtK, 9) +
              " │ " +
              padPct(r.recallAtK, 8) +
              " │ " +
              padPct(r.f1AtK, 7) +
              " │ " +
              r.mrr.toFixed(3).padStart(7) +
              " │ " +
              r.ndcg.toFixed(3).padStart(7) +
              " │"
          )
        } else {
          console.log(
            "│ " +
              pad(provider, 15) +
              " │ " +
              pad("N/A", 7) +
              " │ " +
              pad("N/A", 9) +
              " │ " +
              pad("N/A", 8) +
              " │ " +
              pad("N/A", 7) +
              " │ " +
              pad("N/A", 7) +
              " │ " +
              pad("N/A", 7) +
              " │"
          )
        }
      }
      console.log(
        "└" +
          "─".repeat(17) +
          "┴" +
          "─".repeat(9) +
          "┴" +
          "─".repeat(11) +
          "┴" +
          "─".repeat(10) +
          "┴" +
          "─".repeat(9) +
          "┴" +
          "─".repeat(9) +
          "┴" +
          "─".repeat(9) +
          "┘"
      )
    }

    const allTypes = new Set<string>()
    for (const { report } of reports) {
      for (const type of Object.keys(report.byQuestionType)) {
        allTypes.add(type)
      }
    }

    if (allTypes.size > 0) {
      console.log("\nBY QUESTION TYPE (primary slice score / pass accuracy secondary)")
      const typeWidth = Math.max("Type".length, ...[...allTypes].map((type) => type.length))
      const providerWidth = Math.max(40, ...reports.map(({ provider }) => provider.length))
      const headerRow = ["│ " + pad("Type", typeWidth)]
      for (const { provider } of reports) {
        headerRow.push(pad(provider, providerWidth))
      }
      headerRow.push(pad("Best", 13) + " │")

      const borderTop =
        "┌" +
        "─".repeat(typeWidth + 2) +
        reports.map(() => "┬" + "─".repeat(providerWidth + 2)).join("") +
        "┬" +
        "─".repeat(15) +
        "┐"
      const borderMid =
        "├" +
        "─".repeat(typeWidth + 2) +
        reports.map(() => "┼" + "─".repeat(providerWidth + 2)).join("") +
        "┼" +
        "─".repeat(15) +
        "┤"
      const borderBot =
        "└" +
        "─".repeat(typeWidth + 2) +
        reports.map(() => "┴" + "─".repeat(providerWidth + 2)).join("") +
        "┴" +
        "─".repeat(15) +
        "┘"

      console.log(borderTop)
      console.log(headerRow.join(" │ "))
      console.log(borderMid)

      for (const type of [...allTypes].sort()) {
        const row = ["│ " + pad(type, typeWidth)]
        const values = reports.map(({ provider, report }) => ({
          provider,
          ...getQuestionTypeQuality(report, type),
        }))
        const valueKeys = new Set(values.flatMap(({ value, key }) => (value == null ? [] : [key])))
        const allValuesPresent = values.every(
          ({ value }) => value != null && Number.isFinite(value)
        )
        const comparableSlice =
          primaryComparison.comparable && allValuesPresent && valueKeys.size === 1
        const sliceValues = values.map(({ value }) => value as number)
        const bestValue = comparableSlice
          ? primaryComparison.identity!.higherIsBetter
            ? Math.max(...sliceValues)
            : Math.min(...sliceValues)
          : undefined
        const bestProvider =
          bestValue === undefined
            ? ""
            : (values.find(({ value }) => value === bestValue)?.provider ?? "")

        for (const value of values) {
          if (value.value == null) {
            row.push(pad("N/A", providerWidth))
            continue
          }
          const primary = `${value.value.toFixed(3)} ${value.key}`
          const pass =
            value.passAccuracy == null
              ? "pass N/A"
              : `${(value.passAccuracy * 100).toFixed(1)}% pass`
          row.push(pad(`${primary} / ${pass}`, providerWidth))
        }
        row.push(pad(bestProvider, 13) + " │")
        console.log(row.join(" │ "))
      }
      console.log(borderBot)
    }

    console.log("\n" + "═".repeat(80))
    if (primaryComparison.comparable && primaryComparison.winners.length > 0) {
      const winnerRows = primaryComparison.rows.filter(({ provider }) =>
        primaryComparison.winners.includes(provider)
      )
      const winnerNames = winnerRows.map(({ provider }) => provider).join(", ")
      const winnerLabel = winnerRows.length > 1 ? "TIE" : "WINNER"
      const passSummary = winnerRows
        .map(({ provider, passAccuracy }) => `${provider} ${(passAccuracy * 100).toFixed(1)}%`)
        .join(", ")
      console.log(
        `${winnerLabel}: ${winnerNames} (${primaryComparison.identity!.key}=${primaryComparison.bestValue!.toFixed(4)}; pass accuracy secondary: ${passSummary})`
      )
    } else {
      console.log(
        `NO WINNER: reports are not like-for-like (${primaryComparison.mismatchReasons.join("; ")})`
      )
    }
    console.log("═".repeat(80) + "\n")
  }
}

export const batchManager = new BatchManager()
