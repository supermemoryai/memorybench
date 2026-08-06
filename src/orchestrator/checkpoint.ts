import {
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import type { BenchmarkScope, DatasetIdentity } from "../types/benchmark"
import type { ConcurrencyConfig } from "../types/concurrency"
import {
  CHECKPOINT_SCHEMA_VERSION,
  PHASE_ORDER,
  type BuildCheckpoint,
  type PhaseId,
  type PhaseStatus,
  type QuestionCheckpoint,
  type RunCheckpoint,
  type RunStatus,
  type SamplingConfig,
} from "../types/checkpoint"
import type { ProtocolIdentity } from "../types/protocol"
import { logger } from "../utils/logger"
import { resolveAnsweringRuntimeIdentity } from "../utils/models"
import { sha256Text } from "../utils/stable"
import { assertBuildCheckpointConsistency, assertCheckpointReferences } from "./builds"

const RUNS_DIR = "./data/runs"
const INGEST_PROGRESS_JOURNAL_SCHEMA_VERSION = 3

interface IngestProgressJournalDeferredFailure {
  customId: string
  stage: "submission" | "readiness"
  attempts: number
  firstFailedAt: string
  lastFailedAt: string
  lastError: string
}

interface IngestProgressJournalPayload {
  schemaVersion: 2 | typeof INGEST_PROGRESS_JOURNAL_SCHEMA_VERSION
  buildId: string
  buildFingerprint: string
  sequence: number
  sessionId: string
  documentIds: string[]
  taskIds: string[]
  /** True only after the provider confirmed every physical ID is query-ready. */
  readyForNextSession: boolean
  /** Present when the ordered step advanced into the durable end-of-build retry queue. */
  deferredFailure?: IngestProgressJournalDeferredFailure
}

interface IngestProgressJournalRecord extends IngestProgressJournalPayload {
  checksum: string
}

function createIngestProgressJournalRecord(
  payload: IngestProgressJournalPayload
): IngestProgressJournalRecord {
  return { ...payload, checksum: sha256Text(JSON.stringify(payload)) }
}

function assertStringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`Ingest progress journal has invalid ${field}`)
  }
}

function parseIngestProgressJournalRecord(
  line: string,
  journalPath: string,
  lineNumber: number
): IngestProgressJournalRecord {
  let candidate: unknown
  try {
    candidate = JSON.parse(line)
  } catch (error) {
    throw new Error(
      `Ingest progress journal ${journalPath} line ${lineNumber} is malformed: ${String(error)}`
    )
  }
  if (!candidate || typeof candidate !== "object") {
    throw new Error(`Ingest progress journal ${journalPath} line ${lineNumber} is not an object`)
  }
  const record = candidate as Partial<IngestProgressJournalRecord>
  if (
    (record.schemaVersion !== 2 &&
      record.schemaVersion !== INGEST_PROGRESS_JOURNAL_SCHEMA_VERSION) ||
    typeof record.buildId !== "string" ||
    !record.buildId ||
    typeof record.buildFingerprint !== "string" ||
    !record.buildFingerprint ||
    typeof record.sequence !== "number" ||
    !Number.isInteger(record.sequence) ||
    (record.sequence ?? -1) < 0 ||
    typeof record.sessionId !== "string" ||
    !record.sessionId ||
    typeof record.readyForNextSession !== "boolean" ||
    typeof record.checksum !== "string"
  ) {
    throw new Error(`Ingest progress journal ${journalPath} line ${lineNumber} is invalid`)
  }
  assertStringArray(record.documentIds, "documentIds")
  assertStringArray(record.taskIds, "taskIds")
  let deferredFailure: IngestProgressJournalDeferredFailure | undefined
  if (record.schemaVersion === INGEST_PROGRESS_JOURNAL_SCHEMA_VERSION) {
    const candidateFailure = record.deferredFailure as
      | Partial<IngestProgressJournalDeferredFailure>
      | undefined
    if (candidateFailure !== undefined) {
      if (
        !candidateFailure ||
        typeof candidateFailure.customId !== "string" ||
        !candidateFailure.customId ||
        (candidateFailure.stage !== "submission" && candidateFailure.stage !== "readiness") ||
        !Number.isInteger(candidateFailure.attempts) ||
        (candidateFailure.attempts ?? 0) < 1 ||
        typeof candidateFailure.firstFailedAt !== "string" ||
        !candidateFailure.firstFailedAt ||
        typeof candidateFailure.lastFailedAt !== "string" ||
        !candidateFailure.lastFailedAt ||
        typeof candidateFailure.lastError !== "string" ||
        !candidateFailure.lastError
      ) {
        throw new Error(
          `Ingest progress journal ${journalPath} line ${lineNumber} has invalid deferred failure`
        )
      }
      deferredFailure = candidateFailure as IngestProgressJournalDeferredFailure
    }
  }
  const payload: IngestProgressJournalPayload = {
    schemaVersion: record.schemaVersion,
    buildId: record.buildId,
    buildFingerprint: record.buildFingerprint,
    sequence: record.sequence,
    sessionId: record.sessionId,
    documentIds: record.documentIds,
    taskIds: record.taskIds,
    readyForNextSession: record.readyForNextSession,
    ...(deferredFailure ? { deferredFailure } : {}),
  }
  const expectedChecksum = sha256Text(JSON.stringify(payload))
  if (record.checksum !== expectedChecksum) {
    throw new Error(
      `Ingest progress journal ${journalPath} line ${lineNumber} checksum does not match`
    )
  }
  return { ...payload, checksum: record.checksum }
}

