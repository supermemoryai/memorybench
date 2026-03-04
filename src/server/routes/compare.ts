import { existsSync, readdirSync } from "fs"
import { join } from "path"
import { CheckpointManager } from "../../orchestrator/checkpoint"
import { batchManager } from "../../orchestrator/batch"
import type { CompareManifest } from "../../orchestrator/batch"
import { wsManager } from "../index"
import { getRunState } from "../runState"
import type { ProviderName } from "../../types/provider"
import type { BenchmarkName } from "../../types/benchmark"
import type { SamplingConfig } from "../../types/checkpoint"

const checkpointManager = new CheckpointManager()

const COMPARE_DIR = "./data/compare"

// Track active comparisons in memory (similar to runState.ts)
export type CompareState = {
  status: "running" | "stopping"
  startedAt: string
  benchmark?: string
  runIds: string[]
}

const activeCompares = new Map<string, CompareState>()

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function shouldStop(compareId: string): boolean {
  const state = activeCompares.get(compareId)
  return state?.status === "stopping"
}

function requestStop(compareId: string): boolean {
  const state = activeCompares.get(compareId)
  if (!state) return false
  state.status = "stopping"
  return true
}

function startCompare(compareId: string, benchmark: string, runIds: string[]): void {
  activeCompares.set(compareId, {
    status: "running",
    startedAt: new Date().toISOString(),
    benchmark,
    runIds,
  })
}

function endCompare(compareId: string): void {
  activeCompares.delete(compareId)
}

function isCompareActive(compareId: string): boolean {
  return activeCompares.has(compareId)
}

function getCompareState(compareId: string): CompareState | undefined {
  return activeCompares.get(compareId)
}

