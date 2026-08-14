import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  readdirSync,
  cpSync,
  renameSync,
  unlinkSync,
} from "fs"
import { join } from "path"
import type {
  RunCheckpoint,
  QuestionCheckpoint,
  PhaseStatus,
  PhaseId,
  RunStatus,
  SamplingConfig,
} from "../types/checkpoint"
import type { ConcurrencyConfig } from "../types/concurrency"
import { PHASE_ORDER } from "../types/checkpoint"
import { logger } from "../utils/logger"

const RUNS_DIR = "./data/runs"

export class CheckpointManager {
  private basePath: string
  private saveLock = new Map<string, Promise<void>>()
  /** Last save failure per run, recorded by save() and surfaced by flush(). */
  private saveErrors = new Map<string, Error>()

  constructor(basePath: string = RUNS_DIR) {
    this.basePath = basePath
  }

  getRunPath(runId: string): string {
    return join(this.basePath, runId)
  }

  getCheckpointPath(runId: string): string {
    return join(this.getRunPath(runId), "checkpoint.json")
  }

  getResultsDir(runId: string): string {
    return join(this.getRunPath(runId), "results")
  }

  exists(runId: string): boolean {
    return existsSync(this.getCheckpointPath(runId))
  }

  load(runId: string): RunCheckpoint | null {
    const path = this.getCheckpointPath(runId)
    if (!existsSync(path)) return null

    try {
      const data = readFileSync(path, "utf8")
      return JSON.parse(data) as RunCheckpoint
    } catch (e) {
      logger.warn(`Failed to load checkpoint: ${e}`)
      return null
    }
  }

  save(checkpoint: RunCheckpoint): void {
    const runId = checkpoint.runId

    // Serialise here rather than at write time. The checkpoint object is mutated
    // concurrently by in-flight tasks (updatePhase does Object.assign), so a queued
    // save would otherwise persist whatever state existed when the write finally
    // ran instead of the state that was current when save() was called.
    checkpoint.updatedAt = new Date().toISOString()
    const serialized = JSON.stringify(checkpoint, null, 2)

    const currentQueue = this.saveLock.get(runId) || Promise.resolve()

    // The stored promise always ends in a .catch, so it never rejects: a failed
    // write can neither become an unhandled rejection nor stop the saves queued
    // behind it from running.
    const nextQueue = currentQueue
      .then(() => this._performSave(runId, serialized))
      .catch((e: unknown) => {
        const error = e instanceof Error ? e : new Error(String(e))
        this.saveErrors.set(runId, error)
        logger.error(`Checkpoint save failed for ${runId}: ${error.message}`)
      })

    this.saveLock.set(runId, nextQueue)

    void nextQueue.finally(() => {
      if (this.saveLock.get(runId) === nextQueue) {
        this.saveLock.delete(runId)
      }
    })
  }

