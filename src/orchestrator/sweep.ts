import { createHash } from "node:crypto"
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { Database, SQLiteError } from "bun:sqlite"
import { createBenchmark } from "../benchmarks"
import { createJudge } from "../judges"
import { createProvider } from "../providers"
import type { Benchmark, BenchmarkName } from "../types/benchmark"
import type { RunCheckpoint } from "../types/checkpoint"
import type { ProviderName } from "../types/provider"
import type { BenchmarkResult, ContextSweep } from "../types/unified"
import { getJudgeConfig } from "../utils/config"
import { resolveModel } from "../utils/models"
import { CheckpointManager } from "./checkpoint"
import { runAnswerPhase } from "./phases/answer"
import { runEvaluatePhase } from "./phases/evaluate"
import { generateReport, saveReport } from "./phases/report"

interface SweepOptions {
  sourceRunId: string
  sweepId: string
  depths: number[]
}

function validateCohort(source: RunCheckpoint, benchmark: Benchmark) {
  const ids = source.targetQuestionIds ?? Object.keys(source.questions)
  if (!ids.length || ids.length !== new Set(ids).size) {
    throw new Error("The source needs a non-empty set of unique question IDs.")
  }
  const questions = new Map(
    benchmark.getQuestions().map((question) => [question.questionId, question])
  )
  return ids.map((id) => {
    const saved = source.questions[id]
    const question = questions.get(id)
    if (
      !question ||
      !saved ||
      saved.question !== question.question ||
      saved.questionType !== question.questionType ||
      saved.groundTruth !== question.groundTruth ||
      saved.questionDate !== question.metadata?.questionDate
    ) {
      throw new Error(`The benchmark question changed or is missing: ${id}`)
    }
    const search = saved.phases.search
    if (search.status !== "completed" || !Array.isArray(search.results)) {
      throw new Error(`The source has no completed search snapshot for ${id}`)
    }
    return { question, saved, results: search.results }
  })
}

export async function runContextSweep({
  sourceRunId,
  sweepId,
  depths,
}: SweepOptions): Promise<BenchmarkResult[]> {
  const validId = (id: string) => /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)
  if (!validId(sourceRunId) || !validId(sweepId)) {
    throw new Error("Run IDs may use letters, numbers, underscores and hyphens.")
  }
  if (
    depths.length < 2 ||
    depths.some((depth) => !Number.isSafeInteger(depth) || depth < 0) ||
    new Set(depths).size !== depths.length
  ) {
    throw new Error("Provide at least two distinct non-negative depths.")
  }

  const locksDir = join("data", "sweeps")
  mkdirSync(locksDir, { recursive: true })
  const lock = new Database(join(locksDir, `${sweepId}.sqlite`))
  try {
    try {
      // SQLite releases the write lock if the process exits unexpectedly.
      lock.exec("BEGIN IMMEDIATE")
    } catch (error) {
      if (error instanceof SQLiteError && error.code === "SQLITE_BUSY") {
        throw new Error(`Sweep ${sweepId} is already running.`)
      }
      throw error
    }
    return await executeSweep({ sourceRunId, sweepId, depths })
  } finally {
    lock.close()
  }
}

async function executeSweep({
  sourceRunId,
  sweepId,
  depths,
}: SweepOptions): Promise<BenchmarkResult[]> {
  const manager = new CheckpointManager()
  const source = manager.load(sourceRunId)
  if (!source || source.runId !== sourceRunId || source.contextSweep) {
    throw new Error("Provide the ID of an existing source run with saved search results.")
  }
  const benchmark = createBenchmark(source.benchmark as BenchmarkName)
  await benchmark.load()
  const cohort = validateCohort(source, benchmark)
  const targetQuestionIds = cohort.map(({ question }) => question.questionId)
  const maxAvailable = cohort.reduce((max, { results }) => Math.max(max, results.length), 0)
  if (depths.some((depth) => depth > maxAvailable)) {
    throw new Error(`The deepest saved result list has ${maxAvailable} results.`)
  }
  const sourceDigest = createHash("sha256")
    .update(
      JSON.stringify({
        provider: source.provider,
        benchmark: source.benchmark,
        judge: source.judge,
        answeringModel: source.answeringModel,
        questions: cohort.map(({ question, results }) => ({ question, results })),
      })
    )
    .digest("hex")

  // Validate all destinations before running either model.
  const variants = depths.map((maxResults) => {
    const runId = `${sweepId}-k${maxResults}`
    const contextSweep: ContextSweep = { sourceRunId, sourceDigest, maxResults }
    const existing = manager.load(runId)
    if (existsSync(join(manager.getRunPath(runId), "report.json")) && !existing) {
      throw new Error(`Run ${runId} already has a report without a checkpoint.`)
    }
    if (
      manager.exists(runId) &&
      (!existing?.contextSweep ||
        existing.contextSweep.sourceRunId !== sourceRunId ||
        existing.contextSweep.sourceDigest !== sourceDigest ||
        existing.contextSweep.maxResults !== maxResults)
    ) {
      throw new Error(`Run ${runId} already exists with different inputs. Choose another sweep ID.`)
    }
    return (
      existing ??
      ({
        runId,
        dataSourceRunId: source.dataSourceRunId || sourceRunId,
        status: "running",
        provider: source.provider,
        benchmark: source.benchmark,
        answeringModel: source.answeringModel,
        judge: source.judge,
        concurrency: source.concurrency,
        contextSweep,
        targetQuestionIds,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        questions: Object.fromEntries(
          cohort.map(({ saved, results }) => [
            saved.questionId,
            {
              ...saved,
              phases: {
                ingest: { status: "pending", completedSessions: [] },
                indexing: { status: "pending" },
                search: { status: "completed", results: results.slice(0, maxResults) },
                answer: { status: "pending" },
                evaluate: { status: "pending" },
              },
            },
          ])
        ),
      } satisfies RunCheckpoint)
    )
  })

  // Provider instances supply prompt formatting and concurrency defaults only.
  const provider = createProvider(source.provider as ProviderName)
  const judgeName = resolveModel(source.judge).provider
  const reports: BenchmarkResult[] = []
  for (const variant of variants) {
    try {
      if (variant.status !== "completed") {
        manager.updateStatus(variant, "running")
        await manager.flush(variant.runId)
        await runAnswerPhase(benchmark, variant, manager, targetQuestionIds, provider)
        const judge = createJudge(judgeName)
        await judge.initialize({ ...getJudgeConfig(judgeName), model: source.judge })
        await runEvaluatePhase(judge, benchmark, variant, manager, targetQuestionIds, provider)
      }
      const report = generateReport(benchmark, variant)
      if (report.summary.totalQuestions !== targetQuestionIds.length) {
        throw new Error(`Run ${variant.runId} did not finish the full question cohort.`)
      }
      await manager.flush(variant.runId)
      saveReport(report)
      manager.updateStatus(variant, "completed")
      await manager.flush(variant.runId)
      reports.push(report)
    } catch (error) {
      manager.updateStatus(variant, "failed")
      await manager.flush(variant.runId)
      throw error
    }
  }
  return reports
}
