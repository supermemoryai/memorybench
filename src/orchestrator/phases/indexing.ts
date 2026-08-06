import type { BuildAttemptMetrics, RunCheckpoint } from "../../types/checkpoint"
import type { IndexingProgress, Provider } from "../../types/provider"
import { resolveConcurrency } from "../../types/concurrency"
import { logger } from "../../utils/logger"
import { CheckpointManager } from "../checkpoint"
import { ConcurrentExecutor } from "../concurrent"

function totalAttemptDuration(attempts: BuildAttemptMetrics[]): number {
  return attempts.reduce((sum, attempt) => sum + (attempt.durationMs ?? 0), 0)
}

export function validateCompletedIndexingProgress(
  expectedIds: readonly string[],
  progress: IndexingProgress
): void {
  const expected = new Set(expectedIds)
  if (expected.size !== expectedIds.length) {
    throw new Error("Indexing input contains duplicate document/task IDs")
  }
  if (!Number.isInteger(progress.total) || progress.total !== expected.size) {
    throw new Error(
      `Indexing provider reported total ${progress.total}; expected ${expected.size} unique IDs`
    )
  }
  if (new Set(progress.completedIds).size !== progress.completedIds.length) {
    throw new Error("Indexing provider reported duplicate completed IDs")
  }
  if (new Set(progress.failedIds).size !== progress.failedIds.length) {
    throw new Error("Indexing provider reported duplicate failed IDs")
  }
  const completed = new Set(progress.completedIds)
  const failed = new Set(progress.failedIds)
  for (const id of [...completed, ...failed]) {
    if (!expected.has(id)) throw new Error(`Indexing provider reported unknown ID ${id}`)
  }
  for (const id of completed) {
    if (failed.has(id)) throw new Error(`Indexing provider reported ${id} as completed and failed`)
  }
  if (failed.size > 0) {
    throw new Error(`${failed.size} indexing items failed: ${[...failed].join(", ")}`)
  }
  const missing = [...expected].filter((id) => !completed.has(id))
  if (missing.length > 0) {
    throw new Error(
      `Indexing provider returned before ${missing.length} IDs completed: ${missing.join(", ")}`
    )
  }
}

export async function runIndexingPhase(
  provider: Provider,
  checkpoint: RunCheckpoint,
  checkpointManager: CheckpointManager
): Promise<void> {
  const pendingBuilds = Object.values(checkpoint.builds).filter(
    (build) => build.ingest.status === "completed" && build.indexing.status !== "completed"
  )
  if (pendingBuilds.length === 0) {
    logger.info("No builds pending indexing")
    return
  }

  const concurrency = resolveConcurrency("indexing", checkpoint.concurrency, provider.concurrency)
  logger.info(
    `Awaiting indexing for ${pendingBuilds.length} builds (concurrency: ${concurrency})...`
  )

  await ConcurrentExecutor.execute(
    pendingBuilds,
    concurrency,
    checkpoint.runId,
    "indexing",
    async ({ item: build, index, total }) => {
      const ingestResult = {
        documentIds: [...build.ingest.documentIds],
        ...(build.ingest.taskIds.length > 0 ? { taskIds: [...build.ingest.taskIds] } : {}),
      }
      const expectedIds = [...ingestResult.documentIds, ...(ingestResult.taskIds ?? [])]
      const episodeCount = expectedIds.length
      const startedAt = new Date().toISOString()
      const startedMs = Date.now()
      const attempt: BuildAttemptMetrics = {
        phase: "indexing",
        attempt: build.indexing.attempts.length + 1,
        startedAt,
        status: "in_progress",
        costUsd: null,
      }
      checkpointManager.updateBuild(checkpoint, build.buildId, (current) => {
        current.indexing.status = "in_progress"
        current.indexing.startedAt ??= startedAt
        current.indexing.error = undefined
        current.indexing.attempts.push(attempt)
      })

      try {
        let lastProgress: IndexingProgress = {
          completedIds: [],
          failedIds: [],
          total: episodeCount,
        }
        await provider.awaitIndexing(ingestResult, build.containerTag, (progress) => {
          lastProgress = progress
          checkpointManager.updateBuild(checkpoint, build.buildId, (current) => {
            current.indexing.completedIds = [...progress.completedIds]
            current.indexing.failedIds = [...progress.failedIds]
          })
        })

        validateCompletedIndexingProgress(expectedIds, lastProgress)

        const completedAt = new Date().toISOString()
        const durationMs = Date.now() - startedMs
        checkpointManager.updateBuild(checkpoint, build.buildId, (current) => {
          const currentAttempt = current.indexing.attempts.at(-1)!
          Object.assign(currentAttempt, { status: "completed", completedAt, durationMs })
          current.indexing.status = "completed"
          current.indexing.completedAt = completedAt
          current.indexing.durationMs = totalAttemptDuration(current.indexing.attempts)
          current.indexing.completedIds = [...lastProgress.completedIds]
          current.indexing.failedIds = []
          current.indexing.error = undefined
        })
        logger.progress(index + 1, total, `Indexed ${build.ingestionGroupId} (${durationMs}ms)`)
        return { buildId: build.buildId, durationMs }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const completedAt = new Date().toISOString()
        const durationMs = Date.now() - startedMs
        checkpointManager.updateBuild(checkpoint, build.buildId, (current) => {
          const currentAttempt = current.indexing.attempts.at(-1)!
          Object.assign(currentAttempt, {
            status: "failed",
            completedAt,
            durationMs,
            error: message,
          })
          current.indexing.status = "failed"
          current.indexing.error = message
          current.indexing.durationMs = totalAttemptDuration(current.indexing.attempts)
        })
        throw new Error(
          `Indexing failed at ${build.containerTag}: ${message}. Fix the issue and resume with the same run ID.`
        )
      }
    }
  )

  logger.success("Indexing phase complete")
}
