import { describe, expect, test } from "bun:test"
import { LegacyBuildProviderAdapter } from "./legacy-adapter"
import type {
  BuildAwareSessionBridge,
  IngestOptions,
  IngestResult,
  Provider,
  SearchOptions,
} from "../../types/provider"
import type { MemoryBuildPlan } from "../../types/migration"
import type { UnifiedSession } from "../../types/unified"

const capabilities = {
  deterministicExternalIds: true,
  batchUpload: false,
  documentDependencies: false,
  ingestionMetadataFilters: false,
  searchMetadataFilters: false,
  searchModes: ["hybrid"] as const,
  reranking: false,
  queryRewriting: false,
  remoteClear: true,
  readinessStates: true,
  mediaIngestion: false,
  durableLocalPersistence: true,
  splitPhaseSafe: true,
}

class FakeLegacyProvider implements Provider, BuildAwareSessionBridge {
  readonly name = "rag"
  readonly capabilities = capabilities
  readonly containers = new Map<string, Map<string, UnifiedSession>>()

  async initialize(): Promise<void> {}

  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
    if (options.signal?.aborted) throw options.signal.reason
    const container = this.containers.get(options.containerTag) ?? new Map()
    for (const session of sessions) container.set(session.sessionId, structuredClone(session))
    this.containers.set(options.containerTag, container)
    return { documentIds: sessions.map((session) => session.sessionId) }
  }

  async awaitIndexing(): Promise<void> {}

  async search(_query: string, options: SearchOptions): Promise<unknown[]> {
    return [...(this.containers.get(options.containerTag)?.values() ?? [])].map((session) => ({
      id: `result-${session.sessionId}`,
      sessionId: session.sessionId,
      content: session.messages[0].content,
      score: 0.9,
      metadata: session.metadata,
    }))
  }

  async clear(containerTag: string): Promise<void> {
    this.containers.delete(containerTag)
  }

  async inspectSessions(containerTag: string, sessionIds: string[]) {
    const container = this.containers.get(containerTag)
    return sessionIds.map((sessionId) => {
      const session = container?.get(sessionId)
      return session
        ? { sessionId, status: "ready" as const, metadata: session.metadata }
        : { sessionId, status: "absent" as const }
    })
  }

  async deleteSessions(containerTag: string, sessionIds: string[]): Promise<void> {
    const container = this.containers.get(containerTag)
    for (const sessionId of sessionIds) container?.delete(sessionId)
  }
}

function plan(): MemoryBuildPlan {
  return {
    schemaVersion: 1,
    buildId: "mb-test",
    benchmark: "longmemeval-v2",
    provider: "rag",
    datasetFingerprint: "dataset",
    tier: "small",
    domain: "web",
    orderedSourceIds: ["trajectory-1"],
    sourceContentHashes: ["source"],
    converter: { name: "test", version: 1, sourceHash: "source" },
    providerBuildConfig: {},
    buildFingerprint: "build-fingerprint",
    containerTag: "container-test",
    documentPlans: [],
    documents: [
      {
        trajectoryId: "trajectory-1",
        logicalDocumentId: "state-0",
        documentOrdinal: 0,
        partIndex: 0,
        partCount: 1,
        content: "A screenshot-backed memory",
        contentHash: "content-hash",
        customId: "lme2-document-1",
        documentType: "state",
        stateIndex: 0,
        screenshotRef: {
          assetId: "asset-1",
          kind: "trajectory-screenshot",
          relativePath: "screenshots/trajectory-1/0.png",
          absolutePath: "/tmp/screenshot.png",
          mimeType: "image/png",
          sha256: "a".repeat(64),
          byteLength: 123,
        },
        metadata: {},
      },
    ],
  }
}

describe("legacy build-aware provider adapter", () => {
  test("reconciles exact metadata, restores only the contributing screenshot, and cleans up", async () => {
    const legacy = new FakeLegacyProvider()
    const adapter = new LegacyBuildProviderAdapter(legacy, { operationTimeoutMs: 1_000 })
    const build = plan()
    const states = await adapter.submitDocumentBatch({
      build,
      trajectoryId: "trajectory-1",
      documents: build.documents,
    })
    expect(states).toEqual([
      expect.objectContaining({ customId: "lme2-document-1", status: "ready" }),
    ])

    const search = await adapter.searchBuild({
      build,
      questionId: "question-1",
      query: "memory",
      config: {
        topK: 20,
        threshold: 0,
        searchMode: "hybrid",
        rerank: false,
        rewriteQuery: false,
        includeSummaries: true,
        includeChunks: true,
        includeDocuments: true,
        includeRelatedMemories: false,
        metadataFilter: {},
      },
    })
    expect(search.normalizedResults).toHaveLength(1)
    expect(search.normalizedResults[0]).toEqual(
      expect.objectContaining({
        documentIds: ["lme2-document-1"],
        trajectoryId: "trajectory-1",
        screenshotRefs: [build.documents[0].screenshotRef],
        provenanceValid: true,
      })
    )

    await adapter.deleteDocuments(build, ["lme2-document-1"])
    expect((await adapter.verifyBuildHealth(build))[0].status).toBe("absent")
  })

  test("rejects stale sidecar metadata and drops search results without an exact custom ID", async () => {
    const legacy = new FakeLegacyProvider()
    const adapter = new LegacyBuildProviderAdapter(legacy, { operationTimeoutMs: 1_000 })
    const build = plan()
    await adapter.submitDocumentBatch({
      build,
      trajectoryId: "trajectory-1",
      documents: build.documents,
    })
    const session = legacy.containers.get(build.containerTag)!.get("lme2-document-1")!
    session.metadata = { ...session.metadata, buildFingerprint: "wrong-build" }
    expect((await adapter.reconcileDocuments(build, ["lme2-document-1"]))[0].status).toBe("absent")

    const originalSearch = legacy.search.bind(legacy)
    legacy.search = async () => [{ content: "unattributed", score: 1 }]
    const result = await adapter.searchBuild({
      build,
      questionId: "question-1",
      query: "memory",
      config: {
        topK: 20,
        threshold: 0,
        searchMode: "hybrid",
        rerank: false,
        rewriteQuery: false,
        includeSummaries: true,
        includeChunks: true,
        includeDocuments: true,
        includeRelatedMemories: false,
        metadataFilter: {},
      },
    })
    expect(result.normalizedResults).toEqual([])
    legacy.search = originalSearch
  })
})
