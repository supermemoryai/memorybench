import type { AdvancedSupermemoryApi, SupermemoryMetadata, V3DocumentInput } from "./client"
import {
  SupermemoryContractError,
  SupermemoryHttpError,
  SupermemoryRetryExhaustedError,
  isRecord,
} from "./client"

const RECONCILIATION_BATCH_SIZE = 100
const DEFAULT_CLEANUP_TIMEOUT_MS = 5 * 60_000
const DEFAULT_CLEANUP_INITIAL_POLL_MS = 1_000
const DEFAULT_CLEANUP_MAX_POLL_MS = 5_000

export interface SupermemoryBuildIdentity {
  buildId: string
  containerTag: string
  runFingerprint: string
}

export interface SupermemoryBuildDocument {
  customId: string
  content: string
  metadata: SupermemoryMetadata
  filterByMetadata?: SupermemoryMetadata
}

export interface SupermemoryTrajectoryBatch {
  trajectoryId: string
  identity: SupermemoryBuildIdentity
  documents: SupermemoryBuildDocument[]
}

export type RemoteDocumentStatus = "absent" | "accepted" | "indexing" | "ready" | "failed"

export interface ReconciledDocument {
  customId: string
  remoteId?: string
  status: RemoteDocumentStatus
  remoteStatus?: string
  metadata?: Record<string, unknown>
  memoryCount?: number
  raw?: Record<string, unknown>
}

export interface TrajectoryBatchSubmission {
  trajectoryId: string
  documents: ReconciledDocument[]
  reconciled: boolean
  rawResponse?: Record<string, unknown>
}

export interface ReadinessProgress {
  ready: ReconciledDocument[]
  pending: ReconciledDocument[]
  failed: ReconciledDocument[]
}

export class SupermemoryBatchSubmissionError extends Error {
  readonly states: ReconciledDocument[]

  constructor(message: string, states: ReconciledDocument[], cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = "SupermemoryBatchSubmissionError"
    this.states = states
  }
}

export class SupermemoryReadinessTimeoutError extends Error {
  readonly states: ReconciledDocument[]

  constructor(message: string, states: ReconciledDocument[]) {
    super(message)
    this.name = "SupermemoryReadinessTimeoutError"
    this.states = states
  }
}

export class SupermemoryRemoteDocumentFailedError extends Error {
  readonly documents: ReconciledDocument[]

  constructor(documents: ReconciledDocument[]) {
    super(
      `${documents.length} Supermemory document${documents.length === 1 ? "" : "s"} failed: ${documents
        .slice(0, 3)
        .map((document) => document.customId)
        .join(", ")}`
    )
    this.name = "SupermemoryRemoteDocumentFailedError"
    this.documents = documents
  }
}

export class UnsafeSupermemoryCleanupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UnsafeSupermemoryCleanupError"
  }
}

export class SupermemoryCleanupTimeoutError extends Error {
  readonly states: ReconciledDocument[]

  constructor(message: string, states: ReconciledDocument[]) {
    super(message)
    this.name = "SupermemoryCleanupTimeoutError"
    this.states = states
  }
}

export interface AdvancedSupermemoryBuildOptions {
  sleep?: (milliseconds: number) => Promise<void>
  clock?: () => number
  cleanupTimeoutMs?: number
  cleanupInitialPollMs?: number
  cleanupMaxPollMs?: number
  signal?: AbortSignal
}

export class AdvancedSupermemoryBuild {
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly clock: () => number
  private readonly cleanupTimeoutMs: number
  private readonly cleanupInitialPollMs: number
  private readonly cleanupMaxPollMs: number
  private readonly signal?: AbortSignal

  constructor(
    private readonly client: AdvancedSupermemoryApi,
    options: AdvancedSupermemoryBuildOptions = {}
  ) {
    this.sleep = options.sleep ?? ((milliseconds) => Bun.sleep(milliseconds))
    this.clock = options.clock ?? Date.now
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS
    this.cleanupInitialPollMs = options.cleanupInitialPollMs ?? DEFAULT_CLEANUP_INITIAL_POLL_MS
    this.cleanupMaxPollMs = options.cleanupMaxPollMs ?? DEFAULT_CLEANUP_MAX_POLL_MS
    this.signal = options.signal
    if (
      this.cleanupTimeoutMs < 1 ||
      this.cleanupInitialPollMs < 0 ||
      this.cleanupMaxPollMs < this.cleanupInitialPollMs
    ) {
      throw new Error("Invalid cleanup timeout or polling configuration")
    }
  }

