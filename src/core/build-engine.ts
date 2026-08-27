import type { BuildProvider, RemoteDocumentState, RemoteDocumentStatus } from "../types/provider"
import type { MemoryBuildPlan, PhysicalDocument } from "../types/migration"
import { BuildStore, type StoredDocument } from "./build-store"

export interface BuildEngineOptions {
  trajectoryConcurrency: number
  maxTrajectoryAttempts: number
  indexingTimeoutMs: number
  pollIntervalMs: number
  leaseMs: number
  continueOnIndexingTimeout: boolean
  signal?: AbortSignal
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
}

const DEFAULT_OPTIONS: BuildEngineOptions = {
  trajectoryConcurrency: 4,
  maxTrajectoryAttempts: 4,
  indexingTimeoutMs: 30 * 60 * 1000,
  pollIntervalMs: 2000,
  leaseMs: 60_000,
  continueOnIndexingTimeout: false,
}

const SKIPPED_INDEXING_TIMEOUT_PREFIX = "INDEXING_TIMEOUT_SKIPPED:"

class SkippedIndexingTimeoutError extends Error {}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Operation aborted"))
    const timer = setTimeout(resolve, milliseconds)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        reject(signal.reason ?? new Error("Operation aborted"))
      },
      { once: true }
    )
  })
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Operation aborted")
}

export class BuildEngine {
  private readonly options: BuildEngineOptions
  private readonly documentByCustomId: Map<string, PhysicalDocument>

  constructor(
    private readonly plan: MemoryBuildPlan,
    private readonly provider: BuildProvider,
    private readonly store: BuildStore,
    options: Partial<BuildEngineOptions> = {}
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
    this.documentByCustomId = new Map(
      plan.documents.map((document) => [document.customId, document])
    )
    if (
      !Number.isInteger(this.options.trajectoryConcurrency) ||
      this.options.trajectoryConcurrency < 1
    ) {
      throw new Error("trajectoryConcurrency must be a positive integer")
    }
    if (this.options.leaseMs <= this.options.pollIntervalMs * 2) {
      throw new Error("leaseMs must be more than two poll intervals")
    }
  }

  async run(): Promise<"ready" | "degraded"> {
    const existing = this.store.getBuild(this.plan.buildId)
    const created = this.store.registerBuild(this.plan)
    if (!created && existing?.status === "degraded" && this.options.continueOnIndexingTimeout) {
      return "degraded"
    }
    this.store.setBuildStatus(this.plan.buildId, "ingesting")
    if (created) {
      await this.reconcileAmbiguous()
    } else {
      await this.reconcileSavedRemoteState()
      this.store.reopenTrajectoriesWithNonReadyDocuments(this.plan.buildId)
    }
    const workers = Array.from(
      { length: Math.min(this.options.trajectoryConcurrency, this.plan.orderedSourceIds.length) },
      (_, index) => this.worker(`worker-${process.pid}-${index}-${crypto.randomUUID()}`)
    )
    await Promise.all(workers)
    const summary = this.store.buildSummary(this.plan.buildId)
    if (summary.trajectories.failed > 0 || summary.documents.failed > 0) {
      const failedTrajectories = this.store.getFailedTrajectories(this.plan.buildId)
      const boundedFailuresMayDegrade =
        this.options.continueOnIndexingTimeout &&
        failedTrajectories.length === summary.trajectories.failed
      if (boundedFailuresMayDegrade) {
        const skippedDocumentCount = Object.entries(summary.documents).reduce(
          (total, [status, count]) => total + (status === "ready" ? 0 : count),
          0
        )
        const message = `Build degraded after skipping ${skippedDocumentCount} non-ready documents across ${summary.trajectories.failed} trajectories after bounded ingestion failures`
        this.store.setBuildStatus(this.plan.buildId, "degraded", message)
        this.store.recordEvent(this.plan.buildId, "build_degraded", "build", this.plan.buildId, {
          message,
          failedTrajectories,
          summary,
        })
        return "degraded"
      }
      const message = `Build failed: ${summary.trajectories.failed} trajectories and ${summary.documents.failed} documents failed`
      this.store.setBuildStatus(this.plan.buildId, "failed", message)
      throw new Error(message)
    }
    const trajectoryTotal = Object.values(summary.trajectories).reduce(
      (sum, value) => sum + value,
      0
    )
    const documentTotal = Object.values(summary.documents).reduce((sum, value) => sum + value, 0)
    if (
      summary.trajectories.ready !== trajectoryTotal ||
      summary.documents.ready !== documentTotal
    ) {
      const message = "Build stopped before every required document reached ready"
      this.store.setBuildStatus(this.plan.buildId, "failed", message)
      throw new Error(message)
    }
    this.store.setBuildStatus(this.plan.buildId, "ready")
    this.store.recordEvent(this.plan.buildId, "build_ready", "build", this.plan.buildId, summary)
    return "ready"
  }