export class CheckpointManager {
  private basePath: string
  private saveLock = new Map<string, Promise<void>>()

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

  getIngestProgressJournalPath(runId: string, buildId: string): string {
    return join(this.getRunPath(runId), "progress", "ingest", `${sha256Text(buildId)}.jsonl`)
  }

  getQuestionResultsPath(runId: string, questionId: string): string {
    // Canonical BEAM IDs contain colons, which are invalid in Windows file
    // names. Keep the original ID inside the artifact and use a portable,
    // collision-resistant filename on disk.
    return join(this.getResultsDir(runId), `${sha256Text(questionId)}.json`)
  }

  exists(runId: string): boolean {
    return existsSync(this.getCheckpointPath(runId))
  }

  load(runId: string): RunCheckpoint | null {
    const path = this.getCheckpointPath(runId)
    if (!existsSync(path)) return null

    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"))
    } catch (error) {
      throw new Error(`Checkpoint ${runId} is unreadable: ${String(error)}`)
    }

    const schemaVersion = (parsed as { schemaVersion?: unknown })?.schemaVersion
    if (schemaVersion !== CHECKPOINT_SCHEMA_VERSION) {
      throw new Error(
        `Checkpoint ${runId} uses unsupported schema ${String(schemaVersion ?? "legacy")}; PR #44 shared-build runs require a new schema-${CHECKPOINT_SCHEMA_VERSION} run`
      )
    }

    const checkpoint = parsed as Partial<RunCheckpoint>
    this.replayIngestProgressJournals(checkpoint as RunCheckpoint)
    const missingIdentityFields = [
      typeof checkpoint.benchmarkInputFingerprint === "string" &&
      checkpoint.benchmarkInputFingerprint.trim()
        ? null
        : "benchmarkInputFingerprint",
      checkpoint.answeringRuntimeIdentity && typeof checkpoint.answeringRuntimeIdentity === "object"
        ? null
        : "answeringRuntimeIdentity",
      Number.isInteger(checkpoint.retrievalTopK) && (checkpoint.retrievalTopK ?? 0) > 0
        ? null
        : "retrievalTopK",
      typeof checkpoint.protocolIdentity?.ingestionPolicyHash === "string" &&
      checkpoint.protocolIdentity.ingestionPolicyHash.trim()
        ? null
        : "protocolIdentity.ingestionPolicyHash",
    ].filter((value): value is string => value !== null)
    if (missingIdentityFields.length > 0) {
      throw new Error(
        `Checkpoint ${runId} has incomplete schema-${CHECKPOINT_SCHEMA_VERSION} identity: ${missingIdentityFields.join(", ")}`
      )
    }

