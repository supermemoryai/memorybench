import { eq, and } from "drizzle-orm"
import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { db, schema } from "../db"
import { CheckpointManager } from "../../orchestrator/checkpoint"
import { createBenchmark } from "../../benchmarks"
import type { BenchmarkName } from "../../types/benchmark"
import type { BenchmarkResult } from "../../types/unified"
import {
  canonicalizeSelectedQuestionIds,
  fingerprintSelectedBenchmarkInput,
} from "../../orchestrator/input-identity"
import { stableSha256 } from "../../utils/stable"
import {
  createLeaderboardComparisonIdentity,
  rankLeaderboardEntries,
  validateLeaderboardReportForPublication,
  type LeaderboardComparisonIdentity,
} from "../leaderboard-identity"

const checkpointManager = new CheckpointManager()

const benchmarkRegistryCache: Record<string, any> = {}
const REPORT_METADATA_KEY = "__memorybenchReport"

function extractReportMetadata(evaluations: unknown[]): Record<string, any> | undefined {
  const first = evaluations[0]
  if (!first || typeof first !== "object" || Array.isArray(first)) return undefined
  const metadata = (first as Record<string, unknown>)[REPORT_METADATA_KEY]
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, any>)
    : undefined
}

function attachReportMetadata(evaluations: any[], report: any): any[] {
  if (evaluations.length === 0 || !report) return evaluations
  const metadata = {
    quality: report.quality,
    summary: report.summary,
    builds: report.builds,
    costs: report.costs,
    questionMetrics: report.questionMetrics,
    protocolIdentity: report.protocolIdentity,
    benchmarkScope: report.benchmarkScope,
    datasetIdentity: report.datasetIdentity,
    selectedQuestionIdsDigest: report.selectedQuestionIdsDigest,
    benchmarkInputFingerprint: report.benchmarkInputFingerprint,
    retrievalTopK: report.retrievalTopK,
    retrieval: report.retrieval,
    judge: report.judge,
    answeringModel: report.answeringModel,
    answeringRuntimeIdentity: report.answeringRuntimeIdentity,
    providerPromptFingerprint: report.providerPromptFingerprint,
  }
  return evaluations.map((evaluation, index) =>
    index === 0 ? { ...evaluation, [REPORT_METADATA_KEY]: metadata } : evaluation
  )
}

function getEvaluationPassState(value: any): boolean | undefined {
  const protocolEvaluation = value?.evaluation
  if (typeof protocolEvaluation?.passed === "boolean") return protocolEvaluation.passed
  if (typeof value?.passed === "boolean") return value.passed

  for (const label of [protocolEvaluation?.label, value?.label]) {
    if (typeof label !== "string") continue
    const normalized = label.toLowerCase()
    if (normalized === "pass" || normalized === "correct") return true
    if (normalized === "fail" || normalized === "incorrect" || normalized === "wrong") {
      return false
    }
  }

  const legacyScore = value?.score ?? protocolEvaluation?.primaryScore
  return typeof legacyScore === "number" ? legacyScore === 1 : undefined
}