  async verifyRemoteHealth(options: { allowDegraded?: boolean } = {}): Promise<void> {
    const states = await this.provider.verifyBuildHealth(this.plan)
    const byCustomId = new Map(states.map((state) => [state.customId, state]))
    const expectedReady = options.allowDegraded
      ? new Set(this.store.getDocumentCustomIdsByStatus(this.plan.buildId, "ready"))
      : new Set(this.plan.documents.map((document) => document.customId))
    const unhealthy = this.plan.documents.filter(
      (document) =>
        expectedReady.has(document.customId) &&
        byCustomId.get(document.customId)?.status !== "ready"
    )
    if (unhealthy.length > 0) {
      throw new Error(
        `Remote build health check failed for ${unhealthy.length} documents: ${unhealthy
          .slice(0, 5)
          .map((document) => document.customId)
          .join(", ")}`
      )
    }
    if (options.allowDegraded) {
      const skippedStillVisible = this.store
        .getDocumentCustomIdsByStatus(this.plan.buildId, "failed")
        .filter((customId) => byCustomId.get(customId)?.status !== "absent")
      if (skippedStillVisible.length > 0) {
        throw new Error(
          `Remote degraded-build health check found ${skippedStillVisible.length} skipped documents still visible: ${skippedStillVisible
            .slice(0, 5)
            .join(", ")}`
        )
      }
    }
  }

  private async worker(workerId: string): Promise<void> {
    while (true) {
      throwIfAborted(this.options.signal)
      const trajectoryId = this.store.claimTrajectory(
        this.plan.buildId,
        workerId,
        this.options.leaseMs
      )
      if (!trajectoryId) {
        const summary = this.store.buildSummary(this.plan.buildId)
        const waiting =
          summary.trajectories.planned +
          summary.trajectories.retryable +
          summary.trajectories.processing
        if (waiting === 0) return
        // A different process may still own an unexpired lease. Returning here
        // would make run() misclassify resumable work as a terminal partial
        // build. Wait until that worker finishes or its lease becomes
        // claimable, then try again.
        await (this.options.sleep ?? defaultSleep)(this.options.pollIntervalMs, this.options.signal)
        continue
      }
      let heartbeatError: unknown
      const heartbeat = setInterval(
        () => {
          try {
            this.store.renewTrajectoryLease(
              this.plan.buildId,
              trajectoryId,
              workerId,
              this.options.leaseMs
            )
          } catch (error) {
            heartbeatError ??= error
          }
        },
        Math.max(1, Math.floor(this.options.leaseMs / 3))
      )
      try {
        await this.processTrajectory(trajectoryId, workerId)
        if (heartbeatError) throw heartbeatError
        this.store.markTrajectoryReady(this.plan.buildId, trajectoryId, workerId)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const attempt = this.store.getTrajectoryAttempt(this.plan.buildId, trajectoryId)
        if (
          error instanceof SkippedIndexingTimeoutError ||
          (!this.options.signal?.aborted && attempt >= this.options.maxTrajectoryAttempts)
        ) {
          this.store.markTrajectoryFailed(this.plan.buildId, trajectoryId, workerId, message)
        } else {
          // A user stop is resumable. Persist the claimed trajectory as
          // retryable so the next process can reconcile any accepted documents
          // and continue from the durable checkpoint.
          this.store.markTrajectoryRetryable(this.plan.buildId, trajectoryId, workerId, message)
        }
      } finally {
        clearInterval(heartbeat)
      }
    }
  }

