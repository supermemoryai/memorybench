import { createHash, randomUUID } from "node:crypto"
import { resolve } from "node:path"
import type {
  AdvancedSupermemoryApi,
  RequestBudgetSnapshot,
  SupermemoryMetadata,
  V3DocumentInput,
} from "./client"
import { redact } from "./client"
import { AdvancedSupermemoryBuild, type SupermemoryBuildIdentity } from "./build"
import { AdvancedSupermemoryRetrieval, type AdvancedRetrievalConfig } from "./retrieval"

export const SUPERMEMORY_PREFLIGHT_SCHEMA_VERSION = 1

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "")
}

export function supermemoryPreflightGatePath(root: string, baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl)
  if (!normalized) throw new Error("Supermemory preflight base URL must not be empty")
  const serviceId = createHash("sha256").update(normalized).digest("hex").slice(0, 24)
  return resolve(root, "supermemory", serviceId, "latest-passed.json")
}

export interface SupermemoryPreflightCheck {
  check: string
  ok: boolean
  details?: Record<string, unknown>
}

export interface SupermemoryPreflightReport {
  schemaVersion: number
  generatedAt: string
  baseUrl: string
  identity: SupermemoryBuildIdentity
  searchContract: {
    searchMode: "hybrid"
    standaloneChunksExpected: true
    deprecatedIncludeChunks: false
    requestedTopK: number
  }
  checks: SupermemoryPreflightCheck[]
  allPassed: boolean
  blockers: string[]
  requestBudget: RequestBudgetSnapshot
}

export interface SupermemoryPreflightOptions {
  searchTopK?: number
  readinessTimeoutMs?: number
  searchVisibilityTimeoutMs?: number
  searchPollMs?: number
  keepDocuments?: boolean
  sessionId?: string
  containerPrefix?: string
  clock?: () => number
  sleep?: (milliseconds: number) => Promise<void>
  onCheck?: (check: SupermemoryPreflightCheck) => void
}

/**
 * Live-account contract probe. Constructing this class is side-effect free;
 * network work occurs only when the caller explicitly invokes run().
 */
export class AdvancedSupermemoryPreflight {
  private readonly build: AdvancedSupermemoryBuild
  private readonly retrieval: AdvancedSupermemoryRetrieval
  private readonly clock: () => number
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly options: Required<
    Pick<
      SupermemoryPreflightOptions,
      | "searchTopK"
      | "readinessTimeoutMs"
      | "searchVisibilityTimeoutMs"
      | "searchPollMs"
      | "keepDocuments"
      | "containerPrefix"
    >
  > &
    SupermemoryPreflightOptions

  constructor(
    private readonly client: AdvancedSupermemoryApi,
    options: SupermemoryPreflightOptions = {}
  ) {
    this.clock = options.clock ?? Date.now
    this.sleep = options.sleep ?? ((milliseconds) => Bun.sleep(milliseconds))
    this.options = {
      ...options,
      searchTopK: options.searchTopK ?? 100,
      readinessTimeoutMs: options.readinessTimeoutMs ?? 5 * 60_000,
      searchVisibilityTimeoutMs: options.searchVisibilityTimeoutMs ?? 2 * 60_000,
      searchPollMs: options.searchPollMs ?? 5_000,
      keepDocuments: options.keepDocuments ?? false,
      containerPrefix: options.containerPrefix ?? "memorybench-preflight",
    }
    this.build = new AdvancedSupermemoryBuild(client, {
      clock: this.clock,
      sleep: this.sleep,
    })
    this.retrieval = new AdvancedSupermemoryRetrieval(client, { clock: this.clock })
  }