  async submitTrajectoryBatch(
    input: SupermemoryTrajectoryBatch
  ): Promise<TrajectoryBatchSubmission> {
    validateIdentity(input.identity)
    if (!input.trajectoryId.trim()) throw new Error("trajectoryId must not be empty")
    if (input.documents.length < 1 || input.documents.length > 600) {
      throw new Error("A trajectory batch must contain between 1 and 600 documents")
    }
    const customIds = input.documents.map((document) => document.customId)
    if (new Set(customIds).size !== customIds.length) {
      throw new Error(`Trajectory ${input.trajectoryId} has duplicate custom IDs`)
    }

    const documents: V3DocumentInput[] = input.documents.map((document) => ({
      content: document.content,
      customId: document.customId,
      metadata: withBuildMetadata(document.metadata, input.identity, input.trajectoryId),
      ...(document.filterByMetadata
        ? { filterByMetadata: validateFilter(document.filterByMetadata, input.identity) }
        : {}),
    }))

    let rawResponse: Record<string, unknown>
    try {
      rawResponse = await this.client.addDocumentsBatch({
        documents,
        containerTag: input.identity.containerTag,
        dreaming: "instant",
      })
    } catch (error) {
      if (!isAmbiguousSubmissionError(error)) throw error
      return this.reconcileAmbiguousSubmission(input, error)
    }

    const results = rawResponse.results
    if (!Array.isArray(results) || results.length !== documents.length) {
      return this.reconcileAmbiguousSubmission(
        input,
        new SupermemoryContractError(
          `V3 batch returned ${Array.isArray(results) ? results.length : "no"} results for ${
            documents.length
          } documents`
        )
      )
    }

    const accepted = results.map((result, index): ReconciledDocument => {
      const record = isRecord(result) ? result : {}
      const remoteId = typeof record.id === "string" && record.id ? record.id : undefined
      const remoteStatus = typeof record.status === "string" ? record.status : undefined
      return {
        customId: documents[index].customId,
        remoteId,
        remoteStatus,
        status: classifyRemoteStatus(remoteStatus, remoteId !== undefined),
        raw: record,
      }
    })

    if (accepted.some((document) => !document.remoteId || document.status === "failed")) {
      return this.reconcileAmbiguousSubmission(
        input,
        new SupermemoryContractError("V3 batch contained missing IDs or failed results")
      )
    }

    return {
      trajectoryId: input.trajectoryId,
      documents: accepted,
      reconciled: false,
      rawResponse,
    }
  }

  async reconcileByCustomId(
    customIds: string[],
    containerTag: string,
    signal?: AbortSignal
  ): Promise<ReconciledDocument[]> {
    if (!containerTag.trim()) throw new Error("containerTag must not be empty")
    if (new Set(customIds).size !== customIds.length) {
      throw new Error("Custom IDs for reconciliation must be unique")
    }
    const found = new Map<string, ReconciledDocument>()
    for (let offset = 0; offset < customIds.length; offset += RECONCILIATION_BATCH_SIZE) {
      const batch = customIds.slice(offset, offset + RECONCILIATION_BATCH_SIZE)
      throwIfAborted(signal)
      const remoteDocuments = await this.client.listDocumentsByCustomIds(
        batch,
        containerTag,
        signal
      )
      for (const remote of remoteDocuments) {
        const customId = stringField(remote, "customId")
        if (!customId || !batch.includes(customId)) continue
        if (found.has(customId)) {
          throw new SupermemoryContractError(
            `Reconciliation returned duplicate documents for customId ${customId}`
          )
        }
        const remoteId = stringField(remote, "id")
        const remoteStatus = stringField(remote, "status")
        found.set(customId, {
          customId,
          remoteId,
          remoteStatus,
          status: classifyRemoteStatus(remoteStatus, remoteId !== undefined),
          metadata: extractMetadata(remote),
          memoryCount: extractMemoryCount(remote),
          raw: remote,
        })
      }
    }

    return customIds.map(
      (customId) =>
        found.get(customId) ?? {
          customId,
          status: "absent",
        }
    )
  }