function getQuestionTypeRegistry(benchmarkName: string) {
  try {
    if (!benchmarkRegistryCache[benchmarkName]) {
      const benchmark = createBenchmark(benchmarkName as BenchmarkName)
      benchmarkRegistryCache[benchmarkName] = benchmark.getQuestionTypes()
    }
    return benchmarkRegistryCache[benchmarkName]
  } catch {
    // Historical rows can reference benchmark ids removed from the registry.
    return null
  }
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function parseLeaderboardEntry(entry: typeof schema.leaderboardEntries.$inferSelect) {
  const byQuestionType = parseJson<Record<string, unknown>>(entry.byQuestionType, {})
  const latencyStats = parseJson<unknown>(entry.latencyStats, null)
  const evaluations = parseJson<unknown[]>(entry.evaluations, [])
  const promptsUsed = parseJson<Record<string, string> | null>(entry.promptsUsed, null)
  const reportMetadata = extractReportMetadata(evaluations)
  const benchmarkScope =
    parseJson<Record<string, unknown> | null>(entry.benchmarkScope, null) ??
    reportMetadata?.benchmarkScope
  const datasetIdentity =
    parseJson<Record<string, unknown> | null>(entry.datasetIdentity, null) ??
    reportMetadata?.datasetIdentity
  const protocolIdentity =
    parseJson<Record<string, unknown> | null>(entry.protocolIdentity, null) ??
    reportMetadata?.protocolIdentity
  const primaryMetric = {
    key: entry.primaryMetricKey ?? reportMetadata?.quality?.primaryMetric?.key ?? "accuracy",
    value:
      entry.primaryMetricValue ?? reportMetadata?.quality?.primaryMetric?.value ?? entry.accuracy,
    higherIsBetter:
      entry.primaryMetricHigherIsBetter ??
      reportMetadata?.quality?.primaryMetric?.higherIsBetter ??
      true,
  }
  const comparisonIdentity = createLeaderboardComparisonIdentity({
    benchmark: entry.benchmark,
    benchmarkScope,
    datasetIdentity,
    selectedQuestionIdsDigest: entry.questionSetFingerprint ?? undefined,
    benchmarkInputFingerprint: reportMetadata?.benchmarkInputFingerprint,
    protocolIdentity,
    retrievalTopK: entry.retrievalTopK ?? undefined,
    questionMetrics: reportMetadata?.questionMetrics,
    judgeModel: entry.judgeModel,
    answeringModel: entry.answeringModel,
    answeringRuntimeIdentity: reportMetadata?.answeringRuntimeIdentity,
    providerPromptFingerprint: reportMetadata?.providerPromptFingerprint,
    primaryMetric,
    accuracy: entry.accuracy,
  })
  const persistedIdentity: LeaderboardComparisonIdentity = {
    ...comparisonIdentity,
    datasetFingerprint: entry.datasetFingerprint ?? comparisonIdentity.datasetFingerprint,
    protocolFingerprint: entry.protocolFingerprint ?? comparisonIdentity.protocolFingerprint,
    // Recompute the current cohort so historical keys that omitted parts of
    // the effective benchmark/model identity cannot merge unlike runs.
    cohortKey: comparisonIdentity.cohortKey,
  }

  return {
    ...entry,
    byQuestionType,
    questionTypeRegistry: getQuestionTypeRegistry(entry.benchmark),
    latencyStats,
    evaluations,
    promptsUsed,
    benchmarkScope: persistedIdentity.benchmarkScope,
    datasetIdentity: persistedIdentity.datasetIdentity,
    datasetFingerprint: persistedIdentity.datasetFingerprint,
    questionSetFingerprint: persistedIdentity.questionSetFingerprint,
    benchmarkInputFingerprint: persistedIdentity.benchmarkInputFingerprint,
    protocolIdentity: persistedIdentity.protocolIdentity,
    protocolFingerprint: persistedIdentity.protocolFingerprint,
    retrievalTopK: persistedIdentity.retrievalTopK,
    providerPromptFingerprint: persistedIdentity.providerPromptFingerprint,
    primaryMetric: persistedIdentity.primaryMetric,
    comparisonIdentity: persistedIdentity,
    quality: reportMetadata?.quality ?? { primaryMetric, metrics: {} },
    averageScore: reportMetadata?.summary?.averageScore,
    builds: reportMetadata?.builds,
    costs: reportMetadata?.costs,
    questionMetrics: reportMetadata?.questionMetrics,
    retrieval: reportMetadata?.retrieval,
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

export async function handleLeaderboardRoutes(req: Request, url: URL): Promise<Response | null> {
  const method = req.method
  const pathname = url.pathname

  // GET /api/leaderboard - List all leaderboard entries
  if (method === "GET" && pathname === "/api/leaderboard") {
    try {
      const entries = db.select().from(schema.leaderboardEntries).all()

      const parsed = rankLeaderboardEntries(entries.map(parseLeaderboardEntry))

      return json({ entries: parsed })
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "Failed to load leaderboard" }, 500)
    }
  }

  // POST /api/leaderboard - Add run to leaderboard
  if (method === "POST" && pathname === "/api/leaderboard") {
    try {
      const body = await req.json()
      const { runId, notes, version } = body

      if (!runId) {
        return json({ error: "runId is required" }, 400)
      }

      // Use provided version or default to "baseline"
      const entryVersion = version?.trim() || "baseline"

      // Load checkpoint
      const checkpoint = checkpointManager.load(runId)
      if (!checkpoint) {
        return json({ error: `Run not found: ${runId}` }, 404)
      }

      // Check if run is completed
      const summary = checkpointManager.getSummary(checkpoint)
      if (summary.evaluated !== summary.total) {
        return json({ error: "Run must be fully evaluated before adding to leaderboard" }, 400)
      }

      // Ranked publication requires a complete, identity-matched scored report.
      const reportPath = join(checkpointManager.getRunPath(runId), "report.json")
      if (!existsSync(reportPath)) {
        return json(
          { error: "A complete scored report is required for leaderboard publication" },
          400
        )
      }
      let report: BenchmarkResult
      let comparisonIdentity: LeaderboardComparisonIdentity
      try {
        report = JSON.parse(readFileSync(reportPath, "utf8")) as BenchmarkResult
        const benchmark = createBenchmark(checkpoint.benchmark as BenchmarkName)
        await benchmark.load({
          dataPath: checkpoint.dataPath,
          datasetRevision: checkpoint.datasetRevision,
          retrievalTopK: checkpoint.retrievalTopK,
        })
        const allQuestions = benchmark.getQuestions()
        const selectedQuestionIds = canonicalizeSelectedQuestionIds(
          allQuestions,
          checkpoint.targetQuestionIds?.length
            ? checkpoint.targetQuestionIds
            : Object.keys(checkpoint.questions)
        )
        const questionById = new Map(
          allQuestions.map((question) => [question.questionId, question])
        )
        const selectedQuestions = selectedQuestionIds.map((questionId) => {
          const question = questionById.get(questionId)
          if (!question) throw new Error(`Leaderboard question is missing: ${questionId}`)
          return question
        })
        const benchmarkInputFingerprint = fingerprintSelectedBenchmarkInput(
          benchmark,
          selectedQuestions
        )
        if (benchmarkInputFingerprint !== checkpoint.benchmarkInputFingerprint) {
          throw new Error("Loaded benchmark input does not match the run checkpoint")
        }
        const loadedDatasetIdentity = benchmark.getDatasetIdentity?.()
        if (
          checkpoint.datasetIdentity &&
          stableSha256(loadedDatasetIdentity ?? null) !== stableSha256(checkpoint.datasetIdentity)
        ) {
          throw new Error("Loaded dataset identity does not match the run checkpoint")
        }
        comparisonIdentity = validateLeaderboardReportForPublication(
          checkpoint,
          report,
          summary.total,
          { protocol: benchmark.protocol, questions: selectedQuestions }
        )
      } catch (error) {
        return json(
          {
            error:
              error instanceof Error
                ? error.message
                : "Leaderboard report is malformed or incomplete",
          },
          400
        )
      }

      const questions = Object.values(checkpoint.questions)
      const correctCount = report.summary.correctCount
      const accuracy = report.summary.accuracy

      // Upsert only within the exact dataset/protocol/retrieval/metric cohort.
      const existing = db
        .select()
        .from(schema.leaderboardEntries)
        .where(
          and(
            eq(schema.leaderboardEntries.provider, checkpoint.provider),
            eq(schema.leaderboardEntries.benchmark, checkpoint.benchmark),
            eq(schema.leaderboardEntries.version, entryVersion),
            eq(schema.leaderboardEntries.comparisonCohortKey, comparisonIdentity.cohortKey)
          )
        )
        .get()

      // Get provider code
      const providerCode = getProviderCode(checkpoint.provider)

      // Get prompts (if available in provider)
      const promptsUsed = getProviderPrompts(checkpoint.provider)

      // Build by question type stats
      const byQuestionType: Record<
        string,
        {
          total: number
          correct: number
          accuracy: number
          averageScore?: number
          passAccuracy?: number
          retrieval?: unknown
        }
      > = {}
      for (const q of questions) {
        const qData = q as any
        const type = qData.questionType || "unknown"
        if (!byQuestionType[type]) {
          byQuestionType[type] = { total: 0, correct: 0, accuracy: 0 }
        }
        byQuestionType[type].total++
        if (getEvaluationPassState(qData.phases?.evaluate) === true) {
          byQuestionType[type].correct++
        }
      }
      for (const type of Object.keys(byQuestionType)) {
        byQuestionType[type].accuracy = byQuestionType[type].correct / byQuestionType[type].total
        const reportStats = report?.byQuestionType?.[type]
        const protocolSlice = report?.quality?.bySlice?.[type]
        byQuestionType[type].averageScore = protocolSlice?.averageScore
        byQuestionType[type].passAccuracy =
          protocolSlice?.passAccuracy ?? byQuestionType[type].accuracy
        if (reportStats?.retrieval) byQuestionType[type].retrieval = reportStats.retrieval
      }

      let evaluations = report.evaluations.map((evaluation) => ({ ...evaluation }))
      evaluations = attachReportMetadata(evaluations, report)

      const entryData = {
        runId,
        provider: checkpoint.provider,
        benchmark: checkpoint.benchmark,
        version: entryVersion,
        benchmarkScope: JSON.stringify(comparisonIdentity.benchmarkScope),
        datasetIdentity: JSON.stringify(comparisonIdentity.datasetIdentity),
        datasetFingerprint: comparisonIdentity.datasetFingerprint,
        questionSetFingerprint: comparisonIdentity.questionSetFingerprint,
        protocolIdentity: JSON.stringify(comparisonIdentity.protocolIdentity),
        protocolFingerprint: comparisonIdentity.protocolFingerprint,
        retrievalTopK: comparisonIdentity.retrievalTopK,
        primaryMetricKey: comparisonIdentity.primaryMetric.key,
        primaryMetricValue: comparisonIdentity.primaryMetric.value,
        primaryMetricHigherIsBetter: comparisonIdentity.primaryMetric.higherIsBetter,
        comparisonCohortKey: comparisonIdentity.cohortKey,
        accuracy,
        totalQuestions: summary.total,
        correctCount,
        byQuestionType: JSON.stringify(byQuestionType),
        latencyStats: report.latency ? JSON.stringify(report.latency) : null,
        evaluations: JSON.stringify(evaluations),
        providerCode,
        promptsUsed: promptsUsed ? JSON.stringify(promptsUsed) : null,
        judgeModel: checkpoint.judge,
        answeringModel: checkpoint.answeringModel,
        addedAt: new Date().toISOString(),
        notes: notes || null,
      }

      let entry
      let isUpdate = false

      if (existing) {
        // Update existing entry (upsert)
        entry = db
          .update(schema.leaderboardEntries)
          .set(entryData)
          .where(eq(schema.leaderboardEntries.id, existing.id))
          .returning()
          .get()
        isUpdate = true
      } else {
        // Insert new entry
        entry = db.insert(schema.leaderboardEntries).values(entryData).returning().get()
      }

      return json({
        message: isUpdate ? "Updated leaderboard entry" : "Added to leaderboard",
        entry: {
          ...entry,
          byQuestionType,
          latencyStats: report.latency,
          quality: report.quality,
          averageScore: report.summary.averageScore,
          builds: report.builds,
          costs: report.costs,
          questionMetrics: report.questionMetrics,
          benchmarkScope: comparisonIdentity.benchmarkScope,
          datasetIdentity: comparisonIdentity.datasetIdentity,
          datasetFingerprint: comparisonIdentity.datasetFingerprint,
          questionSetFingerprint: comparisonIdentity.questionSetFingerprint,
          benchmarkInputFingerprint: comparisonIdentity.benchmarkInputFingerprint,
          protocolIdentity: comparisonIdentity.protocolIdentity,
          protocolFingerprint: comparisonIdentity.protocolFingerprint,
          retrievalTopK: comparisonIdentity.retrievalTopK,
          primaryMetric: comparisonIdentity.primaryMetric,
          comparisonIdentity,
          cohortKey: comparisonIdentity.cohortKey,
          cohortRank: 1,
          cohortSize: 1,
          retrieval: report.retrieval,
        },
      })
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "Failed to add to leaderboard" }, 500)
    }
  }

  // DELETE /api/leaderboard/:id - Remove from leaderboard
  const deleteMatch = pathname.match(/^\/api\/leaderboard\/(\d+)$/)
  if (method === "DELETE" && deleteMatch) {
    try {
      const id = parseInt(deleteMatch[1])

      const entry = db
        .select()
        .from(schema.leaderboardEntries)
        .where(eq(schema.leaderboardEntries.id, id))
        .get()

      if (!entry) {
        return json({ error: "Entry not found" }, 404)
      }

      db.delete(schema.leaderboardEntries).where(eq(schema.leaderboardEntries.id, id)).run()

      return json({ message: "Removed from leaderboard", id })
    } catch (e) {
      return json(
        { error: e instanceof Error ? e.message : "Failed to remove from leaderboard" },
        500
      )
    }
  }

  // GET /api/leaderboard/:id - Get single entry with full details
  const getMatch = pathname.match(/^\/api\/leaderboard\/(\d+)$/)
  if (method === "GET" && getMatch) {
    try {
      const id = parseInt(getMatch[1])

      const entry = db
        .select()
        .from(schema.leaderboardEntries)
        .where(eq(schema.leaderboardEntries.id, id))
        .get()

      if (!entry) {
        return json({ error: "Entry not found" }, 404)
      }

      const ranked = rankLeaderboardEntries(
        db.select().from(schema.leaderboardEntries).all().map(parseLeaderboardEntry)
      )
      return json(ranked.find((candidate) => candidate.id === entry.id)!)
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "Failed to get entry" }, 500)
    }
  }

  return null
}