  async run(): Promise<SupermemoryPreflightReport> {
    const session = this.options.sessionId ?? randomUUID().replaceAll("-", "").slice(0, 12)
    const identity: SupermemoryBuildIdentity = {
      buildId: `preflight-${session}`,
      containerTag: `${this.options.containerPrefix}-${session}`,
      runFingerprint: `preflight-${session}`,
    }
    const marker = `zebra-fjord-${session}`
    const checks: SupermemoryPreflightCheck[] = []
    const createdCustomIds: string[] = []
    const customId = (suffix: string) => `preflight-${session}-${suffix}`
    const metadata = (extra: SupermemoryMetadata = {}): SupermemoryMetadata => ({
      benchmark: "longmemeval-v2-preflight",
      buildId: identity.buildId,
      runFingerprint: identity.runFingerprint,
      ...extra,
    })
    const record = (check: string, ok: boolean, details?: Record<string, unknown>): void => {
      const result = redact({ check, ok, ...(details ? { details } : {}) })
      checks.push(result)
      try {
        this.options.onCheck?.(result)
      } catch {
        // A display hook cannot affect the gate.
      }
    }
    const add = async (
      suffix: string,
      content: string,
      extraMetadata: SupermemoryMetadata = {},
      filterByMetadata?: SupermemoryMetadata
    ): Promise<Record<string, unknown>> => {
      const document: V3DocumentInput = {
        content,
        customId: customId(suffix),
        metadata: metadata(extraMetadata),
        ...(filterByMetadata ? { filterByMetadata } : {}),
      }
      if (!createdCustomIds.includes(document.customId)) createdCustomIds.push(document.customId)
      const response = await this.client.addDocument({
        document,
        containerTag: identity.containerTag,
        dreaming: "instant",
      })
      return response
    }

    try {
      const baselineCustomId = customId("doc1")
      const zeroMemoryCustomId = customId("doc4")
      try {
        createdCustomIds.push(baselineCustomId, zeroMemoryCustomId)
        const startedAt = this.clock()
        const submission = await this.build.submitTrajectoryBatch({
          trajectoryId: `preflight-trajectory-${session}`,
          identity,
          documents: [
            {
              customId: baselineCustomId,
              content:
                `Preflight document one. Unique marker: ${marker}. ` +
                "The admin settings page contains a Timezone selector.",
              metadata: metadata({
                causalKey: `pf:${session}:0:0`,
                stateIndex: 0,
              }),
            },
            {
              customId: zeroMemoryCustomId,
              content: "ok.",
              metadata: metadata({ causalKey: `pf:${session}:3:0` }),
            },
          ],
        })
        record(
          "v3_trajectory_batch",
          submission.documents.length === 2 &&
            submission.documents.every((document) => document.status !== "absent"),
          {
            documentCount: submission.documents.length,
            reconciled: submission.reconciled,
            uploadMs: this.clock() - startedAt,
          }
        )
      } catch (error) {
        record("v3_trajectory_batch", false, { error: safeError(error) })
      }

      try {
        await add(
          "doc1",
          `Preflight document one. Unique marker: ${marker}. ` +
            "The admin settings page contains a Timezone selector.",
          { causalKey: `pf:${session}:0:0`, stateIndex: 0 }
        )
        const found = await this.client.listDocumentsByCustomIds(
          [baselineCustomId],
          identity.containerTag
        )
        record("custom_id_idempotency", found.length === 1, {
          documentsWithCustomId: found.length,
        })
      } catch (error) {
        record("custom_id_idempotency", false, { error: safeError(error) })
      }

      try {
        const startedAt = this.clock()
        const ready = await this.build.awaitReady({
          customIds: [baselineCustomId],
          containerTag: identity.containerTag,
          timeoutMs: this.options.readinessTimeoutMs,
          initialPollMs: Math.min(1_000, this.options.searchPollMs),
          maxPollMs: this.options.searchPollMs,
        })
        record("document_readiness", ready.length === 1 && ready[0].status === "ready", {
          terminalStatus: ready[0]?.remoteStatus,
          millisecondsToReady: this.clock() - startedAt,
        })
        record("memory_entries_visible", ready[0]?.memoryCount !== undefined, {
          memoryEntryCount: ready[0]?.memoryCount,
        })
      } catch (error) {
        record("document_readiness", false, { error: safeError(error) })
        record("memory_entries_visible", false, { error: safeError(error) })
      }

      const filterProbes: Array<{
        suffix: string
        filter: SupermemoryMetadata
        check: string
      }> = [
        {
          suffix: "doc2",
          filter: { causalKey: `pf:${session}:0:0` },
          check: "filter_by_metadata_single",
        },
        {
          suffix: "doc3",
          filter: {
            causalKey: [`pf:${session}:0:0`, `pf:${session}:1:0`],
          },
          check: "filter_by_metadata_array_acceptance",
        },
      ]
      for (const [index, probe] of filterProbes.entries()) {
        try {
          await add(
            probe.suffix,
            `Preflight filtered document ${index + 2} referencing marker ${marker}.`,
            { causalKey: `pf:${session}:${index + 1}:0`, stateIndex: index + 1 },
            probe.filter
          )
          const ready = await this.build.awaitReady({
            customIds: [customId(probe.suffix)],
            containerTag: identity.containerTag,
            timeoutMs: this.options.readinessTimeoutMs,
            initialPollMs: Math.min(1_000, this.options.searchPollMs),
            maxPollMs: this.options.searchPollMs,
          })
          record(probe.check, ready[0]?.status === "ready", {
            terminalStatus: ready[0]?.remoteStatus,
            ...(probe.check.includes("array")
              ? { note: "acceptance only; array OR semantics require a separate semantic probe" }
              : {}),
          })
        } catch (error) {
          record(probe.check, false, { error: safeError(error) })
        }
      }

      try {
        const searchConfig: AdvancedRetrievalConfig = {
          topK: this.options.searchTopK,
          threshold: 0,
          searchMode: "hybrid",
          rerank: false,
          rewriteQuery: false,
          includeSummaries: true,
          includeChunks: true,
          includeDocuments: true,
          includeRelatedMemories: false,
        }
        const searchDeadline = this.clock() + this.options.searchVisibilityTimeoutMs
        let outcome
        do {
          outcome = await this.retrieval.search({
            identity,
            query: `What is the unique marker ${marker}?`,
            config: searchConfig,
          })
          if (outcome.normalizedResults.length > 0) break
          if (this.clock() >= searchDeadline) break
          await this.sleep(
            Math.min(this.options.searchPollMs, Math.max(0, searchDeadline - this.clock()))
          )
        } while (this.clock() <= searchDeadline)

        record("search_visibility", outcome.normalizedResults.length > 0, {
          resultCount: outcome.normalizedResults.length,
        })
        record("search_limit_accepted", true, {
          requestedTopK: this.options.searchTopK,
          returned: outcome.diagnostics.resultCount,
        })
        record(
          "search_run_fingerprint_filter",
          outcome.diagnostics.invalidProvenanceRanks.length === 0,
          { invalidRanks: outcome.diagnostics.invalidProvenanceRanks }
        )
      } catch (error) {
        record("search_visibility", false, { error: safeError(error) })
        record("search_limit_accepted", false, {
          requestedTopK: this.options.searchTopK,
          error: safeError(error),
        })
        record("search_run_fingerprint_filter", false, { error: safeError(error) })
      }

      try {
        const states = await this.build.awaitReady({
          customIds: [zeroMemoryCustomId],
          containerTag: identity.containerTag,
          timeoutMs: this.options.readinessTimeoutMs,
          initialPollMs: Math.min(1_000, this.options.searchPollMs),
          maxPollMs: this.options.searchPollMs,
        })
        record("zero_memory_document", states[0]?.status === "ready", {
          memoryEntryCount: states[0]?.memoryCount,
          terminalStatus: states[0]?.remoteStatus,
        })
      } catch (error) {
        record("zero_memory_document", false, { error: safeError(error) })
      }
    } finally {
      if (!this.options.keepDocuments && createdCustomIds.length > 0) {
        try {
          const cleanup = await this.build.cleanupExactBuild({
            identity,
            customIds: [...new Set(createdCustomIds)],
          })
          record("cleanup", true, {
            deleted: cleanup.deleted.length,
            alreadyAbsent: cleanup.absent.length,
          })
        } catch (error) {
          record("cleanup", false, { error: safeError(error) })
        }
      } else if (this.options.keepDocuments) {
        record("cleanup", true, { skipped: true })
      }
    }

    const allPassed = checks.every((check) => check.ok)
    return {
      schemaVersion: SUPERMEMORY_PREFLIGHT_SCHEMA_VERSION,
      generatedAt: new Date(this.clock()).toISOString(),
      baseUrl: this.client.baseUrl,
      identity,
      searchContract: {
        searchMode: "hybrid",
        standaloneChunksExpected: true,
        deprecatedIncludeChunks: false,
        requestedTopK: this.options.searchTopK,
      },
      checks,
      allPassed,
      blockers: checks.filter((check) => !check.ok).map((check) => check.check),
      requestBudget: this.client.budgetSnapshot,
    }
  }
}

