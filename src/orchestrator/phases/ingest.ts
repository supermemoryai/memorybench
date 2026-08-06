import type { Provider } from "../../types/provider"
import type { BuildAttemptMetrics, RunCheckpoint } from "../../types/checkpoint"
import { logger } from "../../utils/logger"
import { resolveConcurrency } from "../../types/concurrency"
import { CheckpointManager } from "../checkpoint"
import { assertCompletedSessionsAreOrderedPrefix, type ValidatedBuildPlan } from "../builds"
import { ConcurrentExecutor } from "../concurrent"
import { validateCompletedIndexingProgress } from "./indexing"
import type { CanonicalIngestionDocument } from "../../types/unified"
import type { IndexingProgress, IngestResult } from "../../types/provider"

const RATE_LIMIT_MS = 1000
export const DEFAULT_INGEST_READINESS_TIMEOUT_MS = 5 * 60 * 1000

function totalAttemptDuration(attempts: BuildAttemptMetrics[]): number {
  return attempts.reduce((sum, attempt) => sum + (attempt.durationMs ?? 0), 0)
}

function attributeBatchResult(
  documents: CanonicalIngestionDocument[],
  result: IngestResult
): Array<{ customId: string; documentIds: string[]; taskIds: string[]; error?: string }> {
  if (result.items) {
    if (result.items.length !== documents.length) {
      throw new Error(
        `Provider returned ${result.items.length} item outcomes for ${documents.length} documents`
      )
    }
    const byCustomId = new Map(result.items.map((item) => [item.customId, item]))
    if (byCustomId.size !== result.items.length) {
      throw new Error("Provider returned duplicate custom IDs in batch outcomes")
    }
    const attributed = documents.map((document) => {
      const item = byCustomId.get(document.customId)
      if (!item) throw new Error(`Provider omitted batch outcome for ${document.customId}`)
      return {
        customId: item.customId,
        documentIds: [...item.documentIds],
        taskIds: [...(item.taskIds ?? [])],
        ...(item.error ? { error: item.error } : {}),
      }
    })
    const attributedDocumentIds = attributed.flatMap((item) => item.documentIds)
    const attributedTaskIds = attributed.flatMap((item) => item.taskIds)
    if (
      new Set(attributedDocumentIds).size !== attributedDocumentIds.length ||
      new Set(attributedTaskIds).size !== attributedTaskIds.length ||
      attributedDocumentIds.length !== result.documentIds.length ||
      attributedTaskIds.length !== (result.taskIds ?? []).length ||
      attributedDocumentIds.some((id) => !result.documentIds.includes(id)) ||
      attributedTaskIds.some((id) => !(result.taskIds ?? []).includes(id))
    ) {
      throw new Error("Provider aggregate ingest IDs do not match its per-item outcomes")
    }
    return attributed
  }

  if (documents.length === 1) {
    return [
      {
        customId: documents[0]!.customId,
        documentIds: [...result.documentIds],
        taskIds: [...(result.taskIds ?? [])],
      },
    ]
  }

  const documentIds = result.documentIds ?? []
  const taskIds = result.taskIds ?? []
  const count = documents.length
  const documentIdsAreAttributable = documentIds.length === 0 || documentIds.length === count
  const taskIdsAreAttributable = taskIds.length === 0 || taskIds.length === count
  if (
    !documentIdsAreAttributable ||
    !taskIdsAreAttributable ||
    (documentIds.length === 0 && taskIds.length === 0)
  ) {
    throw new Error(
      `Provider returned ${documentIds.length} document IDs and ${taskIds.length} task IDs for an ordered batch of ${count} sessions`
    )
  }

  return documents.map((_, index) => ({
    customId: documents[index]!.customId,
    documentIds: documentIds.length === count ? [documentIds[index]!] : [],
    taskIds: taskIds.length === count ? [taskIds[index]!] : [],
  }))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((id) => right.includes(id)) &&
    right.every((id) => left.includes(id))
  )
}

function unresolvedPhysicalIds(build: RunCheckpoint["builds"][string]): string[] {
  return [
    ...new Set(
      (build.ingest.deferredSessions ?? []).flatMap((deferred) => [
        ...deferred.documentIds,
        ...deferred.taskIds,
      ])
    ),
  ].filter((id) => !build.indexing.completedIds.includes(id))
}