  async awaitReady(input: {
    customIds: string[]
    containerTag: string
    timeoutMs?: number
    initialPollMs?: number
    maxPollMs?: number
    signal?: AbortSignal
    onProgress?: (progress: ReadinessProgress) => void
  }): Promise<ReconciledDocument[]> {
    const timeoutMs = input.timeoutMs ?? 30 * 60_000
    const maxPollMs = input.maxPollMs ?? 5_000
    let pollMs = input.initialPollMs ?? 1_000
    if (timeoutMs < 1 || pollMs < 0 || maxPollMs < pollMs) {
      throw new Error("Invalid readiness timeout or polling configuration")
    }
    const deadline = this.clock() + timeoutMs

    while (true) {
      if (input.signal?.aborted) throw input.signal.reason ?? new Error("Readiness wait aborted")
      const states = await this.reconcileByCustomId(
        input.customIds,
        input.containerTag,
        input.signal
      )
      const progress = {
        ready: states.filter((document) => document.status === "ready"),
        failed: states.filter((document) => document.status === "failed"),
        pending: states.filter(
          (document) => document.status !== "ready" && document.status !== "failed"
        ),
      }
      input.onProgress?.(progress)
      if (progress.failed.length > 0) {
        throw new SupermemoryRemoteDocumentFailedError(progress.failed)
      }
      if (progress.ready.length === states.length) return states
      if (this.clock() >= deadline) {
        throw new SupermemoryReadinessTimeoutError(
          `${progress.pending.length} documents were not ready within ${timeoutMs}ms`,
          states
        )
      }
      await abortableSleep(
        this.sleep,
        Math.min(pollMs, Math.max(0, deadline - this.clock())),
        input.signal
      )
      pollMs = Math.min(maxPollMs, Math.max(1, Math.ceil(pollMs * 1.5)))
    }
  }

  /**
   * Delete only explicitly enumerated documents whose persisted metadata proves
   * they belong to the exact build. Container-wide deletion is intentionally
   * unsupported.
   */
  async cleanupExactBuild(input: {
    identity: SupermemoryBuildIdentity
    customIds: string[]
  }): Promise<{ deleted: string[]; absent: string[] }> {
    validateIdentity(input.identity)
    if (input.customIds.length === 0) {
      throw new UnsafeSupermemoryCleanupError("Exact-build cleanup requires explicit custom IDs")
    }
    throwIfAborted(this.signal)
    const deadline = this.clock() + this.cleanupTimeoutMs
    const states = await this.reconcileByCustomId(
      input.customIds,
      input.identity.containerTag,
      this.signal
    )
    const deletable: ReconciledDocument[] = []
    const absent: string[] = []

    for (const state of states) {
      if (state.status === "absent") {
        absent.push(state.customId)
        continue
      }
      assertExactBuildOwnership(state, input.identity)
      deletable.push(state)
    }

    for (const state of deletable) {
      await this.deleteWithReconciliation(state, input.identity, deadline)
    }

    const remaining = await this.reconcileByCustomId(
      deletable.map((document) => document.customId),
      input.identity.containerTag,
      this.signal
    )
    const notDeleted = remaining.filter((document) => document.status !== "absent")
    if (notDeleted.length > 0) {
      throw new UnsafeSupermemoryCleanupError(
        `Cleanup verification found ${notDeleted.length} remaining documents`
      )
    }
    return {
      deleted: deletable.map((document) => document.customId),
      absent,
    }
  }

  private async deleteWithReconciliation(
    initialState: ReconciledDocument,
    identity: SupermemoryBuildIdentity,
    deadline: number
  ): Promise<void> {
    let state = initialState
    let pollMs = this.cleanupInitialPollMs

    while (true) {
      throwIfAborted(this.signal)
      assertExactBuildOwnership(state, identity)

      try {
        await this.client.deleteDocument(state.remoteId ?? state.customId, this.signal)
      } catch (error) {
        if (!isDeleteConflict(error)) throw error
      }

      const [reconciled] = await this.reconcileByCustomId(
        [state.customId],
        identity.containerTag,
        this.signal
      )
      if (reconciled.status === "absent") return
      assertExactBuildOwnership(reconciled, identity)
      state = reconciled

      if (this.clock() >= deadline) {
        throw new SupermemoryCleanupTimeoutError(
          `Supermemory cleanup could not delete ${state.customId} within ${this.cleanupTimeoutMs}ms`,
          [state]
        )
      }
      await abortableSleep(
        this.sleep,
        Math.min(pollMs, Math.max(0, deadline - this.clock())),
        this.signal
      )
      pollMs = Math.min(this.cleanupMaxPollMs, Math.max(1, Math.ceil(Math.max(1, pollMs) * 1.5)))
    }
  }

