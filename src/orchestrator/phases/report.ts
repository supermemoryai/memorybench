import { writeFileSync, mkdirSync, existsSync } from "fs"
import { join } from "path"
import type { Benchmark } from "../../types/benchmark"
import type { RunCheckpoint } from "../../types/checkpoint"
import type {
  BenchmarkResult,
  EvaluationResult,
  LatencyStats,
  QuestionTypeStats,
  RetrievalMetrics,
  RetrievalAggregates,
} from "../../types/unified"
import { logger } from "../../utils/logger"

const REPORTS_DIR = "./data/runs"

function aggregateRetrievalMetrics(metrics: RetrievalMetrics[]): RetrievalAggregates | undefined {
  if (metrics.length === 0) return undefined

  const sum = metrics.reduce(
    (acc, m) => ({
      hitAtK: acc.hitAtK + m.hitAtK,
      precisionAtK: acc.precisionAtK + m.precisionAtK,
      recallAtK: acc.recallAtK + m.recallAtK,
      f1AtK: acc.f1AtK + m.f1AtK,
      mrr: acc.mrr + m.mrr,
      ndcg: acc.ndcg + m.ndcg,
      k: m.k,
    }),
    { hitAtK: 0, precisionAtK: 0, recallAtK: 0, f1AtK: 0, mrr: 0, ndcg: 0, k: 10 }
  )

  const n = metrics.length
  return {
    hitAtK: sum.hitAtK / n,
    precisionAtK: sum.precisionAtK / n,
    recallAtK: sum.recallAtK / n,
    f1AtK: sum.f1AtK / n,
    mrr: sum.mrr / n,
    ndcg: sum.ndcg / n,
    k: sum.k,
  }
}

function calculateLatencyStats(durations: number[]): LatencyStats {
  if (durations.length === 0) {
    return { min: 0, max: 0, mean: 0, median: 0, p95: 0, p99: 0, stdDev: 0, count: 0 }
  }

  const sorted = [...durations].sort((a, b) => a - b)
  const n = sorted.length
  const sum = sorted.reduce((a, b) => a + b, 0)
  const mean = sum / n

  const variance = sorted.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / n
  const stdDev = Math.sqrt(variance)

  return {
    min: sorted[0],
    max: sorted[n - 1],
    mean: Math.round(mean),
    median: sorted[Math.floor(n / 2)],
    p95: sorted[Math.floor(n * 0.95)] || sorted[n - 1],
    p99: sorted[Math.floor(n * 0.99)] || sorted[n - 1],
    stdDev: Math.round(stdDev),
    count: n,
  }
}