export function validateSupermemoryPreflightReport(
  report: SupermemoryPreflightReport,
  expected: {
    baseUrl: string
    requiredTopK: number
    maxAgeMs: number
    now?: number
  }
): void {
  if (report.schemaVersion !== SUPERMEMORY_PREFLIGHT_SCHEMA_VERSION) {
    throw new Error("Supermemory preflight report schema is obsolete")
  }
  if (!report.allPassed || report.blockers.length > 0) {
    throw new Error(`Supermemory preflight is not passing: ${report.blockers.join(", ")}`)
  }
  if (normalizeBaseUrl(report.baseUrl) !== normalizeBaseUrl(expected.baseUrl)) {
    throw new Error("Supermemory preflight base URL does not match the configured base URL")
  }
  if (
    report.searchContract.searchMode !== "hybrid" ||
    report.searchContract.deprecatedIncludeChunks !== false ||
    report.searchContract.standaloneChunksExpected !== true ||
    report.searchContract.requestedTopK < expected.requiredTopK
  ) {
    throw new Error("Supermemory preflight did not validate the required V4 search contract")
  }
  const generatedAt = Date.parse(report.generatedAt)
  const age = (expected.now ?? Date.now()) - generatedAt
  if (!Number.isFinite(generatedAt) || age < 0 || age > expected.maxAgeMs) {
    throw new Error("Supermemory preflight report is missing, future-dated, or stale")
  }
}

function safeError(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error)).slice(0, 500)
}
