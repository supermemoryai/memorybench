import { describe, expect, test } from "bun:test"
import type { MemoryBuildPlan, PhysicalDocument, RetrievalConfig } from "../../../types/migration"
import {
  AdaptiveRequestBudget,
  AdvancedSupermemoryClient,
  SupermemoryHttpError,
  type AdvancedSupermemoryApi,
  type V3DocumentInput,
  type V4SearchRequest,
} from "./client"
import {
  AdvancedSupermemoryBuild,
  SupermemoryCleanupTimeoutError,
  UnsafeSupermemoryCleanupError,
} from "./build"
import { AdvancedSupermemoryProvider } from "./provider"
import {
  AdvancedSupermemoryRetrieval,
  SupermemoryProvenanceError,
  buildSupermemorySearchFilter,
} from "./retrieval"
import {
  AdvancedSupermemoryPreflight,
  supermemoryPreflightGatePath,
  validateSupermemoryPreflightReport,
} from "./preflight"

function response(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  })
}

function fakeFetch(
  handler: (url: string, init: RequestInit) => Promise<Response> | Response
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init ?? {})) as typeof fetch
}

function emptyBudgetSnapshot() {
  return {
    configuredCap: 4,
    effectiveCap: 4,
    inFlight: 0,
    peakInFlight: 1,
    throttleEvents: 0,
    successStreak: 0,
    notBeforeMs: 0,
  }
}

function fakeApi(overrides: Partial<AdvancedSupermemoryApi> = {}): AdvancedSupermemoryApi {
  return {
    baseUrl: "https://fake.supermemory.test",
    requestCount: 0,
    budgetSnapshot: emptyBudgetSnapshot(),
    async addDocument() {
      return { id: "document-id", status: "queued" }
    },
    async addDocumentsBatch(input) {
      return {
        results: input.documents.map((document, index) => ({
          id: `remote-${index}`,
          customId: document.customId,
          status: "queued",
        })),
      }
    },
    async getDocument() {
      return null
    },
    async listDocumentsByCustomIds() {
      return []
    },
    async searchV4() {
      return { results: [] }
    },
    async deleteDocument() {},
    ...overrides,
  }
}

function physicalDocument(customId = "lme2-document-1"): PhysicalDocument {
  return {
    trajectoryId: "trajectory-1",
    logicalDocumentId: "state-0000",
    documentOrdinal: 0,
    partIndex: 0,
    partCount: 1,
    content: "A structured accessibility observation.",
    contentHash: "a".repeat(64),
    customId,
    documentType: "state",
    stateIndex: 0,
    step: 1,
    screenshotRef: {
      assetId: "screenshot-1",
      kind: "trajectory-screenshot",
      relativePath: "screenshots/state-0.png",
      mimeType: "image/png",
      sha256: "b".repeat(64),
      byteLength: 123,
    },
    metadata: {
      evidenceFormat: "structured-accessibility-v1",
    },
  }
}

function buildPlan(document = physicalDocument()): MemoryBuildPlan {
  return {
    schemaVersion: 1,
    buildId: "build-1",
    benchmark: "longmemeval-v2",
    provider: "supermemory",
    datasetFingerprint: "dataset-fingerprint",
    tier: "small",
    domain: "web",
    orderedSourceIds: ["trajectory-1"],
    sourceContentHashes: ["c".repeat(64)],
    converter: {
      name: "structured-accessibility",
      version: 1,
      sourceHash: "d".repeat(64),
    },
    providerBuildConfig: {},
    buildFingerprint: "e".repeat(64),
    containerTag: "lme2-small-web-build",
    documentPlans: [],
    documents: [document],
  }
}