export function generateReport(benchmark: Benchmark, checkpoint: RunCheckpoint): BenchmarkResult {
  const questions = benchmark.getQuestions()
  const evaluations: EvaluationResult[] = []

  const ingestDurations: number[] = []
  const indexingDurations: number[] = []
  const searchDurations: number[] = []
  const answerDurations: number[] = []
  const evaluateDurations: number[] = []
  const totalDurations: number[] = []

  const allRetrievalMetrics: RetrievalMetrics[] = []

  const byType: Record<
    string,
    {
      total: number
      correct: number
      searchDurations: number[]
      answerDurations: number[]
      totalDurations: number[]
      retrievalMetrics: RetrievalMetrics[]
    }
  > = {}

  for (const question of questions) {
    const qCheckpoint = checkpoint.questions[question.questionId]
    if (!qCheckpoint) continue

    const evalPhase = qCheckpoint.phases.evaluate
    if (evalPhase.status !== "completed") continue

    const ingestPhase = qCheckpoint.phases.ingest
    const indexingPhase = qCheckpoint.phases.indexing
    const searchPhase = qCheckpoint.phases.search
    const answerPhase = qCheckpoint.phases.answer

    const ingestDurationMs = ingestPhase.durationMs || 0
    const indexingDurationMs = indexingPhase.durationMs || 0
    const searchDurationMs = searchPhase.durationMs || 0
    const answerDurationMs = answerPhase.durationMs || 0
    const evaluateDurationMs = evalPhase.durationMs || 0
    const totalDurationMs =
      ingestDurationMs +
      indexingDurationMs +
      searchDurationMs +
      answerDurationMs +
      evaluateDurationMs

    const retrievalMetrics = evalPhase.retrievalMetrics

    evaluations.push({
      questionId: question.questionId,
      questionType: question.questionType,
      question: question.question,
      score: evalPhase.score || 0,
      label: evalPhase.label || "incorrect",
      explanation: evalPhase.explanation || "",
      hypothesis: answerPhase.hypothesis || "",
      groundTruth: question.groundTruth,
      searchResults: searchPhase.results || [],
      searchDurationMs,
      answerDurationMs,
      totalDurationMs,
      retrievalMetrics,
    })

    if (retrievalMetrics) {
      allRetrievalMetrics.push(retrievalMetrics)
    }

    if (ingestPhase.durationMs) ingestDurations.push(ingestPhase.durationMs)
    if (indexingPhase.durationMs) indexingDurations.push(indexingPhase.durationMs)
    if (searchPhase.durationMs) searchDurations.push(searchPhase.durationMs)
    if (answerPhase.durationMs) answerDurations.push(answerPhase.durationMs)
    if (evalPhase.durationMs) evaluateDurations.push(evalPhase.durationMs)
    if (totalDurationMs > 0) totalDurations.push(totalDurationMs)

    const qType = question.questionType
    if (!byType[qType]) {
      byType[qType] = {
        total: 0,
        correct: 0,
        searchDurations: [],
        answerDurations: [],
        totalDurations: [],
        retrievalMetrics: [],
      }
    }
    const typeStats = byType[qType]!
    typeStats.total++
    if (evalPhase.score === 1) {
      typeStats.correct++
    }
    if (searchDurationMs) typeStats.searchDurations.push(searchDurationMs)
    if (answerDurationMs) typeStats.answerDurations.push(answerDurationMs)
    if (totalDurationMs > 0) typeStats.totalDurations.push(totalDurationMs)
    if (retrievalMetrics) typeStats.retrievalMetrics.push(retrievalMetrics)
  }

  const byQuestionType: Record<string, QuestionTypeStats> = {}
  for (const type of Object.keys(byType)) {
    const raw = byType[type]!
    byQuestionType[type] = {
      total: raw.total,
      correct: raw.correct,
      accuracy: raw.total > 0 ? raw.correct / raw.total : 0,
      latency: {
        search: calculateLatencyStats(raw.searchDurations),
        answer: calculateLatencyStats(raw.answerDurations),
        total: calculateLatencyStats(raw.totalDurations),
      },
      retrieval: aggregateRetrievalMetrics(raw.retrievalMetrics),
    }
  }

  const overallRetrieval = aggregateRetrievalMetrics(allRetrievalMetrics)

  const totalQuestions = evaluations.length
  const correctCount = evaluations.filter((e) => e.score === 1).length
  const accuracy = totalQuestions > 0 ? correctCount / totalQuestions : 0

  const result: BenchmarkResult = {
    provider: checkpoint.provider,
    benchmark: checkpoint.benchmark,
    runId: checkpoint.runId,
    dataSourceRunId: checkpoint.dataSourceRunId,
    judge: checkpoint.judge,
    answeringModel: checkpoint.answeringModel,
    timestamp: new Date().toISOString(),
    summary: {
      totalQuestions,
      correctCount,
      accuracy,
    },
    latency: {
      ingest: calculateLatencyStats(ingestDurations),
      indexing: calculateLatencyStats(indexingDurations),
      search: calculateLatencyStats(searchDurations),
      answer: calculateLatencyStats(answerDurations),
      evaluate: calculateLatencyStats(evaluateDurations),
      total: calculateLatencyStats(totalDurations),
    },
    retrieval: overallRetrieval,
    byQuestionType,
    questionTypeRegistry: benchmark.getQuestionTypes(),
    evaluations,
  }

  return result
}