    return checkpoint as RunCheckpoint
  }

  save(checkpoint: RunCheckpoint): void {
    const currentQueue = this.saveLock.get(checkpoint.runId) || Promise.resolve()
    // A later full-checkpoint save can safely recover from an earlier failed
    // write because it contains the complete current state. Keep the rejected
    // tail registered until flush() observes it, and suppress only the runtime's
    // unhandled-rejection warning—not the error returned to flush().
    const nextQueue = currentQueue.catch(() => undefined).then(() => this.performSave(checkpoint))
    this.saveLock.set(checkpoint.runId, nextQueue)
    void nextQueue.catch(() => undefined)
  }

  private async performSave(checkpoint: RunCheckpoint): Promise<void> {
    const runPath = this.getRunPath(checkpoint.runId)
    const path = this.getCheckpointPath(checkpoint.runId)
    const tempPath = `${path}.tmp`
    mkdirSync(runPath, { recursive: true })
    checkpoint.updatedAt = new Date().toISOString()

    let lastError: unknown
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        writeFileSync(tempPath, JSON.stringify(checkpoint, null, 2))
        renameSync(tempPath, path)
        return
      } catch (error) {
        lastError = error
        const code = (error as NodeJS.ErrnoException).code
        if (code !== "EPERM" && code !== "EBUSY") break
        await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt))
      }
    }

    try {
      unlinkSync(tempPath)
    } catch {
      // Best-effort cleanup only.
    }
    throw lastError
  }

  async flush(runId?: string): Promise<void> {
    if (runId) {
      while (true) {
        const pending = this.saveLock.get(runId)
        if (!pending) return
        try {
          await pending
        } catch (error) {
          // If another save was queued after this failure, it is a full-state
          // retry. Await that newer tail before deciding persistence failed.
          if (this.saveLock.get(runId) !== pending) continue
          this.saveLock.delete(runId)
          throw error
        }
        if (this.saveLock.get(runId) === pending) {
          this.saveLock.delete(runId)
          return
        }
      }
    }

    while (this.saveLock.size > 0) {
      const runIds = [...this.saveLock.keys()]
      await Promise.all(runIds.map((pendingRunId) => this.flush(pendingRunId)))
    }
  }

  create(
    runId: string,
    provider: string,
    benchmark: string,
    judge: string,
    answeringModel: string,
    options: {
      providerAdapterVersion: string
      providerPromptFingerprint: string
      benchmarkScope: BenchmarkScope
      protocolIdentity: ProtocolIdentity
      selectedQuestionIdsDigest: string
      datasetIdentity?: DatasetIdentity
      benchmarkInputFingerprint: string
      dataPath?: string
      datasetRevision?: string
      retrievalTopK: number
      evaluationProfile?: string
      answerCutoff?: number
      limit?: number
      sampling?: SamplingConfig
      targetQuestionIds?: string[]
      dataSourceRunId?: string
      status?: RunStatus
      concurrency?: ConcurrencyConfig
      ingestBatchSize?: number
      ingestReadinessTimeoutMs?: number
    }
  ): RunCheckpoint {
    const now = new Date().toISOString()
    const checkpoint: RunCheckpoint = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      runId,
      dataSourceRunId: options.dataSourceRunId || runId,
      status: options.status || "initializing",
      provider,
      providerAdapterVersion: options.providerAdapterVersion,
      providerPromptFingerprint: options.providerPromptFingerprint,
      benchmark,
      benchmarkScope: options.benchmarkScope,
      datasetIdentity: options.datasetIdentity,
      benchmarkInputFingerprint: options.benchmarkInputFingerprint,
      selectedQuestionIdsDigest: options.selectedQuestionIdsDigest,
      protocolIdentity: options.protocolIdentity,
      judge,
      answeringModel,
      answeringRuntimeIdentity: resolveAnsweringRuntimeIdentity(answeringModel),
      createdAt: now,
      updatedAt: now,
      dataPath: options.dataPath,
      datasetRevision: options.datasetRevision,
      retrievalTopK: options.retrievalTopK,
      evaluationProfile: options.evaluationProfile,
      answerCutoff: options.answerCutoff,
      limit: options.limit,
      sampling: options.sampling,
      targetQuestionIds: options.targetQuestionIds,
      concurrency: options.concurrency,
      ingestBatchSize: options.ingestBatchSize,
      ingestReadinessTimeoutMs: options.ingestReadinessTimeoutMs,
      buildPhaseAttempts: [],
      builds: {},
      questions: {},
    }

    mkdirSync(this.getResultsDir(runId), { recursive: true })
    this.save(checkpoint)
    return checkpoint
  }

  delete(runId: string): void {
    const runPath = this.getRunPath(runId)
    if (existsSync(runPath)) {
      rmSync(runPath, { recursive: true })
      logger.info(`Deleted run: ${runPath}`)
    }
  }

  updateStatus(checkpoint: RunCheckpoint, status: RunStatus): void {
    checkpoint.status = status
    this.save(checkpoint)
  }

  listRuns(): string[] {
    if (!existsSync(this.basePath)) return []
    return readdirSync(this.basePath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  }

  initBuild(checkpoint: RunCheckpoint, build: BuildCheckpoint): void {
    if (!checkpoint.builds[build.buildId]) checkpoint.builds[build.buildId] = build
  }

  initQuestion(
    checkpoint: RunCheckpoint,
    questionId: string,
    buildId: string,
    metadata: {
      question: string
      groundTruth: string
      questionType: string
      questionDate?: string
    }
  ): void {
    if (checkpoint.questions[questionId]) return
    checkpoint.questions[questionId] = {
      questionId,
      buildId,
      question: metadata.question,
      groundTruth: metadata.groundTruth,
      questionType: metadata.questionType,
      questionDate: metadata.questionDate,
      phases: {
        search: { status: "pending" },
        answer: { status: "pending" },
        evaluate: { status: "pending" },
      },
    }
  }

  updateBuild(
    checkpoint: RunCheckpoint,
    buildId: string,
    update: (build: BuildCheckpoint) => void
  ): void {
    const build = checkpoint.builds[buildId]
    if (!build) throw new Error(`Unknown build ${buildId}`)
    update(build)
    this.save(checkpoint)
  }

  /**
   * Persist one attempted document step without rewriting the full run checkpoint.
   * A causal step advances after readiness or after its failure has been durably
   * placed in the end-of-build retry queue.
   * The append-only record is fsynced before in-memory progress advances, so load()
   * can replay the ordered prefix after a process crash.
   */
  recordIngestProgress(
    checkpoint: RunCheckpoint,
    buildId: string,
    input: {
      sequence: number
      sessionId: string
      documentIds: string[]
      taskIds?: string[]
      readyForNextSession: boolean
      deferredFailure?: {
        customId: string
        stage: "submission" | "readiness"
        attempts?: number
        firstFailedAt?: string
        lastFailedAt?: string
        error: string
      }
    }
  ): void {
    const build = checkpoint.builds[buildId]
    if (!build) throw new Error(`Unknown build ${buildId}`)
    const expectedSequence = build.ingest.completedSessionIds.length
    const expectedSessionId = build.haystack.orderedSessionIds[expectedSequence]
    if (input.sequence !== expectedSequence || input.sessionId !== expectedSessionId) {
      throw new Error(
        `Build ${buildId} ingest progress is out of order at ${input.sequence}: ${input.sessionId} != ${expectedSessionId ?? "<end>"}`
      )
    }
    assertStringArray(input.documentIds, "documentIds")
    const taskIds = input.taskIds ?? []
    assertStringArray(taskIds, "taskIds")
    const requiresSessionBarrier =
      build.ingestionExecutionPolicy.readinessBarrier === "after-each-document"
    if (
      input.deferredFailure
        ? input.readyForNextSession
        : input.readyForNextSession !== requiresSessionBarrier
    ) {
      throw new Error(
        `Build ${buildId} progress readiness does not match its ingestion execution policy`
      )
    }
    if (
      input.deferredFailure &&
      (!input.deferredFailure.customId?.trim() ||
        !input.deferredFailure.error?.trim() ||
        (input.deferredFailure.attempts !== undefined &&
          (!Number.isInteger(input.deferredFailure.attempts) ||
            input.deferredFailure.attempts < 1)))
    ) {
      throw new Error(`Build ${buildId} has invalid deferred ingest progress`)
    }
    const failedAt = input.deferredFailure?.lastFailedAt ?? new Date().toISOString()
    const record = createIngestProgressJournalRecord({
      schemaVersion: INGEST_PROGRESS_JOURNAL_SCHEMA_VERSION,
      buildId,
      buildFingerprint: build.buildFingerprint,
      sequence: input.sequence,
      sessionId: input.sessionId,
      documentIds: [...input.documentIds],
      taskIds: [...taskIds],
      readyForNextSession: input.readyForNextSession,
      ...(input.deferredFailure
        ? {
            deferredFailure: {
              customId: input.deferredFailure.customId,
              stage: input.deferredFailure.stage,
              attempts: input.deferredFailure.attempts ?? 1,
              firstFailedAt: input.deferredFailure.firstFailedAt ?? failedAt,
              lastFailedAt: failedAt,
              lastError: input.deferredFailure.error,
            },
          }
        : {}),
    })
    const journalPath = this.getIngestProgressJournalPath(checkpoint.runId, buildId)
    mkdirSync(join(this.getRunPath(checkpoint.runId), "progress", "ingest"), { recursive: true })
    const fileDescriptor = openSync(journalPath, "a")
    try {
      writeFileSync(fileDescriptor, `${JSON.stringify(record)}\n`)
      fsyncSync(fileDescriptor)
    } finally {
      closeSync(fileDescriptor)
    }
    this.applyIngestProgressRecord(checkpoint, record, journalPath)
  }

  clearIngestProgressJournal(runId: string, buildId: string): void {
    const journalPath = this.getIngestProgressJournalPath(runId, buildId)
    if (existsSync(journalPath)) unlinkSync(journalPath)
  }

  private replayIngestProgressJournals(checkpoint: RunCheckpoint): void {
    if (!checkpoint?.runId || !checkpoint.builds || typeof checkpoint.builds !== "object") return
    for (const build of Object.values(checkpoint.builds)) {
      if (!build?.buildId) continue
      const journalPath = this.getIngestProgressJournalPath(checkpoint.runId, build.buildId)
      if (!existsSync(journalPath)) continue
      let contents = readFileSync(journalPath, "utf8")
      if (contents && !contents.endsWith("\n")) {
        const lastCommittedOffset = contents.lastIndexOf("\n") + 1
        logger.warn(
          `Discarding an incomplete trailing ingest-progress record for build ${build.buildId}`
        )
        truncateSync(journalPath, lastCommittedOffset)
        contents = contents.slice(0, lastCommittedOffset)
      }
      const seen = new Map<number, string>()
      const lines = contents.split("\n")
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]
        if (!line) continue
        const record = parseIngestProgressJournalRecord(line, journalPath, index + 1)
        const previousChecksum = seen.get(record.sequence)
        if (previousChecksum) {
          if (previousChecksum !== record.checksum) {
            throw new Error(
              `Ingest progress journal ${journalPath} has conflicting sequence ${record.sequence}`
            )
          }
          continue
        }
        seen.set(record.sequence, record.checksum)
        this.applyIngestProgressRecord(checkpoint, record, journalPath)
      }
    }
  }

  private applyIngestProgressRecord(
    checkpoint: RunCheckpoint,
    record: IngestProgressJournalRecord,
    journalPath: string
  ): void {
    const build = checkpoint.builds[record.buildId]
    if (!build) throw new Error(`Ingest progress journal ${journalPath} references unknown build`)
    if (record.buildFingerprint !== build.buildFingerprint) {
      throw new Error(`Ingest progress journal ${journalPath} build fingerprint does not match`)
    }
    const requiresSessionBarrier =
      build.ingestionExecutionPolicy.readinessBarrier === "after-each-document"
    if (
      record.deferredFailure
        ? record.readyForNextSession
        : record.readyForNextSession !== requiresSessionBarrier
    ) {
      throw new Error(
        `Ingest progress journal ${journalPath} readiness does not match the build execution policy`
      )
    }
    const expectedSessionId = build.haystack.orderedSessionIds[record.sequence]
    if (expectedSessionId !== record.sessionId) {
      throw new Error(
        `Ingest progress journal ${journalPath} session ${record.sessionId} is not ordered session ${record.sequence}`
      )
    }
    const completedCount = build.ingest.completedSessionIds.length
    if (record.sequence < completedCount) {
      if (build.ingest.completedSessionIds[record.sequence] !== record.sessionId) {
        throw new Error(`Ingest progress journal ${journalPath} conflicts with checkpoint progress`)
      }
      for (const documentId of record.documentIds) {
        if (!build.ingest.documentIds.includes(documentId)) {
          throw new Error(
            `Ingest progress journal ${journalPath} document ID conflicts with compacted checkpoint`
          )
        }
      }
      for (const taskId of record.taskIds) {
        if (!build.ingest.taskIds.includes(taskId)) {
          throw new Error(
            `Ingest progress journal ${journalPath} task ID conflicts with compacted checkpoint`
          )
        }
      }
      if (record.readyForNextSession) {
        for (const indexedId of [...record.documentIds, ...record.taskIds]) {
          if (!build.indexing.completedIds.includes(indexedId)) {
            throw new Error(
              `Ingest progress journal ${journalPath} indexing state conflicts with compacted checkpoint`
            )
          }
        }
      }
      return
    }
    if (record.sequence !== completedCount) {
      throw new Error(
        `Ingest progress journal ${journalPath} has a gap before sequence ${record.sequence}`
      )
    }
    build.ingest.completedSessionIds.push(record.sessionId)
    build.ingest.documentIds = [...new Set([...build.ingest.documentIds, ...record.documentIds])]
    build.ingest.taskIds = [...new Set([...build.ingest.taskIds, ...record.taskIds])]
    if (record.deferredFailure) {
      const deferredSessions = (build.ingest.deferredSessions ??= [])
      if (deferredSessions.some((deferred) => deferred.sequence === record.sequence)) {
        throw new Error(
          `Ingest progress journal ${journalPath} repeats deferred sequence ${record.sequence}`
        )
      }
      deferredSessions.push({
        sequence: record.sequence,
        sessionId: record.sessionId,
        customId: record.deferredFailure.customId,
        documentIds: [...record.documentIds],
        taskIds: [...record.taskIds],
        stage: record.deferredFailure.stage,
        attempts: record.deferredFailure.attempts,
        firstFailedAt: record.deferredFailure.firstFailedAt,
        lastFailedAt: record.deferredFailure.lastFailedAt,
        lastError: record.deferredFailure.lastError,
      })
    }
    if (record.readyForNextSession) {
      build.indexing.completedIds = [
        ...new Set([...build.indexing.completedIds, ...record.documentIds, ...record.taskIds]),
      ]
      build.indexing.failedIds = build.indexing.failedIds.filter(
        (id) => !record.documentIds.includes(id) && !record.taskIds.includes(id)
      )
    }
  }

  updatePhase<P extends keyof QuestionCheckpoint["phases"]>(
    checkpoint: RunCheckpoint,
    questionId: string,
    phase: P,
    updates: Partial<QuestionCheckpoint["phases"][P]>
  ): void {
    const question = checkpoint.questions[questionId]
    if (!question) throw new Error(`Unknown question ${questionId}`)
    Object.assign(question.phases[phase], updates)
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
    builds: number
    ingested: number
    indexed: number
    searched: number
    answered: number
    evaluated: number
    indexingEpisodes?: { total: number; completed: number; failed: number }
  } {
    const questions = Object.values(checkpoint.questions)
    const builds = Object.values(checkpoint.builds)
    const episodeTotal = builds.reduce(
      (sum, build) => sum + new Set([...build.ingest.documentIds, ...build.ingest.taskIds]).size,
      0
    )

    return {
      total: questions.length,
      builds: builds.length,
      ingested: builds.filter((build) => build.ingest.status === "completed").length,
      indexed: builds.filter((build) => build.indexing.status === "completed").length,
      searched: questions.filter((question) => question.phases.search.status === "completed")
        .length,
      answered: questions.filter((question) => question.phases.answer.status === "completed")
        .length,
      evaluated: questions.filter((question) => question.phases.evaluate.status === "completed")
        .length,
      ...(episodeTotal > 0
        ? {
            indexingEpisodes: {
              total: episodeTotal,
              completed: builds.reduce(
                (sum, build) => sum + new Set(build.indexing.completedIds).size,
                0
              ),
              failed: builds.reduce(
                (sum, build) => sum + new Set(build.indexing.failedIds).size,
                0
              ),
            },
          }
        : {}),
    }
  }

  copyCheckpoint(
    sourceRunId: string,
    newRunId: string,
    fromPhase: PhaseId,
    overrides?: { judge?: string; answeringModel?: string }
  ): RunCheckpoint {
    const source = this.load(sourceRunId)
    if (!source) throw new Error(`Source checkpoint not found: ${sourceRunId}`)
    assertCopyPhaseOverrides(source, fromPhase, overrides)
    if (fromPhase === "ingest") {
      throw new Error("Copying from ingest requires a new validated build; start a new run instead")
    }
    assertCheckpointReferences(source)
    const fromIndex = PHASE_ORDER.indexOf(fromPhase)
    for (const build of Object.values(source.builds)) {
      assertBuildCheckpointConsistency(build)
      if (build.ingest.status !== "completed") {
        throw new Error(
          `Cannot copy ${sourceRunId} from ${fromPhase}; build ${build.buildId} has incomplete ingestion`
        )
      }
      if (fromIndex > PHASE_ORDER.indexOf("indexing") && build.indexing.status !== "completed") {
        throw new Error(
          `Cannot copy ${sourceRunId} from ${fromPhase}; build ${build.buildId} is not fully indexed`
        )
      }
    }

    const copy = structuredClone(source)
    copy.runId = newRunId
    copy.status = "running"
    copy.judge = overrides?.judge || source.judge
    const rerunsAnswer = fromIndex <= PHASE_ORDER.indexOf("answer")
    if (rerunsAnswer) {
      copy.answeringModel = overrides?.answeringModel || source.answeringModel
      copy.answeringRuntimeIdentity = resolveAnsweringRuntimeIdentity(copy.answeringModel)
    } else {
      // The answer artifact is being reused, so retain the exact runtime identity
      // that produced it. Re-resolving the alias here could silently relabel old
      // output after a model alias/default changes.
      if (!source.answeringRuntimeIdentity) {
        throw new Error(
          `Cannot copy ${sourceRunId} from ${fromPhase}; source answer runtime identity is missing`
        )
      }
      copy.answeringModel = source.answeringModel
      copy.answeringRuntimeIdentity = structuredClone(source.answeringRuntimeIdentity)
    }
    copy.createdAt = new Date().toISOString()
    copy.updatedAt = copy.createdAt
    copy.buildPhaseAttempts = []

    for (const build of Object.values(copy.builds)) {
      // Keep the immediate reuse provenance. dataSourceRunId separately retains
      // the original container namespace across a chain of copied runs.
      build.sourceRunId = sourceRunId
      if (fromPhase === "indexing") {
        build.reused = false
        build.reusedPhases = { ingest: true, indexing: false }
        build.indexing = {
          status: "pending",
          completedIds: [],
          failedIds: [],
          attempts: [],
        }
      } else {
        build.reused = true
        build.reusedPhases = { ingest: true, indexing: true }
      }
    }

    for (const question of Object.values(copy.questions)) {
      if (fromIndex <= PHASE_ORDER.indexOf("search")) question.phases.search = { status: "pending" }
      if (fromIndex <= PHASE_ORDER.indexOf("answer")) question.phases.answer = { status: "pending" }
      if (fromIndex <= PHASE_ORDER.indexOf("evaluate")) {
        question.phases.evaluate = { status: "pending" }
      }
    }

    mkdirSync(this.getResultsDir(newRunId), { recursive: true })
    const sourceResults = this.getResultsDir(sourceRunId)
    if (fromIndex > PHASE_ORDER.indexOf("search")) {
      const reusedSearches = Object.values(copy.questions).filter(
        (question) => question.phases.search.status === "completed"
      )
      for (const question of reusedSearches) {
        const sourceResultPath = this.getQuestionResultsPath(sourceRunId, question.questionId)
        if (!existsSync(sourceResultPath)) {
          throw new Error(
            `Cannot copy ${sourceRunId} from ${fromPhase}; search artifact is missing for ${question.questionId}`
          )
        }
      }
      if (reusedSearches.length > 0) {
        cpSync(sourceResults, this.getResultsDir(newRunId), { recursive: true })
      }
      for (const question of reusedSearches) {
        const copiedResultPath = this.getQuestionResultsPath(newRunId, question.questionId)
        if (!existsSync(copiedResultPath)) {
          throw new Error(
            `Cannot copy ${sourceRunId} from ${fromPhase}; copied search artifact is missing for ${question.questionId}`
          )
        }
        question.phases.search.resultFile = copiedResultPath
      }
    }
    this.save(copy)
    return copy
  }
}

export function assertCopyPhaseOverrides(
  source: Pick<RunCheckpoint, "runId" | "judge" | "answeringModel">,
  fromPhase: PhaseId,
  overrides?: { judge?: string; answeringModel?: string }
): void {
  const fromIndex = PHASE_ORDER.indexOf(fromPhase)
  if (fromIndex < 0) throw new Error(`Invalid copy phase: ${String(fromPhase)}`)

  if (
    overrides?.answeringModel &&
    overrides.answeringModel !== source.answeringModel &&
    fromIndex > PHASE_ORDER.indexOf("answer")
  ) {
    throw new Error(
      `Cannot change answering model when copying ${source.runId} from ${fromPhase}; rerun answer or an earlier phase`
    )
  }
  if (
    overrides?.judge &&
    overrides.judge !== source.judge &&
    fromIndex > PHASE_ORDER.indexOf("evaluate")
  ) {
    throw new Error(
      `Cannot change judge when copying ${source.runId} from ${fromPhase}; rerun evaluate or an earlier phase`
    )
  }
}

export const checkpointManager = new CheckpointManager()
