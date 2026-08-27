import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { MemoryBuildPlan, PhysicalDocument } from "../types/migration"
import { canonicalJson } from "./canonical"

export type BuildStatus = "planned" | "ingesting" | "ready" | "failed" | "degraded"
export type TrajectoryStatus = "planned" | "processing" | "ready" | "retryable" | "failed"
export type BuildDocumentStatus =
  | "planned"
  | "submitting"
  | "accepted"
  | "indexing"
  | "ready"
  | "retryable"
  | "failed"

export interface StoredDocument {
  customId: string
  buildId: string
  trajectoryId: string
  trajectoryOrder: number
  logicalDocumentId: string
  documentOrdinal: number
  partIndex: number
  partCount: number
  contentHash: string
  remoteId?: string
  status: BuildDocumentStatus
  attempts: number
  lastError?: string
}

function now(): string {
  return new Date().toISOString()
}

export class BuildStore {
  readonly path: string
  private readonly db: Database

  constructor(path: string) {
    this.path = path
    mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true, strict: true })
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA synchronous = FULL")
    this.db.exec("PRAGMA foreign_keys = ON")
    this.db.exec("PRAGMA busy_timeout = 10000")
    this.migrate()
  }

  private migrate(): void {
    const version = this.db.query("PRAGMA user_version").get() as { user_version: number }
    if (version.user_version > 1) {
      throw new Error(
        `Build checkpoint schema ${version.user_version} is newer than supported schema 1`
      )
    }
    if (version.user_version === 0) {
      this.db.exec(`
        CREATE TABLE builds (
          build_id TEXT PRIMARY KEY,
          build_fingerprint TEXT NOT NULL UNIQUE,
          container_tag TEXT NOT NULL,
          provider TEXT NOT NULL,
          plan_json TEXT NOT NULL,
          status TEXT NOT NULL,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE trajectories (
          build_id TEXT NOT NULL,
          trajectory_id TEXT NOT NULL,
          trajectory_order INTEGER NOT NULL,
          plan_hash TEXT NOT NULL,
          status TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          lease_owner TEXT,
          lease_expires_at INTEGER,
          error TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (build_id, trajectory_id),
          UNIQUE (build_id, trajectory_order),
          FOREIGN KEY (build_id) REFERENCES builds(build_id)
        );
        CREATE TABLE documents (
          custom_id TEXT PRIMARY KEY,
          build_id TEXT NOT NULL,
          trajectory_id TEXT NOT NULL,
          trajectory_order INTEGER NOT NULL,
          logical_document_id TEXT NOT NULL,
          document_ordinal INTEGER NOT NULL,
          part_index INTEGER NOT NULL,
          part_count INTEGER NOT NULL,
          content_hash TEXT NOT NULL,
          remote_id TEXT,
          status TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          response_json TEXT,
          updated_at TEXT NOT NULL,
          UNIQUE (build_id, trajectory_id, document_ordinal, part_index),
          FOREIGN KEY (build_id, trajectory_id)
            REFERENCES trajectories(build_id, trajectory_id)
        );
        CREATE INDEX documents_build_status ON documents(build_id, status);
        CREATE INDEX documents_remote_id ON documents(remote_id);
        CREATE TABLE events (
          event_id INTEGER PRIMARY KEY AUTOINCREMENT,
          build_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          entity_type TEXT,
          entity_id TEXT,
          details_json TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (build_id) REFERENCES builds(build_id)
        );
        PRAGMA user_version = 1;
      `)
    }
  }

  registerBuild(plan: MemoryBuildPlan): boolean {
    const planJson = canonicalJson({
      ...plan,
      documents: plan.documents.map((document) => ({
        ...document,
        screenshotRef: document.screenshotRef
          ? { ...document.screenshotRef, absolutePath: undefined }
          : undefined,
      })),
      documentPlans: plan.documentPlans.map((documentPlan) => ({
        ...documentPlan,
        documents: documentPlan.documents.map((document) => ({
          ...document,
          spec: {
            ...document.spec,
            screenshotRef: document.spec.screenshotRef
              ? { ...document.spec.screenshotRef, absolutePath: undefined }
              : undefined,
          },
        })),
      })),
    })
    const existing = this.db
      .query(
        "SELECT build_fingerprint, container_tag, provider, plan_json FROM builds WHERE build_id = ?"
      )
      .get(plan.buildId) as {
      build_fingerprint: string
      container_tag: string
      provider: string
      plan_json: string
    } | null
    if (existing) {
      if (
        existing.build_fingerprint !== plan.buildFingerprint ||
        existing.container_tag !== plan.containerTag ||
        existing.provider !== plan.provider ||
        existing.plan_json !== planJson
      ) {
        throw new Error(`Build ${plan.buildId} checkpoint does not match the requested plan`)
      }
      return false
    }

    const documentPlans = new Map(plan.documentPlans.map((item) => [item.trajectoryId, item]))
    const trajectoryOrder = new Map(
      plan.orderedSourceIds.map((trajectoryId, index) => [trajectoryId, index])
    )
    const documentsByTrajectory = new Map<string, PhysicalDocument[]>()
    for (const document of plan.documents) {
      const items = documentsByTrajectory.get(document.trajectoryId) ?? []
      items.push(document)
      documentsByTrajectory.set(document.trajectoryId, items)
    }

    const transaction = this.db.transaction(() => {
      const timestamp = now()
      this.db
        .query(
          `INSERT INTO builds
            (build_id, build_fingerprint, container_tag, provider, plan_json, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'planned', ?, ?)`
        )
        .run(
          plan.buildId,
          plan.buildFingerprint,
          plan.containerTag,
          plan.provider,
          planJson,
          timestamp,
          timestamp
        )
      for (const trajectoryId of plan.orderedSourceIds) {
        const trajectoryPlan = documentPlans.get(trajectoryId)
        if (!trajectoryPlan) throw new Error(`Missing document plan for ${trajectoryId}`)
        const order = trajectoryOrder.get(trajectoryId)!
        this.db
          .query(
            `INSERT INTO trajectories
              (build_id, trajectory_id, trajectory_order, plan_hash, status, updated_at)
             VALUES (?, ?, ?, ?, 'planned', ?)`
          )
          .run(plan.buildId, trajectoryId, order, trajectoryPlan.planHash, timestamp)
        for (const document of documentsByTrajectory.get(trajectoryId) ?? []) {
          this.db
            .query(
              `INSERT INTO documents
                (custom_id, build_id, trajectory_id, trajectory_order, logical_document_id,
                 document_ordinal, part_index, part_count, content_hash, status, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?)`
            )
            .run(
              document.customId,
              plan.buildId,
              trajectoryId,
              order,
              document.logicalDocumentId,
              document.documentOrdinal,
              document.partIndex,
              document.partCount,
              document.contentHash,
              timestamp
            )
        }
      }
      this.recordEvent(plan.buildId, "build_registered", "build", plan.buildId, {
        trajectories: plan.orderedSourceIds.length,
        documents: plan.documents.length,
      })
    })
    transaction.immediate()
    return true
  }

  getBuild(buildId: string): {
    buildId: string
    buildFingerprint: string
    containerTag: string
    provider: string
    status: BuildStatus
    error?: string
  } | null {
    const row = this.db
      .query(
        `SELECT build_id, build_fingerprint, container_tag, provider, status, error
         FROM builds WHERE build_id = ?`
      )
      .get(buildId) as {
      build_id: string
      build_fingerprint: string
      container_tag: string
      provider: string
      status: BuildStatus
      error: string | null
    } | null
    return row
      ? {
          buildId: row.build_id,
          buildFingerprint: row.build_fingerprint,
          containerTag: row.container_tag,
          provider: row.provider,
          status: row.status,
          error: row.error ?? undefined,
        }
      : null
  }

  setBuildStatus(buildId: string, status: BuildStatus, error?: string): void {
    this.db
      .query("UPDATE builds SET status = ?, error = ?, updated_at = ? WHERE build_id = ?")
      .run(status, error ?? null, now(), buildId)
  }

  claimTrajectory(buildId: string, workerId: string, leaseMs: number): string | null {
    if (!Number.isInteger(leaseMs) || leaseMs < 1) throw new Error("leaseMs must be positive")
    const transaction = this.db.transaction(() => {
      const timestamp = Date.now()
      const row = this.db
        .query(
          `SELECT trajectory_id FROM trajectories
           WHERE build_id = ?
             AND (
               status IN ('planned', 'retryable')
               OR (status = 'processing' AND COALESCE(lease_expires_at, 0) <= ?)
             )
           ORDER BY trajectory_order
           LIMIT 1`
        )
        .get(buildId, timestamp) as { trajectory_id: string } | null
      if (!row) return null
      const result = this.db
        .query(
          `UPDATE trajectories
           SET status = 'processing', attempts = attempts + 1, lease_owner = ?,
               lease_expires_at = ?, error = NULL, updated_at = ?
           WHERE build_id = ? AND trajectory_id = ?
             AND (
               status IN ('planned', 'retryable')
               OR (status = 'processing' AND COALESCE(lease_expires_at, 0) <= ?)
             )`
        )
        .run(workerId, timestamp + leaseMs, now(), buildId, row.trajectory_id, timestamp)
      return result.changes === 1 ? row.trajectory_id : null
    })
    return transaction.immediate()
  }

  renewTrajectoryLease(
    buildId: string,
    trajectoryId: string,
    workerId: string,
    leaseMs: number
  ): void {
    const result = this.db
      .query(
        `UPDATE trajectories
         SET lease_expires_at = ?, updated_at = ?
         WHERE build_id = ? AND trajectory_id = ? AND status = 'processing' AND lease_owner = ?`
      )
      .run(Date.now() + leaseMs, now(), buildId, trajectoryId, workerId)
    if (result.changes !== 1) {
      throw new Error(`Worker ${workerId} no longer owns ${trajectoryId}`)
    }
  }

  getTrajectoryAttempt(buildId: string, trajectoryId: string): number {
    const row = this.db
      .query("SELECT attempts FROM trajectories WHERE build_id = ? AND trajectory_id = ?")
      .get(buildId, trajectoryId) as { attempts: number } | null
    if (!row) throw new Error(`Unknown trajectory ${trajectoryId}`)
    return row.attempts
  }

  getFailedTrajectories(buildId: string): Array<{ trajectoryId: string; error?: string }> {
    const rows = this.db
      .query(
        `SELECT trajectory_id, error FROM trajectories
         WHERE build_id = ? AND status = 'failed'
         ORDER BY trajectory_order`
      )
      .all(buildId) as Array<{ trajectory_id: string; error: string | null }>
    return rows.map((row) => ({
      trajectoryId: row.trajectory_id,
      error: row.error ?? undefined,
    }))
  }

  getDocumentCustomIdsByStatus(buildId: string, status: BuildDocumentStatus): string[] {
    const rows = this.db
      .query(
        `SELECT custom_id FROM documents
         WHERE build_id = ? AND status = ?
         ORDER BY trajectory_order, document_ordinal, part_index`
      )
      .all(buildId, status) as Array<{ custom_id: string }>
    return rows.map((row) => row.custom_id)
  }

  markTrajectoryReady(buildId: string, trajectoryId: string, workerId: string): void {
    const notReady = this.db
      .query(
        `SELECT COUNT(*) AS count FROM documents
         WHERE build_id = ? AND trajectory_id = ? AND status != 'ready'`
      )
      .get(buildId, trajectoryId) as { count: number }
    if (notReady.count > 0) {
      throw new Error(`Cannot complete ${trajectoryId}; ${notReady.count} documents are not ready`)
    }
    const result = this.db
      .query(
        `UPDATE trajectories
         SET status = 'ready', lease_owner = NULL, lease_expires_at = NULL, error = NULL, updated_at = ?
         WHERE build_id = ? AND trajectory_id = ? AND lease_owner = ?`
      )
      .run(now(), buildId, trajectoryId, workerId)
    if (result.changes !== 1) throw new Error(`Worker ${workerId} no longer owns ${trajectoryId}`)
  }

  markTrajectoryRetryable(
    buildId: string,
    trajectoryId: string,
    workerId: string,
    error: string
  ): void {
    this.db
      .query(
        `UPDATE trajectories
         SET status = 'retryable', lease_owner = NULL, lease_expires_at = NULL, error = ?, updated_at = ?
         WHERE build_id = ? AND trajectory_id = ? AND lease_owner = ?`
      )
      .run(error.slice(0, 2000), now(), buildId, trajectoryId, workerId)
  }

  markTrajectoryFailed(
    buildId: string,
    trajectoryId: string,
    workerId: string,
    error: string
  ): void {
    this.db
      .query(
        `UPDATE trajectories
         SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL, error = ?, updated_at = ?
         WHERE build_id = ? AND trajectory_id = ? AND lease_owner = ?`
      )
      .run(error.slice(0, 2000), now(), buildId, trajectoryId, workerId)
  }

  getTrajectoryDocuments(buildId: string, trajectoryId: string): StoredDocument[] {
    const rows = this.db
      .query(
        `SELECT custom_id, build_id, trajectory_id, trajectory_order, logical_document_id,
                document_ordinal, part_index, part_count, content_hash, remote_id,
                status, attempts, last_error
         FROM documents
         WHERE build_id = ? AND trajectory_id = ?
         ORDER BY document_ordinal, part_index`
      )
      .all(buildId, trajectoryId) as Array<{
      custom_id: string
      build_id: string
      trajectory_id: string
      trajectory_order: number
      logical_document_id: string
      document_ordinal: number
      part_index: number
      part_count: number
      content_hash: string
      remote_id: string | null
      status: BuildDocumentStatus
      attempts: number
      last_error: string | null
    }>
    return rows.map((row) => ({
      customId: row.custom_id,
      buildId: row.build_id,
      trajectoryId: row.trajectory_id,
      trajectoryOrder: row.trajectory_order,
      logicalDocumentId: row.logical_document_id,
      documentOrdinal: row.document_ordinal,
      partIndex: row.part_index,
      partCount: row.part_count,
      contentHash: row.content_hash,
      remoteId: row.remote_id ?? undefined,
      status: row.status,
      attempts: row.attempts,
      lastError: row.last_error ?? undefined,
    }))
  }

  getAmbiguousDocuments(buildId: string): StoredDocument[] {
    const trajectoryIds = this.db
      .query(
        `SELECT DISTINCT trajectory_id FROM documents
         WHERE build_id = ? AND status IN ('submitting', 'accepted', 'indexing')`
      )
      .all(buildId) as Array<{ trajectory_id: string }>
    return trajectoryIds.flatMap((row) =>
      this.getTrajectoryDocuments(buildId, row.trajectory_id).filter((document) =>
        ["submitting", "accepted", "indexing"].includes(document.status)
      )
    )
  }

  /**
   * A locally-ready trajectory must be made claimable again when a remote
   * health reconciliation moves any of its documents out of `ready`.
   */
  reopenTrajectoriesWithNonReadyDocuments(buildId: string): number {
    const result = this.db
      .query(
        `UPDATE trajectories
         SET status = 'planned', lease_owner = NULL, lease_expires_at = NULL,
             error = NULL, updated_at = ?
         WHERE build_id = ?
           AND status = 'ready'
           AND EXISTS (
             SELECT 1 FROM documents
             WHERE documents.build_id = trajectories.build_id
               AND documents.trajectory_id = trajectories.trajectory_id
               AND documents.status != 'ready'
           )`
      )
      .run(now(), buildId)
    return result.changes
  }

  /**
   * Used only after an explicit remote clear. It never silently discards a
   * remote namespace and therefore keeps `--force` semantics auditable.
   */
  resetBuildForReingestion(buildId: string): void {
    const transaction = this.db.transaction(() => {
      this.db
        .query(
          `UPDATE documents
           SET status = 'planned', remote_id = NULL, response_json = NULL,
               last_error = NULL, updated_at = ?
           WHERE build_id = ?`
        )
        .run(now(), buildId)
      this.db
        .query(
          `UPDATE trajectories
           SET status = 'planned', attempts = 0, lease_owner = NULL,
               lease_expires_at = NULL, error = NULL, updated_at = ?
           WHERE build_id = ?`
        )
        .run(now(), buildId)
      this.db
        .query(
          `UPDATE builds SET status = 'planned', error = NULL, updated_at = ?
           WHERE build_id = ?`
        )
        .run(now(), buildId)
      this.recordEvent(buildId, "build_explicitly_reset", "build", buildId)
    })
    transaction.immediate()
  }

  markDocumentSubmitting(customId: string): void {
    this.db
      .query(
        `UPDATE documents SET status = 'submitting', attempts = attempts + 1,
         last_error = NULL, updated_at = ? WHERE custom_id = ?`
      )
      .run(now(), customId)
  }

  markDocumentAccepted(customId: string, remoteId: string, response: unknown): void {
    this.db
      .query(
        `UPDATE documents SET status = 'accepted', remote_id = ?, response_json = ?,
         last_error = NULL, updated_at = ? WHERE custom_id = ?`
      )
      .run(remoteId, canonicalJson(response), now(), customId)
  }

  markDocumentIndexing(customId: string, remoteId?: string): void {
    this.db
      .query(
        `UPDATE documents SET status = 'indexing', remote_id = COALESCE(?, remote_id),
         updated_at = ? WHERE custom_id = ?`
      )
      .run(remoteId ?? null, now(), customId)
  }

  markDocumentReady(customId: string, remoteId?: string): void {
    this.db
      .query(
        `UPDATE documents SET status = 'ready', remote_id = COALESCE(?, remote_id),
         last_error = NULL, updated_at = ? WHERE custom_id = ?`
      )
      .run(remoteId ?? null, now(), customId)
  }

  resetDocumentToPlanned(customId: string): void {
    this.db
      .query(
        `UPDATE documents SET status = 'planned', remote_id = NULL, response_json = NULL,
         last_error = NULL, updated_at = ? WHERE custom_id = ?`
      )
      .run(now(), customId)
  }

  markDocumentRetryable(customId: string, error: string): void {
    this.db
      .query(
        `UPDATE documents SET status = 'retryable', last_error = ?, updated_at = ?
         WHERE custom_id = ?`
      )
      .run(error.slice(0, 2000), now(), customId)
  }

  markDocumentFailed(customId: string, error: string): void {
    this.db
      .query(
        `UPDATE documents SET status = 'failed', last_error = ?, updated_at = ?
         WHERE custom_id = ?`
      )
      .run(error.slice(0, 2000), now(), customId)
  }

  buildSummary(buildId: string): {
    trajectories: Record<TrajectoryStatus, number>
    documents: Record<BuildDocumentStatus, number>
  } {
    const trajectoryCounts = Object.fromEntries(
      ["planned", "processing", "ready", "retryable", "failed"].map((status) => [status, 0])
    ) as Record<TrajectoryStatus, number>
    const documentCounts = Object.fromEntries(
      ["planned", "submitting", "accepted", "indexing", "ready", "retryable", "failed"].map(
        (status) => [status, 0]
      )
    ) as Record<BuildDocumentStatus, number>
    const trajectories = this.db
      .query(
        "SELECT status, COUNT(*) AS count FROM trajectories WHERE build_id = ? GROUP BY status"
      )
      .all(buildId) as Array<{ status: TrajectoryStatus; count: number }>
    const documents = this.db
      .query("SELECT status, COUNT(*) AS count FROM documents WHERE build_id = ? GROUP BY status")
      .all(buildId) as Array<{ status: BuildDocumentStatus; count: number }>
    for (const row of trajectories) trajectoryCounts[row.status] = row.count
    for (const row of documents) documentCounts[row.status] = row.count
    return { trajectories: trajectoryCounts, documents: documentCounts }
  }

  recordEvent(
    buildId: string,
    eventType: string,
    entityType?: string,
    entityId?: string,
    details?: unknown
  ): void {
    this.db
      .query(
        `INSERT INTO events
          (build_id, event_type, entity_type, entity_id, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        buildId,
        eventType,
        entityType ?? null,
        entityId ?? null,
        details === undefined ? null : canonicalJson(details),
        now()
      )
  }

  close(): void {
    this.db.close()
  }
}