export async function handleCompareRoutes(req: Request, url: URL): Promise<Response | null> {
  const method = req.method
  const pathname = url.pathname

  // GET /api/compare - List all comparisons
  if (method === "GET" && pathname === "/api/compare") {
    if (!existsSync(COMPARE_DIR)) {
      return json([])
    }

    const compareIds = readdirSync(COMPARE_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()

    const compareDetails = compareIds
      .map((compareId) => {
        const manifest = batchManager.loadManifest(compareId)
        if (!manifest) return null

        // Calculate progress for each run
        const runProgress = manifest.runs.map((run) => {
          const checkpoint = checkpointManager.load(run.runId)
          if (!checkpoint) {
            return {
              provider: run.provider,
              runId: run.runId,
              progress: { total: 0, evaluated: 0 },
              status: "pending",
            }
          }
          const summary = checkpointManager.getSummary(checkpoint)
          const status = getRunStatus(checkpoint, summary)
          return {
            provider: run.provider,
            runId: run.runId,
            progress: summary,
            status,
          }
        })

        // Overall comparison status
        const allCompleted = runProgress.every((r) => r.status === "completed")
        const anyFailed = runProgress.some((r) => r.status === "failed")
        const anyRunning = runProgress.some((r) => r.status === "running")
        const compareState = getCompareState(compareId)

        let overallStatus: string
        if (compareState?.status === "stopping") {
          overallStatus = "stopping"
        } else if (compareState?.status === "running" || anyRunning) {
          overallStatus = "running"
        } else if (anyFailed) {
          overallStatus = "failed"
        } else if (allCompleted) {
          overallStatus = "completed"
        } else {
          overallStatus = "partial"
        }

        return {
          compareId,
          benchmark: manifest.benchmark,
          judge: manifest.judge,
          answeringModel: manifest.answeringModel,
          createdAt: manifest.createdAt,
          updatedAt: manifest.updatedAt,
          targetQuestionCount: manifest.targetQuestionIds.length,
          providers: manifest.runs.map((r) => r.provider),
          status: overallStatus,
          runProgress,
        }
      })
      .filter(Boolean)
      .sort((a: any, b: any) => (b.createdAt || "").localeCompare(a.createdAt || ""))

    return json(compareDetails)
  }

  // POST /api/compare/start - Start new comparison
  if (method === "POST" && pathname === "/api/compare/start") {
    try {
      const body = await req.json()
      const { providers, benchmark, judgeModel, answeringModel, sampling, force } = body

      if (!providers || !Array.isArray(providers) || providers.length === 0) {
        return json({ error: "Missing or invalid providers array" }, 400)
      }
      if (!benchmark || !judgeModel || !answeringModel) {
        return json(
          { error: "Missing required fields: benchmark, judgeModel, answeringModel" },
          400
        )
      }

      // Initialize comparison and wait for manifest + checkpoints to be created
      const { compareId } = await initializeComparison({
        providers: providers as ProviderName[],
        benchmark: benchmark as BenchmarkName,
        judgeModel,
        answeringModel,
        sampling,
        force,
      })

      return json({ message: "Comparison started", compareId })
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "Invalid request body" }, 400)
    }
  }

  // GET /api/compare/:compareId - Get comparison detail with run progress
  const compareIdMatch = pathname.match(/^\/api\/compare\/([^/]+)$/)
  if (method === "GET" && compareIdMatch) {
    const compareId = decodeURIComponent(compareIdMatch[1])
    const manifest = batchManager.loadManifest(compareId)
    if (!manifest) {
      return json({ error: "Comparison not found" }, 404)
    }

    // Get detailed progress for each run
    const runDetails = manifest.runs.map((run) => {
      const checkpoint = checkpointManager.load(run.runId)
      if (!checkpoint) {
        return {
          provider: run.provider,
          runId: run.runId,
          status: "pending",
          summary: { total: 0, ingested: 0, indexed: 0, searched: 0, answered: 0, evaluated: 0 },
        }
      }

      const summary = checkpointManager.getSummary(checkpoint)
      const status = getRunStatus(checkpoint, summary)

      // Calculate accuracy from checkpoint questions
      const questions = Object.values(checkpoint.questions)
      const evaluatedQuestions = questions.filter(
        (q: any) => q.phases?.evaluate?.status === "completed"
      )
      const correctCount = evaluatedQuestions.filter(
        (q: any) => q.phases?.evaluate?.score === 1
      ).length
      const accuracy =
        evaluatedQuestions.length > 0 ? correctCount / evaluatedQuestions.length : null

      return {
        provider: run.provider,
        runId: run.runId,
        status,
        progress: summary,
        accuracy,
      }
    })

    // Calculate overall status - must match list endpoint logic exactly
    const compareState = getCompareState(compareId)
    const allCompleted = runDetails.every((r) => r.status === "completed")
    const anyFailed = runDetails.some((r) => r.status === "failed")
    const anyRunning = runDetails.some((r) => r.status === "running")

    let overallStatus: string
    if (compareState?.status === "stopping") {
      overallStatus = "stopping"
    } else if (compareState?.status === "running" || anyRunning) {
      overallStatus = "running"
    } else if (anyFailed) {
      overallStatus = "failed"
    } else if (allCompleted) {
      overallStatus = "completed"
    } else {
      overallStatus = "partial"
    }

    return json({
      ...manifest,
      providers: manifest.runs.map((r) => r.provider),
      status: overallStatus,
      runs: runDetails,
    })
  }

  // GET /api/compare/:compareId/report - Get aggregated reports
  const reportMatch = pathname.match(/^\/api\/compare\/([^/]+)\/report$/)
  if (method === "GET" && reportMatch) {
    const compareId = decodeURIComponent(reportMatch[1])
    const manifest = batchManager.loadManifest(compareId)
    if (!manifest) {
      return json({ error: "Comparison not found" }, 404)
    }

    const reports = batchManager.getReports(manifest)
    if (reports.length === 0) {
      return json({ error: "No reports available yet" }, 404)
    }

    // Return aggregated data
    return json({
      compareId: manifest.compareId,
      benchmark: manifest.benchmark,
      judge: manifest.judge,
      answeringModel: manifest.answeringModel,
      reports: reports.map((r) => ({
        provider: r.provider,
        report: r.report,
      })),
    })
  }

  // POST /api/compare/:compareId/stop - Stop all runs in comparison
  const stopMatch = pathname.match(/^\/api\/compare\/([^/]+)\/stop$/)
  if (method === "POST" && stopMatch) {
    const compareId = decodeURIComponent(stopMatch[1])
    if (!isCompareActive(compareId)) {
      return json({ error: "Comparison is not active" }, 404)
    }

    const success = requestStop(compareId)
    if (!success) {
      return json({ error: "Failed to request stop" }, 500)
    }

    // Broadcast stop event
    wsManager.broadcast({
      type: "compare_stopping",
      compareId,
    })

    return json({ message: "Stop requested for comparison", compareId })
  }

  // POST /api/compare/:compareId/resume - Resume comparison
  const resumeMatch = pathname.match(/^\/api\/compare\/([^/]+)\/resume$/)
  if (method === "POST" && resumeMatch) {
    const compareId = decodeURIComponent(resumeMatch[1])

    if (isCompareActive(compareId)) {
      return json({ error: "Comparison is already active" }, 409)
    }

    const manifest = batchManager.loadManifest(compareId)
    if (!manifest) {
      return json({ error: "Comparison not found" }, 404)
    }

    // Resume the comparison
    resumeComparison(compareId)

    return json({ message: "Comparison resumed", compareId })
  }

  // DELETE /api/compare/:compareId - Delete comparison
  const deleteMatch = pathname.match(/^\/api\/compare\/([^/]+)$/)
  if (method === "DELETE" && deleteMatch) {
    const compareId = decodeURIComponent(deleteMatch[1])

    if (isCompareActive(compareId)) {
      return json({ error: "Cannot delete active comparison" }, 409)
    }

    batchManager.delete(compareId)
    return json({ message: "Comparison deleted", compareId })
  }

  return null
}