  private async reconcileAmbiguousSubmission(
    input: SupermemoryTrajectoryBatch,
    cause: unknown
  ): Promise<TrajectoryBatchSubmission> {
    const states = await this.reconcileByCustomId(
      input.documents.map((document) => document.customId),
      input.identity.containerTag
    )
    if (states.every((document) => document.status !== "absent")) {
      return {
        trajectoryId: input.trajectoryId,
        documents: states,
        reconciled: true,
      }
    }
    throw new SupermemoryBatchSubmissionError(
      `Trajectory ${input.trajectoryId} has an ambiguous V3 batch submission; resume must not re-upload ${
        states.filter((document) => document.status === "absent").length
      } absent custom IDs without a durable decision`,
      states,
      cause
    )
  }
}

function withBuildMetadata(
  metadata: SupermemoryMetadata,
  identity: SupermemoryBuildIdentity,
  trajectoryId: string
): SupermemoryMetadata {
  assertCompatibleMetadata(metadata, "runFingerprint", identity.runFingerprint)
  assertCompatibleMetadata(metadata, "buildId", identity.buildId)
  assertCompatibleMetadata(metadata, "trajectoryId", trajectoryId)
  return {
    ...metadata,
    runFingerprint: identity.runFingerprint,
    buildId: identity.buildId,
    trajectoryId,
  }
}

function validateFilter(
  filter: SupermemoryMetadata,
  identity: SupermemoryBuildIdentity
): SupermemoryMetadata {
  if (filter.runFingerprint !== undefined && filter.runFingerprint !== identity.runFingerprint) {
    throw new Error("filterByMetadata cannot reference another run fingerprint")
  }
  return { ...filter }
}

function assertCompatibleMetadata(
  metadata: SupermemoryMetadata,
  field: string,
  expected: string
): void {
  if (metadata[field] !== undefined && metadata[field] !== expected) {
    throw new Error(`Document metadata ${field} conflicts with the build identity`)
  }
}

function validateIdentity(identity: SupermemoryBuildIdentity): void {
  for (const [field, value] of Object.entries(identity)) {
    if (!value.trim()) throw new Error(`${field} must not be empty`)
  }
}

function isAmbiguousSubmissionError(error: unknown): boolean {
  return (
    error instanceof SupermemoryRetryExhaustedError ||
    error instanceof SupermemoryContractError ||
    (error instanceof SupermemoryHttpError && error.statusCode === 409)
  )
}

function isDeleteConflict(error: unknown): boolean {
  const classified = error instanceof SupermemoryRetryExhaustedError ? error.lastError : error
  return classified instanceof SupermemoryHttpError && classified.statusCode === 409
}

function assertExactBuildOwnership(
  state: ReconciledDocument,
  identity: SupermemoryBuildIdentity
): void {
  const metadata = state.metadata ?? {}
  if (
    metadata.runFingerprint !== identity.runFingerprint ||
    metadata.buildId !== identity.buildId
  ) {
    throw new UnsafeSupermemoryCleanupError(
      `Refusing to delete ${state.customId}: remote metadata does not match exact build`
    )
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Supermemory operation aborted")
}

async function abortableSleep(
  sleep: (milliseconds: number) => Promise<void>,
  milliseconds: number,
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal)
  if (!signal) {
    await sleep(milliseconds)
    return
  }
  let onAbort: (() => void) | undefined
  try {
    await Promise.race([
      sleep(milliseconds),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason ?? new Error("Supermemory operation aborted"))
        signal.addEventListener("abort", onAbort, { once: true })
        if (signal.aborted) onAbort()
      }),
    ])
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort)
  }
  throwIfAborted(signal)
}

function classifyRemoteStatus(status: string | undefined, exists: boolean): RemoteDocumentStatus {
  const normalized = status?.toLowerCase()
  if (normalized === "done" || normalized === "completed" || normalized === "ready") return "ready"
  if (normalized === "failed" || normalized === "error" || normalized === "rejected")
    return "failed"
  if (
    normalized === "processing" ||
    normalized === "indexing" ||
    normalized === "pending" ||
    normalized === "queued"
  ) {
    return "indexing"
  }
  return exists ? "accepted" : "absent"
}

function extractMetadata(remote: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(remote.metadata)) return remote.metadata
  if (isRecord(remote.document) && isRecord(remote.document.metadata)) {
    return remote.document.metadata
  }
  return {}
}

function extractMemoryCount(remote: Record<string, unknown>): number | undefined {
  for (const field of ["memoryEntries", "memory_entries", "memories"]) {
    const value = remote[field]
    if (Array.isArray(value)) return value.length
  }
  return undefined
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field]
  return typeof value === "string" && value ? value : undefined
}