describe("AdvancedSupermemoryClient", () => {
  test("honors base URL, Retry-After, shared pressure, and secret redaction", async () => {
    const apiKey = "super-secret-api-key"
    const requests: Array<{ url: string; init: RequestInit }> = []
    const sleeps: number[] = []
    const events: Array<Record<string, unknown>> = []
    let now = 0
    let attempt = 0
    const sleep = async (milliseconds: number) => {
      sleeps.push(milliseconds)
      now += milliseconds
    }
    const budget = new AdaptiveRequestBudget({
      maxInFlight: 4,
      clock: () => now,
      sleep,
    })
    const client = new AdvancedSupermemoryClient({
      apiKey,
      baseUrl: "https://custom.supermemory.test/root/",
      maxAttempts: 2,
      fetch: fakeFetch((url, init) => {
        requests.push({ url, init })
        attempt += 1
        if (attempt === 1) {
          return response({ error: `Bearer ${apiKey} ${apiKey}` }, 429, { "Retry-After": "2" })
        }
        return response({ results: [{ id: "remote-1", status: "queued" }] })
      }),
      sleep,
      clock: () => now,
      random: () => 0,
      budget,
      eventLogger: (_event, details) => events.push(details),
    })

    const result = await client.addDocumentsBatch({
      containerTag: "container",
      dreaming: "instant",
      documents: [
        {
          content: "content",
          customId: "custom-1",
          metadata: { runFingerprint: "run-1" },
        },
      ],
    })

    expect(result.results).toHaveLength(1)
    expect(requests.map((request) => request.url)).toEqual([
      "https://custom.supermemory.test/root/v3/documents/batch",
      "https://custom.supermemory.test/root/v3/documents/batch",
    ])
    expect(new Headers(requests[0].init.headers).get("authorization")).toBe(`Bearer ${apiKey}`)
    expect(sleeps).toEqual([2_000])
    expect(client.budgetSnapshot.effectiveCap).toBe(2)
    expect(client.budgetSnapshot.throttleEvents).toBe(1)
    expect(JSON.stringify(events)).not.toContain(apiKey)
  })

  test("does not expose secrets from permanent response bodies", async () => {
    const apiKey = "do-not-leak-me"
    const client = new AdvancedSupermemoryClient({
      apiKey,
      maxAttempts: 1,
      fetch: fakeFetch(() => response({ authorization: `Bearer ${apiKey}`, token: apiKey }, 400)),
      budget: new AdaptiveRequestBudget({ maxInFlight: 1 }),
    })

    let thrown: unknown
    try {
      await client.addDocument({
        containerTag: "container",
        document: { content: "content", customId: "custom", metadata: {} },
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(SupermemoryHttpError)
    expect(String(thrown)).not.toContain(apiKey)
    expect(String(thrown)).toContain("<redacted>")
  })

  test("cancels an in-flight cleanup request without retrying it", async () => {
    const controller = new AbortController()
    const stopped = new Error("run stopped")
    let requests = 0
    const client = new AdvancedSupermemoryClient({
      apiKey: "test-key",
      maxAttempts: 3,
      fetch: fakeFetch((_url, init) => {
        requests += 1
        return new Promise<Response>((_, reject) => {
          const signal = init.signal as AbortSignal
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        })
      }),
      budget: new AdaptiveRequestBudget({ maxInFlight: 1 }),
    })

    const deletion = client.deleteDocument("remote-1", controller.signal)
    await Bun.sleep(0)
    controller.abort(stopped)

    await expect(deletion).rejects.toBe(stopped)
    expect(requests).toBe(1)
  })
})

describe("AdvancedSupermemoryBuild", () => {
  test("reconciles an ambiguous 409 by custom ID and polls to ready", async () => {
    let listCalls = 0
    let now = 0
    const api = fakeApi({
      async addDocumentsBatch() {
        throw new SupermemoryHttpError("conflict", {
          statusCode: 409,
          retryable: false,
        })
      },
      async listDocumentsByCustomIds(customIds) {
        listCalls += 1
        return customIds.map((customId) => ({
          id: `remote-${customId}`,
          customId,
          status: listCalls >= 2 ? "done" : "processing",
          metadata: {
            buildId: "build-1",
            runFingerprint: "run-1",
          },
          memories: [],
        }))
      },
    })
    const build = new AdvancedSupermemoryBuild(api, {
      clock: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds
      },
    })
    const input = {
      trajectoryId: "trajectory-1",
      identity: {
        buildId: "build-1",
        containerTag: "container-1",
        runFingerprint: "run-1",
      },
      documents: [
        {
          customId: "custom-1",
          content: "content",
          metadata: {},
          filterByMetadata: {
            runFingerprint: "run-1",
            causalKey: "custom-1",
          },
        },
      ],
    }

    const submission = await build.submitTrajectoryBatch(input)
    expect(submission.reconciled).toBe(true)
    expect(submission.documents[0].status).toBe("indexing")

    const ready = await build.awaitReady({
      customIds: ["custom-1"],
      containerTag: "container-1",
      timeoutMs: 100,
      initialPollMs: 10,
      maxPollMs: 10,
    })
    expect(ready[0].status).toBe("ready")
    expect(ready[0].memoryCount).toBe(0)
  })

  test("refuses cleanup when exact build metadata does not match", async () => {
    let deleted = false
    const api = fakeApi({
      async listDocumentsByCustomIds() {
        return [
          {
            id: "remote-1",
            customId: "custom-1",
            status: "done",
            metadata: { buildId: "another-build", runFingerprint: "run-1" },
          },
        ]
      },
      async deleteDocument() {
        deleted = true
      },
    })
    const build = new AdvancedSupermemoryBuild(api)
    await expect(
      build.cleanupExactBuild({
        identity: {
          buildId: "build-1",
          containerTag: "container",
          runFingerprint: "run-1",
        },
        customIds: ["custom-1"],
      })
    ).rejects.toBeInstanceOf(UnsafeSupermemoryCleanupError)
    expect(deleted).toBe(false)
  })

  test("reconciles a still-processing delete conflict before retrying exact cleanup", async () => {
    let now = 0
    let deleteCalls = 0
    const sleeps: number[] = []
    const remote = new Map<string, Record<string, unknown>>([
      [
        "custom-1",
        {
          id: "remote-1",
          customId: "custom-1",
          status: "processing",
          metadata: { buildId: "build-1", runFingerprint: "run-1" },
        },
      ],
    ])
    const api = fakeApi({
      async listDocumentsByCustomIds(customIds) {
        return customIds
          .map((customId) => remote.get(customId))
          .filter((document): document is Record<string, unknown> => document !== undefined)
      },
      async deleteDocument() {
        deleteCalls += 1
        if (deleteCalls === 1) {
          throw new SupermemoryHttpError(
            'HTTP 409 during delete_document: {"error":"Document is still processing"}',
            { statusCode: 409, retryable: false }
          )
        }
        remote.delete("custom-1")
      },
    })
    const build = new AdvancedSupermemoryBuild(api, {
      clock: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds)
        now += milliseconds
      },
      cleanupTimeoutMs: 100,
      cleanupInitialPollMs: 10,
      cleanupMaxPollMs: 10,
    })

    const result = await build.cleanupExactBuild({
      identity: {
        buildId: "build-1",
        containerTag: "container",
        runFingerprint: "run-1",
      },
      customIds: ["custom-1"],
    })

    expect(result).toEqual({ deleted: ["custom-1"], absent: [] })
    expect(deleteCalls).toBe(2)
    expect(sleeps).toEqual([10])
    expect(remote.size).toBe(0)
  })

  test("bounds a persistent processing conflict without treating the document as absent", async () => {
    let now = 0
    let deleteCalls = 0
    const api = fakeApi({
      async listDocumentsByCustomIds() {
        return [
          {
            id: "remote-1",
            customId: "custom-1",
            status: "processing",
            metadata: { buildId: "build-1", runFingerprint: "run-1" },
          },
        ]
      },
      async deleteDocument() {
        deleteCalls += 1
        throw new SupermemoryHttpError("Document is still processing", {
          statusCode: 409,
          retryable: false,
        })
      },
    })
    const build = new AdvancedSupermemoryBuild(api, {
      clock: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds
      },
      cleanupTimeoutMs: 20,
      cleanupInitialPollMs: 10,
      cleanupMaxPollMs: 10,
    })

    await expect(
      build.cleanupExactBuild({
        identity: {
          buildId: "build-1",
          containerTag: "container",
          runFingerprint: "run-1",
        },
        customIds: ["custom-1"],
      })
    ).rejects.toBeInstanceOf(SupermemoryCleanupTimeoutError)
    expect(deleteCalls).toBe(3)
  })

  test("cancels processing-conflict reconciliation from the run signal", async () => {
    const controller = new AbortController()
    let deleteCalls = 0
    const api = fakeApi({
      async listDocumentsByCustomIds() {
        return [
          {
            id: "remote-1",
            customId: "custom-1",
            status: "processing",
            metadata: { buildId: "build-1", runFingerprint: "run-1" },
          },
        ]
      },
      async deleteDocument() {
        deleteCalls += 1
        throw new SupermemoryHttpError("Document is still processing", {
          statusCode: 409,
          retryable: false,
        })
      },
    })
    const stopped = new Error("run stopped")
    const build = new AdvancedSupermemoryBuild(api, {
      signal: controller.signal,
      sleep: async () => {
        controller.abort(stopped)
      },
      cleanupTimeoutMs: 100,
      cleanupInitialPollMs: 10,
      cleanupMaxPollMs: 10,
    })

    await expect(
      build.cleanupExactBuild({
        identity: {
          buildId: "build-1",
          containerTag: "container",
          runFingerprint: "run-1",
        },
        customIds: ["custom-1"],
      })
    ).rejects.toBe(stopped)
    expect(deleteCalls).toBe(1)
  })
})

