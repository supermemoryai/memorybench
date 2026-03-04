import type { ProviderName } from "../types/provider"
import type { BenchmarkName } from "../types/benchmark"
import type { SamplingConfig } from "../types/checkpoint"
import type { BenchmarkResult } from "../types/unified"
import { orchestrator, CheckpointManager } from "./index"
import { createBenchmark } from "../benchmarks"
import { logger } from "../utils/logger"
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs"
import { join } from "path"
import { startRun, endRun } from "../server/runState"

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
  sampling?: SamplingConfig
  targetQuestionIds: string[]
  runs: Array<{
    provider: string
    runId: string
  }>
}

export interface CompareOptions {
  providers: ProviderName[]
  benchmark: BenchmarkName
  judgeModel: string
  answeringModel: string
  sampling?: SamplingConfig
  force?: boolean
}

export interface CompareResult {
  compareId: string
  manifest: CompareManifest
  successes: number
  failures: number
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

export class BatchManager {
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
    const comparePath = this.getComparePath(compareId)
    if (existsSync(comparePath)) {
      rmSync(comparePath, { recursive: true })
    }
    const manifest = this.loadManifest(compareId)
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
    return this.executeRuns(manifest)
  }

  async createManifest(options: CompareOptions): Promise<CompareManifest> {
    const { providers, benchmark, judgeModel, answeringModel, sampling } = options
    const compareId = generateCompareId()

    logger.info(`Loading benchmark: ${benchmark}`)
    const benchmarkInstance = createBenchmark(benchmark)
    await benchmarkInstance.load()
    const allQuestions = benchmarkInstance.getQuestions()

    let targetQuestionIds: string[]
    if (sampling) {
      targetQuestionIds = selectQuestionsBySampling(allQuestions, sampling)
    } else {
      targetQuestionIds = allQuestions.map((q) => q.questionId)
    }

    const manifest: CompareManifest = {
      compareId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      benchmark,
      judge: judgeModel,
      answeringModel,
      sampling,
      targetQuestionIds,
      runs: providers.map((provider) => ({
        provider,
        runId: `${compareId}-${provider}`,
      })),
    }

    this.saveManifest(manifest)
    logger.info(`Created comparison: ${compareId}`)
    logger.info(`Providers: ${providers.join(", ")}`)
    logger.info(`Questions: ${targetQuestionIds.length}`)

    return manifest
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
          return await orchestrator.run({
            provider: run.provider as ProviderName,
            benchmark: manifest.benchmark as BenchmarkName,
            judgeModel: manifest.judge,
            runId: run.runId,
            answeringModel: manifest.answeringModel,
            questionIds: manifest.targetQuestionIds,
          })
        } catch (error) {
          // Update checkpoint status to persist the failure state
          const checkpoint = checkpointManager.load(run.runId)
          if (checkpoint) {
            checkpointManager.updateStatus(checkpoint, "failed")
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

    const sortedByAccuracy = [...reports].sort(
      (a, b) => b.report.summary.accuracy - a.report.summary.accuracy
    )
    const bestAccuracy = sortedByAccuracy[0]?.provider

    console.log("\nOVERALL ACCURACY")
    console.log(
      "┌" + "─".repeat(17) + "┬" + "─".repeat(10) + "┬" + "─".repeat(9) + "┬" + "─".repeat(10) + "┐"
    )
    console.log(
      "│ " +
        pad("Provider", 15) +
        " │ " +
        pad("Correct", 8) +
        " │ " +
        pad("Total", 7) +
        " │ " +
        pad("Accuracy", 8) +
        " │"
    )
    console.log(
      "├" + "─".repeat(17) + "┼" + "─".repeat(10) + "┼" + "─".repeat(9) + "┼" + "─".repeat(10) + "┤"
    )
    for (const { provider, report } of sortedByAccuracy) {
      const best = provider === bestAccuracy ? " ←" : ""
      console.log(
        "│ " +
          pad(provider, 15) +
          " │ " +
          padNum(report.summary.correctCount, 8) +
          " │ " +
          padNum(report.summary.totalQuestions, 7) +
          " │ " +
          padPct(report.summary.accuracy, 7) +
          best.padEnd(2) +
          " │"
      )
    }
    console.log(
      "└" + "─".repeat(17) + "┴" + "─".repeat(10) + "┴" + "─".repeat(9) + "┴" + "─".repeat(10) + "┘"
    )

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
      console.log("\nBY QUESTION TYPE")
      const providerWidth = 13
      const headerRow = ["│ " + pad("Type", 17)]
      for (const { provider } of reports) {
        headerRow.push(pad(provider, providerWidth))
      }
      headerRow.push(pad("Best", 13) + " │")

      const borderTop =
        "┌" +
        "─".repeat(19) +
        reports.map(() => "┬" + "─".repeat(providerWidth + 2)).join("") +
        "┬" +
        "─".repeat(15) +
        "┐"
      const borderMid =
        "├" +
        "─".repeat(19) +
        reports.map(() => "┼" + "─".repeat(providerWidth + 2)).join("") +
        "┼" +
        "─".repeat(15) +
        "┤"
      const borderBot =
        "└" +
        "─".repeat(19) +
        reports.map(() => "┴" + "─".repeat(providerWidth + 2)).join("") +
        "┴" +
        "─".repeat(15) +
        "┘"

      console.log(borderTop)
      console.log(headerRow.join(" │ "))
      console.log(borderMid)

      for (const type of [...allTypes].sort()) {
        const row = ["│ " + pad(type, 17)]
        let bestProvider = ""
        let bestAccuracyForType = -1

        for (const { provider, report } of reports) {
          const stats = report.byQuestionType[type]
          if (stats) {
            row.push(padPct(stats.accuracy, providerWidth))
            if (stats.accuracy > bestAccuracyForType) {
              bestAccuracyForType = stats.accuracy
              bestProvider = provider
            }
          } else {
            row.push(pad("N/A", providerWidth))
          }
        }
        row.push(pad(bestProvider, 13) + " │")
        console.log(row.join(" │ "))
      }
      console.log(borderBot)
    }

    console.log("\n" + "═".repeat(80))
    if (bestAccuracy) {
      const bestReport = reports.find((r) => r.provider === bestAccuracy)?.report
      console.log(
        `WINNER: ${bestAccuracy} (${(bestReport!.summary.accuracy * 100).toFixed(1)}% overall accuracy)`
      )
    }
    console.log("═".repeat(80) + "\n")
  }
}

export const batchManager = new BatchManager()