function getRunStatus(checkpoint: any, summary: any): string {
  // Active process takes priority
  const runState = getRunState(checkpoint.runId)
  if (runState) {
    return runState.status // "running" or "stopping"
  }

  // Use persisted status from checkpoint (handles crash/stop cases)
  if (checkpoint.status === "completed") {
    return "completed"
  }
  if (checkpoint.status === "failed") {
    return "failed"
  }

  // Check if any question has a failed phase
  const questions = Object.values(checkpoint.questions || {}) as any[]
  const hasFailed = questions.some((q: any) => {
    const phases = q.phases || {}
    return (
      phases.ingest?.status === "failed" ||
      phases.indexing?.status === "failed" ||
      phases.search?.status === "failed" ||
      phases.answer?.status === "failed" ||
      phases.evaluate?.status === "failed"
    )
  })

  if (hasFailed) {
    return "failed"
  }

  if (summary.evaluated === summary.total && summary.total > 0) {
    return "completed"
  }

  // If checkpoint was ever started (status changed from initializing), it's partial
  if (checkpoint.status === "running" || checkpoint.status === "initializing") {
    // Was started but no active process - must have crashed/stopped
    if (summary.ingested > 0 || checkpoint.status === "running") {
      return "partial"
    }
    return "pending"
  }

  if (summary.ingested === 0) {
    return "pending"
  }
  return "partial"
}

async function initializeComparison(options: {
  providers: ProviderName[]
  benchmark: BenchmarkName
  judgeModel: string
  answeringModel: string
  sampling?: SamplingConfig
  force?: boolean
}): Promise<{ compareId: string }> {
  // Only await manifest creation - this is fast
  const manifest = await batchManager.createManifest(options)
  const compareId = manifest.compareId

  startCompare(
    compareId,
    options.benchmark,
    manifest.runs.map((r) => r.runId)
  )

  wsManager.broadcast({
    type: "compare_started",
    compareId,
    benchmark: options.benchmark,
    providers: options.providers,
  })

  // Run execution in background - don't await
  batchManager
    .executeRuns(manifest)
    .then(() => {
      wsManager.broadcast({
        type: "compare_complete",
        compareId,
      })
    })
    .catch((error) => {
      wsManager.broadcast({
        type: "error",
        compareId,
        message: error instanceof Error ? error.message : "Unknown error",
      })
    })
    .finally(() => {
      endCompare(compareId)
    })

  return { compareId }
}

async function resumeComparison(compareId: string) {
  try {
    const manifest = batchManager.loadManifest(compareId)
    if (!manifest) {
      throw new Error(`Comparison not found: ${compareId}`)
    }

    startCompare(
      compareId,
      manifest.benchmark,
      manifest.runs.map((r) => r.runId)
    )

    wsManager.broadcast({
      type: "compare_resumed",
      compareId,
    })

    await batchManager.resume(compareId)

    wsManager.broadcast({
      type: "compare_complete",
      compareId,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    wsManager.broadcast({
      type: "error",
      compareId,
      message,
    })
  } finally {
    endCompare(compareId)
  }
}