describe("AdvancedSupermemoryProvider", () => {
  test("implements BuildProvider with self-scoped batches, verified screenshots, and deletion", async () => {
    const remote = new Map<string, Record<string, unknown>>()
    let batch:
      | {
          documents: V3DocumentInput[]
          containerTag: string
          dreaming?: string
        }
      | undefined
    let searchRequest: V4SearchRequest | undefined
    const api = fakeApi({
      async addDocumentsBatch(input) {
        batch = input
        for (const [index, document] of input.documents.entries()) {
          remote.set(document.customId, {
            id: `remote-${index}`,
            customId: document.customId,
            status: "processing",
            metadata: document.metadata,
            memories: [],
          })
        }
        return {
          results: input.documents.map((document, index) => ({
            id: `remote-${index}`,
            customId: document.customId,
            status: "queued",
          })),
        }
      },
      async listDocumentsByCustomIds(customIds) {
        return customIds
          .map((customId) => remote.get(customId))
          .filter((document): document is Record<string, unknown> => document !== undefined)
          .map((document) => ({ ...document, status: "done" }))
      },
      async deleteDocument(idOrCustomId) {
        for (const [customId, document] of remote) {
          if (customId === idOrCustomId || document.id === idOrCustomId) remote.delete(customId)
        }
      },
      async searchV4(request) {
        searchRequest = request
        const metadata = batch!.documents[0].metadata
        return {
          results: [
            {
              id: "result-1",
              memory: "Timezone is UTC.",
              similarity: 0.9,
              chunks: [{ content: "same chunk" }, { content: "same chunk" }],
              documents: [{ id: "remote-0", summary: "Settings", metadata }],
            },
          ],
        }
      },
    })
    const provider = new AdvancedSupermemoryProvider(api)
    const document = physicalDocument()
    const build = buildPlan(document)

    const submitted = await provider.submitDocumentBatch({
      build,
      trajectoryId: "trajectory-1",
      documents: [document],
    })
    expect(submitted[0].status).toBe("pending")
    expect(batch?.dreaming).toBe("instant")
    expect(batch?.containerTag).toBe(build.containerTag)
    expect(batch?.documents[0].metadata).toMatchObject({
      runFingerprint: build.buildFingerprint,
      buildFingerprint: build.buildFingerprint,
      buildId: build.buildId,
      trajectoryId: "trajectory-1",
      causalKey: document.customId,
      screenshotAssetId: "screenshot-1",
      screenshotSha256: "b".repeat(64),
      screenshotMimeType: "image/png",
      screenshotByteLength: 123,
    })
    expect(batch?.documents[0].filterByMetadata).toEqual({
      runFingerprint: build.buildFingerprint,
      buildFingerprint: build.buildFingerprint,
      trajectoryId: "trajectory-1",
      causalKey: document.customId,
    })

    const reconciled = await provider.reconcileDocuments(build, [document.customId])
    expect(reconciled[0].status).toBe("ready")

    const config: RetrievalConfig = {
      topK: 17,
      threshold: 0.1,
      searchMode: "hybrid",
      rerank: true,
      rewriteQuery: false,
      includeSummaries: true,
      includeChunks: true,
      includeDocuments: true,
      includeRelatedMemories: true,
      metadataFilter: {},
    }
    const search = await provider.searchBuild({
      build,
      questionId: "question-1",
      query: "What is the timezone?",
      config,
    })
    expect(searchRequest).toMatchObject({
      limit: 17,
      containerTag: build.containerTag,
      filters: {
        AND: [
          {
            key: "runFingerprint",
            value: build.buildFingerprint,
            filterType: "metadata",
          },
        ],
      },
    })
    expect(search.normalizedResults[0].chunks).toEqual(["same chunk"])
    expect(search.normalizedResults[0].screenshotRefs).toEqual([document.screenshotRef!])
    expect(search.normalizedResults[0].provenanceValid).toBe(true)

    await provider.deleteDocuments(build, [document.customId])
    expect(remote.size).toBe(0)
  })
})