  private async processTrajectory(trajectoryId: string, workerId: string): Promise<void> {
    let stored = this.store.getTrajectoryDocuments(this.plan.buildId, trajectoryId)
    if (
      stored.some((document) => ["submitting", "accepted", "indexing"].includes(document.status))
    ) {
      await this.reconcileDocuments(stored)
      stored = this.store.getTrajectoryDocuments(this.plan.buildId, trajectoryId)
    }
    if (stored.some((document) => document.status === "failed")) {
      const failed = stored.filter((document) => document.status === "failed")
      await this.provider.deleteDocuments(
        this.plan,
        failed.map((document) => document.customId)
      )
      for (const document of failed) this.store.resetDocumentToPlanned(document.customId)
      stored = this.store.getTrajectoryDocuments(this.plan.buildId, trajectoryId)
    }
    const pending = stored.filter((document) => ["planned", "retryable"].includes(document.status))
    if (pending.length > 0) {
      const physicalDocuments = pending.map((document) => {
        const physical = this.documentByCustomId.get(document.customId)
        if (!physical) throw new Error(`Missing physical document ${document.customId}`)
        return physical
      })
      for (const document of pending) this.store.markDocumentSubmitting(document.customId)
      let submitted: RemoteDocumentState[]
      try {
        submitted = await this.provider.submitDocumentBatch({
          build: this.plan,
          trajectoryId,
          documents: physicalDocuments,
        })
      } catch (error) {
        await this.reconcileDocuments(
          this.store.getTrajectoryDocuments(this.plan.buildId, trajectoryId)
        )
        throw error
      }
      await this.applyStates(submitted, new Set(pending.map((document) => document.customId)))
      const returned = new Set(submitted.map((state) => state.customId))
      const missing = pending.filter((document) => !returned.has(document.customId))
      if (missing.length > 0) await this.reconcileDocuments(missing)
    }

    const deadline = Date.now() + this.options.indexingTimeoutMs
    while (true) {
      throwIfAborted(this.options.signal)
      this.store.renewTrajectoryLease(
        this.plan.buildId,
        trajectoryId,
        workerId,
        this.options.leaseMs
      )
      stored = this.store.getTrajectoryDocuments(this.plan.buildId, trajectoryId)
      if (stored.every((document) => document.status === "ready")) return
      if (stored.some((document) => document.status === "failed")) {
        throw new Error(`A remote document failed for trajectory ${trajectoryId}`)
      }
      if (Date.now() >= deadline) {
        if (this.options.continueOnIndexingTimeout) {
          const unresolved = stored.filter((document) => document.status !== "ready")
          const message = `${SKIPPED_INDEXING_TIMEOUT_PREFIX} ${unresolved.length} documents for trajectory ${trajectoryId} did not become ready within ${this.options.indexingTimeoutMs}ms`
          await this.provider.deleteDocuments(
            this.plan,
            unresolved.map((document) => document.customId)
          )
          for (const document of unresolved) {
            this.store.markDocumentFailed(document.customId, message)
          }
          throw new SkippedIndexingTimeoutError(message)
        }
        throw new Error(`Indexing timed out for trajectory ${trajectoryId}`)
      }
      const unresolved = stored.filter((document) => document.status !== "ready")
      await this.reconcileDocuments(unresolved)
      await (this.options.sleep ?? defaultSleep)(this.options.pollIntervalMs, this.options.signal)
    }
  }

  private async reconcileAmbiguous(): Promise<void> {
    const ambiguous = this.store.getAmbiguousDocuments(this.plan.buildId)
    for (let index = 0; index < ambiguous.length; index += 100) {
      await this.reconcileDocuments(ambiguous.slice(index, index + 100))
    }
  }

  private async reconcileSavedRemoteState(): Promise<void> {
    const stored = this.plan.orderedSourceIds.flatMap((trajectoryId) =>
      this.store.getTrajectoryDocuments(this.plan.buildId, trajectoryId)
    )
    const reconcilable = stored.filter((document) => document.status !== "failed")
    for (let index = 0; index < reconcilable.length; index += 100) {
      await this.reconcileDocuments(reconcilable.slice(index, index + 100))
    }
  }

  private async reconcileDocuments(documents: StoredDocument[]): Promise<void> {
    if (documents.length === 0) return
    const states = await this.provider.reconcileDocuments(
      this.plan,
      documents.map((document) => document.customId)
    )
    await this.applyStates(states, new Set(documents.map((document) => document.customId)))
    const returned = new Set(states.map((state) => state.customId))
    for (const document of documents) {
      if (!returned.has(document.customId)) {
        this.store.resetDocumentToPlanned(document.customId)
      }
    }
  }

  private async applyStates(
    states: RemoteDocumentState[],
    expectedCustomIds: Set<string>
  ): Promise<void> {
    for (const state of states) {
      if (!expectedCustomIds.has(state.customId)) {
        throw new Error(`Provider returned unexpected customId ${state.customId}`)
      }
      this.applyState(state)
    }
  }

  private applyState(state: RemoteDocumentState): void {
    if (state.remoteId && (state.status === "pending" || state.status === "ready")) {
      this.store.markDocumentAccepted(
        state.customId,
        state.remoteId,
        state.raw ?? { status: state.status }
      )
    }
    const handlers: Record<RemoteDocumentStatus, () => void> = {
      absent: () => this.store.resetDocumentToPlanned(state.customId),
      pending: () => this.store.markDocumentIndexing(state.customId, state.remoteId),
      ready: () => this.store.markDocumentReady(state.customId, state.remoteId),
      failed: () =>
        this.store.markDocumentFailed(state.customId, state.error ?? "Remote document failed"),
      unknown: () =>
        this.store.markDocumentFailed(
          state.customId,
          state.error ?? "Unknown remote document status"
        ),
    }
    handlers[state.status]()
  }
}