export function saveReport(result: BenchmarkResult): string {
  const reportsDir = join(REPORTS_DIR, result.runId)
  if (!existsSync(reportsDir)) {
    mkdirSync(reportsDir, { recursive: true })
  }

  const reportPath = join(reportsDir, "report.json")
  writeFileSync(reportPath, JSON.stringify(result, null, 2))

  logger.success(`Report saved to ${reportPath}`)
  return reportPath
}

function formatLatencyRow(stats: LatencyStats): string {
  const pad = (n: number) => n.toString().padStart(7)
  return `${pad(stats.min)} ${pad(stats.max)} ${pad(stats.mean)} ${pad(stats.median)} ${pad(stats.p95)} ${pad(stats.p99)}`
}

export function printReport(result: BenchmarkResult): void {
  console.log("\n" + "=".repeat(60))
  console.log("MEMORYBENCH RESULTS")
  console.log("=".repeat(60))
  console.log(`Provider: ${result.provider}`)
  console.log(`Benchmark: ${result.benchmark}`)
  console.log(`Run ID: ${result.runId}`)
  console.log(`Data Source: ${result.dataSourceRunId}`)
  console.log(`Judge: ${result.judge}`)
  console.log(`Answering Model: ${result.answeringModel}`)
  console.log("-".repeat(60))
  console.log("\nSUMMARY:")
  console.log(`  Total Questions: ${result.summary.totalQuestions}`)
  console.log(`  Correct: ${result.summary.correctCount}`)
  console.log(`  Accuracy: ${(result.summary.accuracy * 100).toFixed(2)}%`)
  console.log("-".repeat(60))
  console.log("\nLATENCY (ms):")
  console.log("                    min     max    mean  median     p95     p99")
  console.log(`  Ingest:       ${formatLatencyRow(result.latency.ingest)}`)
  console.log(`  Indexing:     ${formatLatencyRow(result.latency.indexing)}`)
  console.log(`  Search:       ${formatLatencyRow(result.latency.search)}`)
  console.log(`  Answer:       ${formatLatencyRow(result.latency.answer)}`)
  console.log(`  Evaluate:     ${formatLatencyRow(result.latency.evaluate)}`)
  console.log(`  Total:        ${formatLatencyRow(result.latency.total)}`)

  if (result.retrieval) {
    console.log("-".repeat(60))
    console.log("\nRETRIEVAL QUALITY (K=" + result.retrieval.k + "):")
    console.log(`  Hit@K:      ${(result.retrieval.hitAtK * 100).toFixed(1)}%`)
    console.log(`  Precision:  ${(result.retrieval.precisionAtK * 100).toFixed(1)}%`)
    console.log(`  Recall:     ${(result.retrieval.recallAtK * 100).toFixed(1)}%`)
    console.log(`  F1:         ${(result.retrieval.f1AtK * 100).toFixed(1)}%`)
    console.log(`  MRR:        ${result.retrieval.mrr.toFixed(3)}`)
    console.log(`  NDCG:       ${result.retrieval.ndcg.toFixed(3)}`)
  }

  console.log("-".repeat(60))
  console.log("\nBY QUESTION TYPE:")
  for (const [type, stats] of Object.entries(result.byQuestionType)) {
    const typeInfo = result.questionTypeRegistry?.[type]
    const description = typeInfo?.description ? ` (${typeInfo.description})` : ""
    console.log(`  ${type}${description}:`)
    console.log(
      `    Total: ${stats.total}, Correct: ${stats.correct}, Accuracy: ${(stats.accuracy * 100).toFixed(2)}%`
    )
    console.log(
      `    Latency: search=${stats.latency.search.median}ms, answer=${stats.latency.answer.median}ms, total=${stats.latency.total.median}ms (median)`
    )
    if (stats.retrieval) {
      console.log(
        `    Retrieval: Hit@${stats.retrieval.k}=${(stats.retrieval.hitAtK * 100).toFixed(0)}%, P=${(stats.retrieval.precisionAtK * 100).toFixed(0)}%, R=${(stats.retrieval.recallAtK * 100).toFixed(0)}%, MRR=${stats.retrieval.mrr.toFixed(2)}`
      )
    }
  }
  console.log("=".repeat(60) + "\n")
}