describe("AdvancedSupermemoryRetrieval", () => {
  test("builds the current V4 logical filter contract and keeps the build boundary mandatory", () => {
    expect(
      buildSupermemorySearchFilter(
        {
          domain: ["web", "enterprise"],
          stateIndex: 4,
          verified: true,
        },
        "expected-run"
      )
    ).toEqual({
      AND: [
        {
          key: "runFingerprint",
          value: "expected-run",
          filterType: "metadata",
        },
        {
          OR: [
            {
              key: "domain",
              value: "web",
              filterType: "array_contains",
            },
            {
              key: "domain",
              value: "enterprise",
              filterType: "array_contains",
            },
          ],
        },
        {
          key: "stateIndex",
          value: "4",
          filterType: "numeric",
          numericOperator: "=",
        },
        {
          key: "verified",
          value: "true",
          filterType: "metadata",
        },
      ],
    })

    expect(
      buildSupermemorySearchFilter(
        {
          OR: [
            { key: "trajectoryId", value: "one" },
            {
              AND: [
                {
                  key: "stateIndex",
                  value: "2",
                  filterType: "numeric",
                  numericOperator: ">=",
                },
                { key: "domain", value: "web", negate: false },
              ],
            },
          ],
        },
        "expected-run"
      )
    ).toEqual({
      AND: [
        {
          key: "runFingerprint",
          value: "expected-run",
          filterType: "metadata",
        },
        {
          OR: [
            { key: "trajectoryId", value: "one" },
            {
              AND: [
                {
                  key: "stateIndex",
                  value: "2",
                  filterType: "numeric",
                  numericOperator: ">=",
                },
                { key: "domain", value: "web", negate: false },
              ],
            },
          ],
        },
      ],
    })
  })

  test("rejects filters that weaken provenance or violate the V4 contract", () => {
    expect(() =>
      buildSupermemorySearchFilter({ runFingerprint: "another-run" }, "expected-run")
    ).toThrow("cannot override")
    expect(() =>
      buildSupermemorySearchFilter(
        {
          OR: [{ key: "runFingerprint", value: "another-run" }],
        },
        "expected-run"
      )
    ).toThrow("cannot override")
    expect(() =>
      buildSupermemorySearchFilter(
        {
          AND: [
            {
              key: "stateIndex",
              value: "not-a-number",
              filterType: "numeric",
            },
          ],
        },
        "expected-run"
      )
    ).toThrow("requires a numeric value")
    expect(() => buildSupermemorySearchFilter({ "bad key": "value" }, "expected-run")).toThrow(
      "Invalid search metadata key"
    )
  })

  test("rejects wrong run fingerprint even when the container matches", async () => {
    const api = fakeApi({
      async searchV4() {
        return {
          results: [
            {
              id: "wrong-run",
              memory: "contaminated",
              metadata: { runFingerprint: "another-run" },
            },
          ],
        }
      },
    })
    const retrieval = new AdvancedSupermemoryRetrieval(api)
    await expect(
      retrieval.search({
        identity: {
          buildId: "build-1",
          containerTag: "shared-container",
          runFingerprint: "expected-run",
        },
        query: "question",
        config: { topK: 10 },
      })
    ).rejects.toBeInstanceOf(SupermemoryProvenanceError)
  })
})

