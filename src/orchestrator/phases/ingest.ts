import type { Provider, IngestResult } from "../../types/provider"
import type { Benchmark } from "../../types/benchmark"
import type { RunCheckpoint } from "../../types/checkpoint"
import { CheckpointManager } from "../checkpoint"
import { logger } from "../../utils/logger"
import { ConcurrentExecutor } from "../concurrent"
import { resolveConcurrency } from "../../types/concurrency"

const RATE_LIMIT_MS = 1000

export async function runIngestPhase(
  provider: Provider,
  benchmark: Benchmark,
  checkpoint: RunCheckpoint,
  checkpointManager: CheckpointManager,
  questionIds?: string[]
): Promise<void> {
  const questions = benchmark.getQuestions()
  const targetQuestions = questionIds
    ? questions.filter((q) => questionIds.includes(q.questionId))
    : questions

  const pendingQuestions = targetQuestions.filter((q) => {
    const status = checkpointManager.getPhaseStatus(checkpoint, q.questionId, "ingest")
    return status !== "completed"
  })

  if (pendingQuestions.length === 0) {
    logger.info("No questions pending ingestion")
    return
  }

  const concurrency = resolveConcurrency("ingest", checkpoint.concurrency, provider.concurrency)

  logger.info(`Ingesting ${pendingQuestions.length} questions (concurrency: ${concurrency})...`)

  await ConcurrentExecutor.executeBatched({
    items: pendingQuestions,
    concurrency,
    rateLimitMs: RATE_LIMIT_MS,
    runId: checkpoint.runId,
    phaseName: "ingest",
    executeTask: async ({ item: question, index, total }) => {
      const containerTag = checkpoint.questions[question.questionId].containerTag
      const sessions = benchmark.getHaystackSessions(question.questionId)
      const requiresSequentialIndexing = sessions.some(
        (session) => session.metadata?.filterByMetadata !== undefined
      )

      if (requiresSequentialIndexing) {
        logger.info(
          `Using sequential filtered-write ingestion for ${question.questionId}; each document will finish indexing before the next is submitted`
        )
      }

      const sessionsMetadata = sessions.map((s) => ({
        sessionId: s.sessionId,
        date: s.metadata?.date as string | undefined,
        messageCount: s.messages.length,
      }))
      checkpointManager.updateSessions(checkpoint, question.questionId, sessionsMetadata)

      const startTime = Date.now()
      checkpointManager.updatePhase(checkpoint, question.questionId, "ingest", {
        status: "in_progress",
        startedAt: new Date().toISOString(),
      })

      try {
        const completedSessions =
          checkpoint.questions[question.questionId].phases.ingest.completedSessions
        const combinedResult: IngestResult = { documentIds: [], taskIds: [] }

        for (const session of sessions) {
          if (completedSessions.includes(session.sessionId)) {
            continue
          }

          const result = await provider.ingest([session], { containerTag })

          combinedResult.documentIds.push(...result.documentIds)
          if (result.taskIds) {
            combinedResult.taskIds!.push(...result.taskIds)
          }

          if (requiresSequentialIndexing) {
            let failedIds: string[] = []
            await provider.awaitIndexing(result, containerTag, (progress) => {
              failedIds = progress.failedIds
            })

            if (failedIds.length > 0) {
              throw new Error(
                `Indexing failed for session ${session.sessionId}: ${failedIds.join(", ")}`
              )
            }

            logger.info(`Indexed ${session.sessionId}`)

            const postIndexingDelayMs = session.metadata?.postIndexingDelayMs
            if (
              typeof postIndexingDelayMs === "number" &&
              Number.isFinite(postIndexingDelayMs) &&
              postIndexingDelayMs > 0
            ) {
              logger.info(
                `Waiting ${Math.round(postIndexingDelayMs / 1000)} seconds after ${session.sessionId} before continuing`
              )
              await new Promise((resolve) => setTimeout(resolve, postIndexingDelayMs))
              logger.info(`Post-indexing wait complete for ${session.sessionId}`)
            }
          }

          completedSessions.push(session.sessionId)
          checkpointManager.updatePhase(checkpoint, question.questionId, "ingest", {
            completedSessions,
          })
        }

        if (combinedResult.taskIds && combinedResult.taskIds.length === 0) {
          delete combinedResult.taskIds
        }

        const existingResult = checkpoint.questions[question.questionId].phases.ingest.ingestResult
        if (existingResult) {
          combinedResult.documentIds = [
            ...existingResult.documentIds,
            ...combinedResult.documentIds,
          ]
          if (existingResult.taskIds || combinedResult.taskIds) {
            combinedResult.taskIds = [
              ...(existingResult.taskIds || []),
              ...(combinedResult.taskIds || []),
            ]
          }
        }

        const durationMs = Date.now() - startTime
        checkpointManager.updatePhase(checkpoint, question.questionId, "ingest", {
          status: "completed",
          ingestResult: combinedResult,
          completedAt: new Date().toISOString(),
          durationMs,
        })

        logger.progress(index + 1, total, `Ingested ${question.questionId} (${durationMs}ms)`)

        return { questionId: question.questionId, durationMs }
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        checkpointManager.updatePhase(checkpoint, question.questionId, "ingest", {
          status: "failed",
          error,
        })
        logger.error(`Failed to ingest ${question.questionId}: ${error}`)
        throw new Error(
          `Ingest failed at ${question.questionId}: ${error}. Fix the issue and resume with the same run ID.`
        )
      }
    },
  })

  logger.success("Ingest phase complete")
}
