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
      const containerTag = `${question.questionId}-${checkpoint.dataSourceRunId}`
      const sessions = benchmark.getHaystackSessions(question.questionId)

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
        const ingestPhase = checkpoint.questions[question.questionId].phases.ingest
        const completedSessions = ingestPhase.completedSessions

        // Start from what earlier attempts already persisted rather than merging it
        // in at the end, so the accumulated result covers every session listed in
        // completedSessions at every point in the loop, not just once the loop has
        // run to completion. The arrays are copied so the working result is not an
        // alias of the checkpoint's until it is written back below.
        const previousResult = ingestPhase.ingestResult
        const combinedResult: IngestResult = {
          documentIds: [...(previousResult?.documentIds || [])],
          taskIds: [...(previousResult?.taskIds || [])],
        }

        for (const session of sessions) {
          if (completedSessions.includes(session.sessionId)) {
            continue
          }

          const result = await provider.ingest([session], { containerTag })

          combinedResult.documentIds.push(...result.documentIds)
          if (result.taskIds) {
            combinedResult.taskIds!.push(...result.taskIds)
          }

          // Persist the ids together with the session that produced them. A session
          // recorded in completedSessions is skipped on resume, so ids left only in
          // this in-memory object would be lost for good if a later session threw —
          // and indexing would then wait on a short list and let search run before
          // those sessions were queryable. save() serialises at call time, so
          // handing it the working object records the ids gathered so far.
          completedSessions.push(session.sessionId)
          checkpointManager.updatePhase(checkpoint, question.questionId, "ingest", {
            completedSessions,
            ingestResult: combinedResult,
          })
        }

        if (combinedResult.taskIds && combinedResult.taskIds.length === 0) {
          delete combinedResult.taskIds
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