export async function runIngestPhase(
  provider: Provider,
  checkpoint: RunCheckpoint,
  checkpointManager: CheckpointManager,
  plans: ValidatedBuildPlan[]
): Promise<void> {
  const planByBuildId = new Map(plans.map((plan) => [plan.buildId, plan]))
  const pendingBuilds = Object.values(checkpoint.builds).filter(
    (build) => build.ingest.status !== "completed"
  )

  if (pendingBuilds.length === 0) {
    logger.info("No builds pending ingestion")
    return
  }

  const missingDates = pendingBuilds.reduce((sum, build) => sum + build.missingDocumentDateCount, 0)
  const ingestBatchSizes = [...new Set(pendingBuilds.map((build) => build.ingestBatchSize ?? 1))]
  logger.info(
    `Ingesting ${pendingBuilds.length} builds in ordered session batches of ${ingestBatchSizes.join(",")}; ${missingDates} sessions have no valid source date`
  )
  const ingestConcurrency = resolveConcurrency(
    "ingest",
    checkpoint.concurrency,
    provider.concurrency
  )
  const hasPerDocumentBarrier = pendingBuilds.some(
    (build) => build.ingestionExecutionPolicy.readinessBarrier === "after-each-document"
  )
  const concurrency = hasPerDocumentBarrier
    ? Math.min(
        ingestConcurrency,
        resolveConcurrency("indexing", checkpoint.concurrency, provider.concurrency)
      )
    : ingestConcurrency

  await ConcurrentExecutor.executeBatched({
    items: pendingBuilds,
    concurrency,
    rateLimitMs: RATE_LIMIT_MS,
    runId: checkpoint.runId,
    phaseName: "ingest",
    executeTask: async ({ item: build, index, total }) => {
      const plan = planByBuildId.get(build.buildId)
      if (!plan) throw new Error(`Missing validated ingestion plan for ${build.buildId}`)
      assertCompletedSessionsAreOrderedPrefix(build)

      const startedAt = new Date().toISOString()
      const requiresSessionBarrier =
        build.ingestionExecutionPolicy.readinessBarrier === "after-each-document"
      const attempt: BuildAttemptMetrics = {
        phase: "ingest",
        attempt: build.ingest.attempts.length + 1,
        startedAt,
        status: "in_progress",
        costUsd: null,
      }
      const indexingAttempt: BuildAttemptMetrics | undefined = requiresSessionBarrier
        ? {
            phase: "indexing",
            attempt: build.indexing.attempts.length + 1,
            startedAt,
            status: "in_progress",
            costUsd: null,
          }
        : undefined
      let ingestDurationMs = 0
      let indexingDurationMs = 0
      const readinessTimeoutMs =
        checkpoint.ingestReadinessTimeoutMs ?? DEFAULT_INGEST_READINESS_TIMEOUT_MS

      const awaitReadiness = async (
        result: IngestResult
      ): Promise<{ progress: IndexingProgress; error?: string }> => {
        const expectedIds = [...result.documentIds, ...(result.taskIds ?? [])]
        let progress: IndexingProgress = {
          completedIds: [],
          failedIds: [],
          total: expectedIds.length,
        }
        const indexingStartedMs = Date.now()
        let failure: string | undefined
        try {
          await provider.awaitIndexing(
            result,
            build.containerTag,
            (current) => {
              progress = {
                completedIds: [...current.completedIds],
                failedIds: [...current.failedIds],
                total: current.total,
              }
            },
            { timeoutMs: readinessTimeoutMs }
          )
          try {
            validateCompletedIndexingProgress(expectedIds, progress)
          } catch (error) {
            failure = errorMessage(error)
          }
        } catch (error) {
          failure = errorMessage(error)
        } finally {
          indexingDurationMs += Date.now() - indexingStartedMs
        }
        return { progress, ...(failure ? { error: failure } : {}) }
      }

      checkpointManager.updateBuild(checkpoint, build.buildId, (current) => {
        current.ingest.status = "in_progress"
        current.ingest.startedAt ??= startedAt
        current.ingest.error = undefined
        current.ingest.attempts.push(attempt)
        if (indexingAttempt) {
          current.indexing.status = "in_progress"
          current.indexing.startedAt ??= startedAt
          current.indexing.error = undefined
          current.indexing.failedIds = []
          current.indexing.attempts.push(indexingAttempt)
        }
      })

      try {
        const firstIncompleteIndex = build.ingest.completedSessionIds.length
        const ingestBatchSize = build.ingestBatchSize ?? 1
        for (
          let documentIndex = firstIncompleteIndex;
          documentIndex < plan.documents.length;
          documentIndex += ingestBatchSize
        ) {
          const documents = plan.documents.slice(documentIndex, documentIndex + ingestBatchSize)
          const ingestStartedMs = Date.now()
          let attributedResults: ReturnType<typeof attributeBatchResult>
          try {
            const result = await provider.ingest(documents, {
              containerTag: build.containerTag,
              ...(build.ingestionExecutionPolicy.processingMode === "instant"
                ? { processingMode: "instant" as const }
                : {}),
            })
            attributedResults = attributeBatchResult(documents, result)
          } catch (error) {
            const message = errorMessage(error)
            attributedResults = documents.map((document) => ({
              customId: document.customId,
              documentIds: [],
              taskIds: [],
              error: message,
            }))
          } finally {
            ingestDurationMs += Date.now() - ingestStartedMs
          }

          let readiness: { progress: IndexingProgress; error?: string } | undefined
          if (requiresSessionBarrier) {
            const submitted = attributedResults.filter((item) => !item.error)
            const submittedResult: IngestResult = {
              documentIds: submitted.flatMap((item) => item.documentIds),
              taskIds: submitted.flatMap((item) => item.taskIds),
            }
            if (submittedResult.documentIds.length + (submittedResult.taskIds?.length ?? 0) > 0) {
              readiness = await awaitReadiness(submittedResult)
            }
          }

          for (const [offset, document] of documents.entries()) {
            const attributed = attributedResults[offset]!
            const physicalIds = [...attributed.documentIds, ...attributed.taskIds]
            let deferredFailure:
              | { customId: string; stage: "submission" | "readiness"; error: string }
              | undefined
            if (attributed.error) {
              deferredFailure = {
                customId: document.customId,
                stage: "submission",
                error: attributed.error,
              }
            } else if (requiresSessionBarrier) {
              const completedIds = new Set(readiness?.progress.completedIds ?? [])
              const failedIds = physicalIds.filter((id) =>
                (readiness?.progress.failedIds ?? []).includes(id)
              )
              const pendingIds = physicalIds.filter(
                (id) => !completedIds.has(id) && !failedIds.includes(id)
              )
              if (physicalIds.length === 0 || failedIds.length > 0 || pendingIds.length > 0) {
                deferredFailure = {
                  customId: document.customId,
                  stage: "readiness",
                  error:
                    failedIds.length > 0
                      ? `Provider reported failed IDs: ${failedIds.join(", ")}`
                      : (readiness?.error ??
                        (physicalIds.length === 0
                          ? "Provider returned no physical document/task ID"
                          : `Readiness is still pending for: ${pendingIds.join(", ")}`)),
                }
              }
            }
            checkpointManager.recordIngestProgress(checkpoint, build.buildId, {
              sequence: documentIndex + offset,
              sessionId: document.metadata.sessionId,
              documentIds: attributed.documentIds,
              taskIds: attributed.taskIds,
              readyForNextSession: requiresSessionBarrier && !deferredFailure,
              ...(deferredFailure ? { deferredFailure } : {}),
            })
            if (deferredFailure) {
              logger.warn(
                `Deferred ${document.customId} in ${build.containerTag} (${deferredFailure.stage}): ${deferredFailure.error}`
              )
            }
          }
        }

        const deferredFirstPass = [...(build.ingest.deferredSessions ?? [])].sort(
          (left, right) => left.sequence - right.sequence
        )
        if (deferredFirstPass.length > 0) {
          logger.warn(
            `Retrying ${deferredFirstPass.length} deferred sessions in ${build.containerTag}`
          )
        }
        for (const deferredSnapshot of deferredFirstPass) {
          const document = plan.documents[deferredSnapshot.sequence]
          if (
            !document ||
            document.metadata.sessionId !== deferredSnapshot.sessionId ||
            document.customId !== deferredSnapshot.customId
          ) {
            throw new Error(
              `Deferred session ${deferredSnapshot.sessionId} no longer matches its validated plan`
            )
          }

          let attributed: ReturnType<typeof attributeBatchResult>[number] | undefined
          let retryStage: "submission" | "readiness" = "submission"
          let retryError: string | undefined
          let changedPhysicalIds = false
          const retryIngestStartedMs = Date.now()
          try {
            const result = await provider.ingest([document], {
              containerTag: build.containerTag,
              ...(build.ingestionExecutionPolicy.processingMode === "instant"
                ? { processingMode: "instant" as const }
                : {}),
            })
            attributed = attributeBatchResult([document], result)[0]!
            retryError = attributed.error
          } catch (error) {
            retryError = errorMessage(error)
          } finally {
            ingestDurationMs += Date.now() - retryIngestStartedMs
          }

          if (attributed && !retryError) {
            if (
              deferredSnapshot.documentIds.length + deferredSnapshot.taskIds.length > 0 &&
              (!sameIds(deferredSnapshot.documentIds, attributed.documentIds) ||
                !sameIds(deferredSnapshot.taskIds, attributed.taskIds))
            ) {
              changedPhysicalIds = true
              retryError = `Retry changed physical IDs for ${deferredSnapshot.customId}`
            } else if (attributed.documentIds.length + attributed.taskIds.length === 0) {
              retryError = "Provider returned no physical document/task ID"
            }
          }

          if (attributed && !retryError && requiresSessionBarrier) {
            retryStage = "readiness"
            const retryResult: IngestResult = {
              documentIds: [...attributed.documentIds],
              taskIds: [...attributed.taskIds],
            }
            const retryReadiness = await awaitReadiness(retryResult)
            const expectedIds = [...attributed.documentIds, ...attributed.taskIds]
            const completedIds = new Set(retryReadiness.progress.completedIds)
            const failedIds = expectedIds.filter((id) =>
              retryReadiness.progress.failedIds.includes(id)
            )
            const pendingIds = expectedIds.filter(
              (id) => !completedIds.has(id) && !failedIds.includes(id)
            )
            if (failedIds.length > 0 || pendingIds.length > 0) {
              retryError =
                failedIds.length > 0
                  ? `Provider reported failed IDs: ${failedIds.join(", ")}`
                  : (retryReadiness.error ??
                    `Readiness is still pending for: ${pendingIds.join(", ")}`)
            }
          }

          if (retryError || !attributed) {
            const failedAt = new Date().toISOString()
            checkpointManager.updateBuild(checkpoint, build.buildId, (current) => {
              const deferred = (current.ingest.deferredSessions ?? []).find(
                (candidate) => candidate.sequence === deferredSnapshot.sequence
              )
              if (!deferred) {
                throw new Error(`Missing deferred session ${deferredSnapshot.sessionId}`)
              }
              if (attributed && !changedPhysicalIds) {
                deferred.documentIds = [...attributed.documentIds]
                deferred.taskIds = [...attributed.taskIds]
                current.ingest.documentIds = [
                  ...new Set([...current.ingest.documentIds, ...attributed.documentIds]),
                ]
                current.ingest.taskIds = [
                  ...new Set([...current.ingest.taskIds, ...attributed.taskIds]),
                ]
              }
              deferred.stage = retryStage
              deferred.attempts += 1
              deferred.lastFailedAt = failedAt
              deferred.lastError = retryError ?? "Unknown retry failure"
            })
            await checkpointManager.flush(checkpoint.runId)
            logger.warn(
              `Retry failed for ${deferredSnapshot.customId} in ${build.containerTag}: ${retryError ?? "unknown error"}`
            )
            continue
          }

          checkpointManager.updateBuild(checkpoint, build.buildId, (current) => {
            current.ingest.documentIds = [
              ...new Set([...current.ingest.documentIds, ...attributed!.documentIds]),
            ]
            current.ingest.taskIds = [
              ...new Set([...current.ingest.taskIds, ...attributed!.taskIds]),
            ]
            current.ingest.deferredSessions = (current.ingest.deferredSessions ?? []).filter(
              (candidate) => candidate.sequence !== deferredSnapshot.sequence
            )
            if (requiresSessionBarrier) {
              current.indexing.completedIds = [
                ...new Set([
                  ...current.indexing.completedIds,
                  ...attributed!.documentIds,
                  ...attributed!.taskIds,
                ]),
              ]
              current.indexing.failedIds = current.indexing.failedIds.filter(
                (id) => !attributed!.documentIds.includes(id) && !attributed!.taskIds.includes(id)
              )
            }
          })
          await checkpointManager.flush(checkpoint.runId)
          logger.info(`Recovered ${deferredSnapshot.customId} in ${build.containerTag}`)
        }

        const remainingDeferred = build.ingest.deferredSessions ?? []
        if (remainingDeferred.length > 0) {
          const completedAt = new Date().toISOString()
          const message = `${remainingDeferred.length} sessions remain deferred after end-of-build retry: ${remainingDeferred
            .slice(0, 5)
            .map((deferred) => deferred.customId)
            .join(", ")}`
          checkpointManager.updateBuild(checkpoint, build.buildId, (current) => {
            const currentAttempt = current.ingest.attempts.at(-1)!
            Object.assign(currentAttempt, {
              status: "failed",
              completedAt,
              durationMs: ingestDurationMs,
              error: message,
            })
            current.ingest.status = "failed"
            current.ingest.error = message
            current.ingest.durationMs = totalAttemptDuration(current.ingest.attempts)
            if (requiresSessionBarrier) {
              const currentIndexingAttempt = current.indexing.attempts.at(-1)!
              Object.assign(currentIndexingAttempt, {
                status: "failed",
                completedAt,
                durationMs: indexingDurationMs,
                error: message,
              })
              current.indexing.status = "failed"
              current.indexing.error = message
              current.indexing.durationMs = totalAttemptDuration(current.indexing.attempts)
              current.indexing.failedIds = unresolvedPhysicalIds(current)
            }
          })
          await checkpointManager.flush(checkpoint.runId)
          logger.warn(`Build ${build.ingestionGroupId} finished its first pass with ${message}`)
          return {
            buildId: build.buildId,
            durationMs: ingestDurationMs + indexingDurationMs,
            unresolved: remainingDeferred.length,
          }
        }

        const completedAt = new Date().toISOString()
        checkpointManager.updateBuild(checkpoint, build.buildId, (current) => {
          const currentAttempt = current.ingest.attempts.at(-1)!
          Object.assign(currentAttempt, {
            status: "completed",
            completedAt,
            durationMs: ingestDurationMs,
          })
          current.ingest.status = "completed"
          current.ingest.completedAt = completedAt
          current.ingest.durationMs = totalAttemptDuration(current.ingest.attempts)
          current.ingest.error = undefined
          if (requiresSessionBarrier) {
            const currentIndexingAttempt = current.indexing.attempts.at(-1)!
            Object.assign(currentIndexingAttempt, {
              status: "completed",
              completedAt,
              durationMs: indexingDurationMs,
            })
            current.indexing.status = "completed"
            current.indexing.completedAt = completedAt
            current.indexing.durationMs = totalAttemptDuration(current.indexing.attempts)
            current.indexing.completedIds = [
              ...new Set([...current.ingest.documentIds, ...current.ingest.taskIds]),
            ]
            current.indexing.failedIds = []
            current.indexing.error = undefined
          }
        })
        // Compact the fsynced per-session journal only after the full completed
        // build checkpoint has itself become durable.
        await checkpointManager.flush(checkpoint.runId)
        checkpointManager.clearIngestProgressJournal(checkpoint.runId, build.buildId)
        const totalDurationMs = ingestDurationMs + indexingDurationMs
        logger.progress(
          index + 1,
          total,
          requiresSessionBarrier
            ? `Ingested and indexed ${build.ingestionGroupId} (${totalDurationMs}ms)`
            : `Ingested ${build.ingestionGroupId} (${ingestDurationMs}ms)`
        )
        return { buildId: build.buildId, durationMs: totalDurationMs }
      } catch (error) {
        const message = errorMessage(error)
        const completedAt = new Date().toISOString()
        checkpointManager.updateBuild(checkpoint, build.buildId, (current) => {
          const currentAttempt = current.ingest.attempts.at(-1)!
          Object.assign(currentAttempt, {
            status: "failed",
            completedAt,
            durationMs: ingestDurationMs,
            error: message,
          })
          current.ingest.status = "failed"
          current.ingest.error = message
          current.ingest.durationMs = totalAttemptDuration(current.ingest.attempts)
          if (requiresSessionBarrier) {
            const currentIndexingAttempt = current.indexing.attempts.at(-1)!
            Object.assign(currentIndexingAttempt, {
              status: "failed",
              completedAt,
              durationMs: indexingDurationMs,
              error: message,
            })
            current.indexing.status = "failed"
            current.indexing.error = message
            current.indexing.durationMs = totalAttemptDuration(current.indexing.attempts)
            current.indexing.failedIds = unresolvedPhysicalIds(current)
          }
        })
        throw new Error(
          `Ingest failed at ${build.ingestionGroupId}: ${message}. Fix the issue and resume with the same run ID.`
        )
      }
    },
  })

  const unresolvedBuilds = Object.values(checkpoint.builds).filter(
    (build) => (build.ingest.deferredSessions ?? []).length > 0
  )
  if (unresolvedBuilds.length > 0) {
    const unresolvedSessions = unresolvedBuilds.reduce(
      (sum, build) => sum + (build.ingest.deferredSessions?.length ?? 0),
      0
    )
    throw new Error(
      `Ingest first pass completed, but ${unresolvedSessions} sessions across ${unresolvedBuilds.length} builds still need retry. Resume with the same run ID.`
    )
  }

  logger.success("Ingest phase complete")
}