  private async _performSave(runId: string, serialized: string): Promise<void> {
    const runPath = this.getRunPath(runId)
    const path = this.getCheckpointPath(runId)
    const tempPath = path + ".tmp"

    if (!existsSync(runPath)) {
      mkdirSync(runPath, { recursive: true })
    }

    let lastError: any

    // Windows often locks files briefly (EPERM/EBUSY), so we retry a few times
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        writeFileSync(tempPath, serialized)
        renameSync(tempPath, path)
        return // Success
      } catch (e: any) {
        lastError = e
        if (e.code !== "EPERM" && e.code !== "EBUSY") {
          break // Don't retry other errors
        }
        // Wait with exponential backoff: 50, 100, 200, 400, 800ms
        await new Promise((resolve) => setTimeout(resolve, 50 * Math.pow(2, attempt)))
      }
    }

    // If we get here, all retries failed or it was a non-retriable error
    try {
      unlinkSync(tempPath)
    } catch { }
    throw lastError
  }

  /**
   * Wait for queued saves to settle.
   *
   * Throws if any save failed since the last flush. A failure means the on-disk
   * checkpoint is stale, so the caller must not go on to record the run as
   * durably persisted — but the error now names checkpoint persistence as the
   * cause instead of arriving as an opaque rejection from an unrelated await.
   */
  async flush(runId?: string): Promise<void> {
    if (runId) {
      await this.saveLock.get(runId)
      this.throwIfSaveFailed([runId])
      return
    }

    await Promise.all(Array.from(this.saveLock.values()))
    this.throwIfSaveFailed(Array.from(this.saveErrors.keys()))
  }

  /** True if a save for this run has failed and not yet been reported by flush(). */
  hasSaveError(runId: string): boolean {
    return this.saveErrors.has(runId)
  }

  private throwIfSaveFailed(runIds: string[]): void {
    const failures: string[] = []

    for (const runId of runIds) {
      const error = this.saveErrors.get(runId)
      if (!error) continue
      // Consume it, so a later flush reports new failures rather than this one again.
      this.saveErrors.delete(runId)
      failures.push(`${runId}: ${error.message}`)
    }

    if (failures.length === 0) return

    throw new Error(
      `Checkpoint could not be persisted (${failures.join("; ")}). ` +
        `The on-disk state for the affected run(s) is stale.`
    )
  }

  create(
    runId: string,
    provider: string,
    benchmark: string,
    judge: string,
    answeringModel: string,
    options?: {
      limit?: number
      sampling?: SamplingConfig
      targetQuestionIds?: string[]
      dataSourceRunId?: string
      status?: RunStatus
      concurrency?: ConcurrencyConfig
    }
  ): RunCheckpoint {
    const checkpoint: RunCheckpoint = {
      runId,
      dataSourceRunId: options?.dataSourceRunId || runId,
      status: options?.status || "initializing",
      provider,
      benchmark,
      judge,
      answeringModel,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      limit: options?.limit,
      sampling: options?.sampling,
      targetQuestionIds: options?.targetQuestionIds,
      concurrency: options?.concurrency,
      questions: {},
    }

    const runPath = this.getRunPath(runId)
    const resultsDir = this.getResultsDir(runId)

    if (!existsSync(runPath)) {
      mkdirSync(runPath, { recursive: true })
    }
    if (!existsSync(resultsDir)) {
      mkdirSync(resultsDir, { recursive: true })
    }

    this.save(checkpoint)
    return checkpoint
  }

  delete(runId: string): void {
    const runPath = this.getRunPath(runId)
    if (existsSync(runPath)) {
      rmSync(runPath, { recursive: true })
      logger.info(`Deleted run: ${runPath}`)
    }
    // The run is gone; a stale write failure for it must not fail a later flush.
    this.saveErrors.delete(runId)
  }

  updateStatus(checkpoint: RunCheckpoint, status: RunStatus): void {
    checkpoint.status = status
    this.save(checkpoint)
  }

  listRuns(): string[] {
    if (!existsSync(this.basePath)) return []
    return readdirSync(this.basePath, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  }

  initQuestion(
    checkpoint: RunCheckpoint,
    questionId: string,
    containerTag: string,
    metadata: {
      question: string
      groundTruth: string
      questionType: string
      questionDate?: string
    }
  ): void {
    if (!checkpoint.questions[questionId]) {
      checkpoint.questions[questionId] = {
        questionId,
        containerTag,
        question: metadata.question,
        groundTruth: metadata.groundTruth,
        questionType: metadata.questionType,
        questionDate: metadata.questionDate,
        phases: {
          ingest: { status: "pending", completedSessions: [] },
          indexing: { status: "pending" },
          search: { status: "pending" },
          answer: { status: "pending" },
          evaluate: { status: "pending" },
        },
      }
    }
  }

  updateSessions(
    checkpoint: RunCheckpoint,
    questionId: string,
    sessions: Array<{ sessionId: string; date?: string; messageCount: number }>
  ): void {
    const q = checkpoint.questions[questionId]
    if (!q) return
    q.sessions = sessions
    this.save(checkpoint)
  }

  updatePhase<P extends keyof QuestionCheckpoint["phases"]>(
    checkpoint: RunCheckpoint,
    questionId: string,
    phase: P,
    updates: Partial<QuestionCheckpoint["phases"][P]>
  ): void {
    const q = checkpoint.questions[questionId]
    if (!q) return

    Object.assign(q.phases[phase], updates)
    this.save(checkpoint)
  }

  getPhaseStatus(
    checkpoint: RunCheckpoint,
    questionId: string,
    phase: keyof QuestionCheckpoint["phases"]
  ): PhaseStatus {
    return checkpoint.questions[questionId]?.phases[phase].status || "pending"
  }

  getSummary(checkpoint: RunCheckpoint): {
    total: number
    ingested: number
    indexed: number
    searched: number
    answered: number
    evaluated: number
    indexingEpisodes?: {
      total: number
      completed: number
      failed: number
    }
  } {
    const questions = Object.values(checkpoint.questions)

    let episodesTotal = 0
    let episodesCompleted = 0
    let episodesFailed = 0

    for (const q of questions) {
      const ingestResult = q.phases.ingest.ingestResult
      const total = (ingestResult?.documentIds?.length || 0) + (ingestResult?.taskIds?.length || 0)
      episodesTotal += total

      const indexing = q.phases.indexing
      episodesCompleted += indexing?.completedIds?.length || 0
      episodesFailed += indexing?.failedIds?.length || 0
    }

    return {
      total: questions.length,
      ingested: questions.filter((q) => q.phases.ingest.status === "completed").length,
      indexed: questions.filter((q) => q.phases.indexing?.status === "completed").length,
      searched: questions.filter((q) => q.phases.search.status === "completed").length,
      answered: questions.filter((q) => q.phases.answer.status === "completed").length,
      evaluated: questions.filter((q) => q.phases.evaluate.status === "completed").length,
      ...(episodesTotal > 0
        ? {
          indexingEpisodes: {
            total: episodesTotal,
            completed: episodesCompleted,
            failed: episodesFailed,
          },
        }
        : {}),
    }
  }

  /**
   * Copy a checkpoint from sourceRunId to newRunId, resetting phases from fromPhase onwards.
   * This allows creating a new run that reuses ingest/indexing data from an existing run.
   */
  copyCheckpoint(
    sourceRunId: string,
    newRunId: string,
    fromPhase: PhaseId,
    overrides?: { judge?: string; answeringModel?: string }
  ): RunCheckpoint {
    const source = this.load(sourceRunId)
    if (!source) {
      throw new Error(`Source checkpoint not found: ${sourceRunId}`)
    }

    // Get the index of the phase to start from
    const fromIndex = PHASE_ORDER.indexOf(fromPhase)
    const phasesToReset = PHASE_ORDER.slice(fromIndex)

    // Map phase IDs to question phase keys (excluding "report" which isn't a question phase)
    const questionPhaseKeys: (keyof QuestionCheckpoint["phases"])[] = [
      "ingest",
      "indexing",
      "search",
      "answer",
      "evaluate",
    ]

    // Deep copy questions and reset phases from fromPhase onwards
    const newQuestions: Record<string, QuestionCheckpoint> = {}
    for (const [qId, q] of Object.entries(source.questions)) {
      const newQ: QuestionCheckpoint = JSON.parse(JSON.stringify(q))

      // Reset phases that are at or after fromPhase
      for (const phaseKey of questionPhaseKeys) {
        if (phasesToReset.includes(phaseKey as PhaseId)) {
          if (phaseKey === "ingest") {
            newQ.phases.ingest = { status: "pending", completedSessions: [] }
          } else if (phaseKey === "indexing") {
            newQ.phases.indexing = { status: "pending" }
          } else if (phaseKey === "search") {
            newQ.phases.search = { status: "pending" }
          } else if (phaseKey === "answer") {
            newQ.phases.answer = { status: "pending" }
          } else if (phaseKey === "evaluate") {
            newQ.phases.evaluate = { status: "pending" }
          }
        }
      }

      newQuestions[qId] = newQ
    }

    // Create new checkpoint - use source's dataSourceRunId (or sourceRunId if source is also a copy)
    const newCheckpoint: RunCheckpoint = {
      runId: newRunId,
      dataSourceRunId: source.dataSourceRunId || sourceRunId, // Keep original data source
      status: "running",
      provider: source.provider,
      benchmark: source.benchmark,
      judge: overrides?.judge || source.judge,
      answeringModel: overrides?.answeringModel || source.answeringModel,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      limit: source.limit,
      sampling: source.sampling,
      targetQuestionIds: source.targetQuestionIds,
      concurrency: source.concurrency,
      questions: newQuestions,
    }

    // Create directories
    const newRunPath = this.getRunPath(newRunId)
    const newResultsDir = this.getResultsDir(newRunId)
    if (!existsSync(newRunPath)) {
      mkdirSync(newRunPath, { recursive: true })
    }
    if (!existsSync(newResultsDir)) {
      mkdirSync(newResultsDir, { recursive: true })
    }

    // Copy results directory if we're keeping search results (fromPhase is after search)
    const sourceResultsDir = this.getResultsDir(sourceRunId)
    if (existsSync(sourceResultsDir) && fromIndex > PHASE_ORDER.indexOf("search")) {
      // Copy search results files
      try {
        cpSync(sourceResultsDir, newResultsDir, { recursive: true })
        logger.info(`Copied results from ${sourceRunId} to ${newRunId}`)
      } catch (e) {
        logger.warn(`Failed to copy results: ${e}`)
      }
    }

    this.save(newCheckpoint)
    logger.info(
      `Created new checkpoint ${newRunId} from ${sourceRunId}, starting from ${fromPhase}`
    )

    return newCheckpoint
  }
}

export const checkpointManager = new CheckpointManager()