function getProviderCode(provider: string): string {
  const providerDir = join(process.cwd(), "src", "providers", provider)
  const indexPath = join(providerDir, "index.ts")
  const promptPath = join(providerDir, "prompt.ts")
  const promptsPath = join(providerDir, "prompts.ts")

  const files: Record<string, string> = {}

  // Read index.ts
  if (existsSync(indexPath)) {
    files["index.ts"] = readFileSync(indexPath, "utf8")
  }

  // Read prompt.ts if exists
  if (existsSync(promptPath)) {
    files["prompt.ts"] = readFileSync(promptPath, "utf8")
  }

  // Read prompts.ts if exists
  if (existsSync(promptsPath)) {
    files["prompts.ts"] = readFileSync(promptsPath, "utf8")
  }

  if (Object.keys(files).length === 0) {
    return `// Provider code not found at ${providerDir}`
  }

  // Return as JSON with all files
  return JSON.stringify(files)
}

function getProviderPrompts(provider: string): Record<string, string> | null {
  const providerDir = join(process.cwd(), "src", "providers", provider)
  const prompts: Record<string, string> = {}

  // Check for dedicated prompt files
  const promptFiles = ["prompt.ts", "prompts.ts"]
  for (const file of promptFiles) {
    const filePath = join(providerDir, file)
    if (existsSync(filePath)) {
      prompts[file] = readFileSync(filePath, "utf8")
    }
  }

  // Also extract inline prompts from index.ts
  const indexPath = join(providerDir, "index.ts")
  if (existsSync(indexPath)) {
    const code = readFileSync(indexPath, "utf8")

    // Match template literal prompts
    const promptMatches = code.matchAll(
      /(?:prompt|PROMPT|systemPrompt|userPrompt)\s*[=:]\s*[`"']([^`"']+)[`"']/g
    )
    for (const match of promptMatches) {
      const key = match[0].split(/[=:]/)[0].trim()
      prompts[`inline:${key}`] = match[1]
    }
  }

  return Object.keys(prompts).length > 0 ? prompts : null
}