describe("AdvancedSupermemoryPreflight", () => {
  test("exposes explicit hooks, validates the gate, and cleans exact probe documents", async () => {
    const remote = new Map<string, Record<string, unknown>>()
    const observedChecks: string[] = []
    const api = fakeApi({
      async addDocument(input) {
        const document = input.document
        const existing = remote.get(document.customId)
        if (existing) return existing as { id: string }
        const created = {
          id: `remote-${remote.size}`,
          customId: document.customId,
          status: "done",
          metadata: document.metadata,
          memories: [],
        }
        remote.set(document.customId, created)
        return created
      },
      async addDocumentsBatch(input) {
        const results = input.documents.map((document) => {
          const created = {
            id: `remote-${remote.size}`,
            customId: document.customId,
            status: "done",
            metadata: document.metadata,
            memories: [],
          }
          remote.set(document.customId, created)
          return created
        })
        return { results }
      },
      async listDocumentsByCustomIds(customIds) {
        return customIds
          .map((customId) => remote.get(customId))
          .filter((document): document is Record<string, unknown> => document !== undefined)
      },
      async searchV4(request) {
        const first = remote.values().next().value as Record<string, unknown> | undefined
        return {
          results: first
            ? [
                {
                  id: "probe-result",
                  memory: "The unique marker is visible.",
                  metadata: first.metadata,
                },
              ]
            : [],
          requestLimit: request.limit,
        }
      },
      async deleteDocument(idOrCustomId) {
        for (const [customId, document] of remote) {
          if (customId === idOrCustomId || document.id === idOrCustomId) remote.delete(customId)
        }
      },
    })
    const now = Date.parse("2026-07-27T00:00:00.000Z")
    const report = await new AdvancedSupermemoryPreflight(api, {
      sessionId: "test-session",
      searchTopK: 100,
      readinessTimeoutMs: 100,
      searchVisibilityTimeoutMs: 100,
      searchPollMs: 1,
      clock: () => now,
      sleep: async () => {},
      onCheck: (check) => observedChecks.push(check.check),
    }).run()

    expect(report.allPassed).toBe(true)
    expect(observedChecks).toContain("v3_trajectory_batch")
    expect(observedChecks).toContain("search_run_fingerprint_filter")
    expect(observedChecks).toContain("cleanup")
    expect(remote.size).toBe(0)
    expect(() =>
      validateSupermemoryPreflightReport(report, {
        baseUrl: api.baseUrl,
        requiredTopK: 100,
        maxAgeMs: 1_000,
        now,
      })
    ).not.toThrow()
    expect(() =>
      validateSupermemoryPreflightReport(report, {
        baseUrl: "https://another.supermemory.test",
        requiredTopK: 100,
        maxAgeMs: 1_000,
        now,
      })
    ).toThrow("base URL")
    expect(() =>
      validateSupermemoryPreflightReport(report, {
        baseUrl: api.baseUrl,
        requiredTopK: 101,
        maxAgeMs: 1_000,
        now,
      })
    ).toThrow("search contract")
    expect(() =>
      validateSupermemoryPreflightReport(report, {
        baseUrl: api.baseUrl,
        requiredTopK: 100,
        maxAgeMs: 1_000,
        now: now + 1_001,
      })
    ).toThrow("stale")
    expect(supermemoryPreflightGatePath("/tmp/preflight-gates", `${api.baseUrl}/`)).toBe(
      supermemoryPreflightGatePath("/tmp/preflight-gates", api.baseUrl)
    )
    expect(supermemoryPreflightGatePath("/tmp/preflight-gates", api.baseUrl)).not.toBe(
      supermemoryPreflightGatePath("/tmp/preflight-gates", "https://another.supermemory.test")
    )
  })
})
