import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CanonicalIngestionDocument } from "../src/types/unified"
import {
  SupermemoryProvider,
  normalizeSupermemorySearchResults,
} from "../src/providers/supermemory"
import { buildSupermemoryAnswerPrompt } from "../src/providers/supermemory/prompts"
import { Mem0Provider, normalizeMem0SearchResults } from "../src/providers/mem0"
import { buildMem0AnswerPrompt } from "../src/providers/mem0/prompts"
import {
  ZepProvider,
  allocateZepSearchBudget,
  normalizeZepSearchResults,
} from "../src/providers/zep"
import { buildZepAnswerPrompt } from "../src/providers/zep/prompts"
import { normalizeFilesystemSearchResults } from "../src/providers/filesystem"
import { buildFilesystemAnswerPrompt } from "../src/providers/filesystem/prompts"
import {
  loadPersistedRagChunks,
  normalizeRagSearchResults,
  persistRagChunks,
} from "../src/providers/rag"
import { HybridSearchEngine, type Chunk } from "../src/providers/rag/search"
import { buildRAGAnswerPrompt } from "../src/providers/rag/prompts"

const DOCUMENT: CanonicalIngestionDocument = {
  customId: "session-1",
  content: "DOCUMENT_DATE: 2025-03-14T10:00:00Z\n\nUSER: I moved to Pune.\nASSISTANT: Got it.",
  metadata: {
    sessionId: "session-1",
    documentDate: "2025-03-14T10:00:00Z",
  },
  messages: [
    { role: "user", content: "I moved to Pune." },
    { role: "assistant", content: "Got it." },
  ],
}

describe("Supermemory provider boundary", () => {
  test("normalizes both memory and singular chunk results", () => {
    const results = normalizeSupermemorySearchResults(
      [
        {
          id: "memory-1",
          memory: "Vedant moved to Pune.",
          similarity: 0.91,
          metadata: {
            sessionId: "session-1",
            temporalContext: { documentDate: "2025-03-14T10:00:00Z" },
          },
        },
        {
          id: "chunk-1",
          chunk: "USER: I moved to Pune.",
          similarity: 0.82,
          metadata: null,
          documents: [
            {
              metadata: {
                sessionId: "session-2",
                documentDate: "2025-03-15T11:00:00Z",
              },
            },
          ],
        },
      ],
      2
    )

    expect(results).toEqual([
      {
        id: "memory-1",
        rank: 1,
        text: "Vedant moved to Pune.",
        score: 0.91,
        sessionId: "session-1",
        documentDate: "2025-03-14T10:00:00Z",
        provider: "supermemory",
        resultType: "memory",
      },
      {
        id: "chunk-1",
        rank: 2,
        text: "USER: I moved to Pune.",
        score: 0.82,
        sessionId: "session-2",
        documentDate: "2025-03-15T11:00:00Z",
        provider: "supermemory",
        resultType: "chunk",
      },
    ])
  })

  test("resolves each source field across all associated document metadata", () => {
    const [result] = normalizeSupermemorySearchResults(
      [
        {
          id: "chunk-with-later-source-metadata",
          chunk: "Normalized chunk text",
          similarity: 0.77,
          metadata: { providerLabel: "hybrid" },
          documents: [
            { metadata: { unrelated: "first metadata is non-empty" } },
            { metadata: { sessionId: "session-later" } },
            { metadata: { documentDate: "2025-04-02" } },
          ],
        },
      ],
      1
    )

    expect(result).toMatchObject({
      sessionId: "session-later",
      documentDate: "2025-04-02",
    })
  })

  test("prefers result metadata and fails closed on ambiguous document fallback metadata", () => {
    const [authoritative] = normalizeSupermemorySearchResults(
      [
        {
          id: "result-authoritative",
          memory: "Authoritative metadata",
          metadata: { sessionId: "result-session", documentDate: "2025-05-01" },
          documents: [
            { metadata: { sessionId: "document-a", documentDate: "2025-05-02" } },
            { metadata: { sessionId: "document-b", documentDate: "2025-05-03" } },
          ],
        },
      ],
      1
    )
    expect(authoritative).toMatchObject({
      sessionId: "result-session",
      documentDate: "2025-05-01",
    })

    expect(() =>
      normalizeSupermemorySearchResults(
        [
          {
            id: "ambiguous-documents",
            chunk: "Ambiguous source",
            documents: [
              { metadata: { sessionId: "session-a", documentDate: "2025-05-01" } },
              { metadata: { sessionId: "session-b", documentDate: "2025-05-02" } },
            ],
          },
        ],
        1
      )
    ).toThrow("conflicting document sessionId")
  })

  test("sends the canonical document unchanged and honors zero threshold plus Top-K", async () => {
    const addCalls: unknown[] = []
    const addRequestOptions: unknown[] = []
    const searchCalls: unknown[] = []
    const provider = new SupermemoryProvider()
    const fakeClient = {
      add: async (request: unknown, requestOptions: unknown) => {
        addCalls.push(request)
        addRequestOptions.push(requestOptions)
        return { id: "document-1", status: "queued" }
      },
      search: {
        memories: async (request: unknown) => {
          searchCalls.push(request)
          return {
            results: [
              {
                id: "memory-1",
                memory: "Vedant moved to Pune.",
                similarity: 0.9,
                metadata: DOCUMENT.metadata,
              },
            ],
          }
        },
      },
    }
    ;(provider as unknown as { client: typeof fakeClient }).client = fakeClient

    await provider.ingest([DOCUMENT], { containerTag: "beam_run" })
    const response = await provider.search("Where did Vedant move?", {
      containerTag: "beam_run",
      limit: 5,
      threshold: 0,
      searchMode: "hybrid",
    })
    const results = response.results

    expect(addCalls).toEqual([
      {
        content: DOCUMENT.content,
        containerTag: "beam_run",
        customId: DOCUMENT.customId,
        metadata: DOCUMENT.metadata,
      },
    ])
    expect(addRequestOptions).toEqual([{ idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/) }])
    expect(searchCalls).toEqual([
      {
        q: "Where did Vedant move?",
        containerTag: "beam_run",
        limit: 5,
        threshold: 0,
        searchMode: "hybrid",
        include: { documents: true },
        rerank: false,
        rewriteQuery: false,
      },
    ])
    expect(searchCalls[0]).not.toHaveProperty("include.chunks")
    expect(results).toHaveLength(1)
    expect(response.diagnostics).toEqual({
      requestedLimit: 5,
      providerRequests: [
        {
          operation: "search.hybrid",
          limit: 5,
          parameters: {
            searchMode: "hybrid",
            threshold: 0,
            includeDocuments: true,
            includeChunks: false,
            rerank: false,
            rewriteQuery: false,
          },
        },
      ],
      rawReturnedCount: 1,
      normalizedCount: 1,
      droppedCount: 0,
      droppedResults: [],
    })
  })

  test("requests immediate dreaming for a causal ingestion barrier", async () => {
    const addCalls: unknown[] = []
    const provider = new SupermemoryProvider()
    const fakeClient = {
      add: async (request: unknown) => {
        addCalls.push(request)
        return { id: "document-1", status: "queued" }
      },
    }
    ;(provider as unknown as { client: typeof fakeClient }).client = fakeClient

    await provider.ingest([DOCUMENT], {
      containerTag: "beam_run",
      processingMode: "instant",
    })

    expect(addCalls).toEqual([
      {
        content: DOCUMENT.content,
        containerTag: "beam_run",
        customId: DOCUMENT.customId,
        metadata: DOCUMENT.metadata,
        dreaming: "instant",
      },
    ])
  })

  test("uses the V3 batch endpoint for multiple ordered sessions", async () => {
    const calls: Array<{ body: unknown; options: unknown }> = []
    const provider = new SupermemoryProvider()
    const fakeClient = {
      documents: {
        batchAdd: async (body: unknown, options: unknown) => {
          calls.push({ body, options })
          return {
            results: [
              { id: "document-1", status: "queued" },
              { id: "document-2", status: "queued" },
            ],
            failed: 0,
            success: 2,
          }
        },
      },
    }
    ;(provider as unknown as { client: typeof fakeClient }).client = fakeClient
    const second: CanonicalIngestionDocument = {
      ...DOCUMENT,
      customId: "session-2",
      content: "DOCUMENT_DATE: 2025-03-15T10:00:00Z\n\nUSER: I moved again.\nASSISTANT: Got it.",
      metadata: {
        sessionId: "session-2",
        documentDate: "2025-03-15T10:00:00Z",
      },
    }

    const result = await provider.ingest([DOCUMENT, second], {
      containerTag: "beam_run",
      processingMode: "instant",
    })

    expect(result.documentIds).toEqual(["document-1", "document-2"])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.body).toEqual({
      documents: [
        {
          content: DOCUMENT.content,
          customId: DOCUMENT.customId,
          metadata: DOCUMENT.metadata,
        },
        {
          content: second.content,
          customId: second.customId,
          metadata: second.metadata,
        },
      ],
      containerTag: "beam_run",
      dreaming: "instant",
    })
    expect(calls[0]?.options).toMatchObject({ idempotencyKey: expect.any(String) })
  })

  test("preserves successful batch items and attributes validation failures by custom ID", async () => {
    const provider = new SupermemoryProvider()
    const fakeClient = {
      documents: {
        batchAdd: async () => ({
          results: [
            { id: "document-1", status: "queued" },
            { id: "document-3", status: "queued" },
            { id: "session-2", status: "error", error: "invalid document" },
          ],
          failed: 1,
          success: 2,
        }),
      },
    }
    ;(provider as unknown as { client: typeof fakeClient }).client = fakeClient

    const result = await provider.ingest(
      [DOCUMENT, { ...DOCUMENT, customId: "session-2" }, { ...DOCUMENT, customId: "session-3" }],
      {
        containerTag: "beam_run",
        processingMode: "instant",
      }
    )

    expect(result).toEqual({
      documentIds: ["document-1", "document-3"],
      items: [
        { customId: "session-1", documentIds: ["document-1"] },
        { customId: "session-2", documentIds: [], error: "invalid document" },
        { customId: "session-3", documentIds: ["document-3"] },
      ],
    })
  })

  test("fails closed when the backend exceeds the requested evidence budget", () => {
    expect(() =>
      normalizeSupermemorySearchResults(
        [
          { id: "one", memory: "one", similarity: 1 },
          { id: "two", memory: "two", similarity: 0.9 },
        ],
        1
      )
    ).toThrow("returned 2 results for requested Top-K 1")
  })

  test("propagates every supported BEAM ablation Top-K unchanged", async () => {
    const requestLimits: number[] = []
    const provider = new SupermemoryProvider()
    const fakeClient = {
      search: {
        memories: async (request: { limit: number }) => {
          requestLimits.push(request.limit)
          return { results: [] }
        },
      },
    }
    ;(provider as unknown as { client: typeof fakeClient }).client = fakeClient

    for (const limit of [5, 10, 15, 20]) {
      const response = await provider.search("query", {
        containerTag: "beam_run",
        limit,
        threshold: 0,
      })
      expect(response.diagnostics.requestedLimit).toBe(limit)
      expect(response.diagnostics.providerRequests.map((request) => request.limit)).toEqual([limit])
    }

    expect(requestLimits).toEqual([5, 10, 15, 20])
  })
})

describe("Mem0 normalization", () => {
  test("supports direct and nested v1.1 result shapes", () => {
    const results = normalizeMem0SearchResults(
      [
        {
          id: "memory-1",
          memory: "Direct memory",
          score: 0.8,
          metadata: { sessionId: "session-1", documentDate: "2025-01-01" },
        },
        {
          data: {
            id: "memory-2",
            memory: "Nested memory",
            score: 0.7,
            metadata: { sessionId: "session-2", documentDate: "2025-01-02" },
          },
        },
      ],
      2
    )

    expect(
      results.map(({ id, rank, text, score, sessionId, documentDate }) => ({
        id,
        rank,
        text,
        score,
        sessionId,
        documentDate,
      }))
    ).toEqual([
      {
        id: "memory-1",
        rank: 1,
        text: "Direct memory",
        score: 0.8,
        sessionId: "session-1",
        documentDate: "2025-01-01",
      },
      {
        id: "memory-2",
        rank: 2,
        text: "Nested memory",
        score: 0.7,
        sessionId: "session-2",
        documentDate: "2025-01-02",
      },
    ])
  })

  test("reconciles by deterministic run_id before adding and uses synchronous ingestion", async () => {
    const addCalls: Array<{ messages: unknown; options: Record<string, unknown> }> = []
    let stored = false
    const provider = new Mem0Provider()
    const fakeClient = {
      getAll: async (options: Record<string, unknown>) =>
        stored ? [{ id: "memory-1", metadata: DOCUMENT.metadata, run_id: options.run_id }] : [],
      add: async (messages: unknown, options: Record<string, unknown>) => {
        addCalls.push({ messages, options })
        stored = true
        return [{ id: "memory-1" }]
      },
    }
    ;(provider as unknown as { client: typeof fakeClient }).client = fakeClient

    const first = await provider.ingest([DOCUMENT], { containerTag: "beam_run" })
    const resumed = await provider.ingest([DOCUMENT], { containerTag: "beam_run" })

    expect(first.documentIds).toEqual(["memory-1"])
    expect(resumed.documentIds).toEqual(["memory-1"])
    expect(addCalls).toHaveLength(1)
    expect(addCalls[0].options).toMatchObject({
      user_id: "beam_run",
      run_id: DOCUMENT.customId,
      async_mode: false,
      enable_graph: false,
    })
    expect(addCalls[0].messages).toEqual(DOCUMENT.messages)

    let progress: unknown
    await provider.awaitIndexing(first, "beam_run", (value) => {
      progress = value
    })
    expect(progress).toEqual({
      completedIds: ["memory-1"],
      failedIds: [],
      total: 1,
    })
  })
})

describe("Zep normalization and shared retrieval budget", () => {
  test("splits one total Top-K budget between edges and nodes", () => {
    for (const limit of [1, 5, 10, 20]) {
      const budget = allocateZepSearchBudget(limit)
      expect(budget.edgeLimit + budget.nodeLimit).toBe(limit)
    }
    expect(allocateZepSearchBudget(5)).toEqual({ edgeLimit: 3, nodeLimit: 2 })
  })

  test("fails closed when ontology setup fails and retries setup on the next ingest", async () => {
    let ontologyAttempts = 0
    let addAttempts = 0
    const provider = new ZepProvider()
    const fakeClient = {
      graph: {
        create: async () => ({}),
        setOntology: async () => {
          ontologyAttempts++
          if (ontologyAttempts === 1) throw new Error("ontology unavailable")
          return {}
        },
        episode: {
          getByGraphId: async () => ({ episodes: [] }),
        },
        add: async () => {
          addAttempts++
          return { uuid: "episode-1" }
        },
      },
    }
    ;(provider as unknown as { client: typeof fakeClient }).client = fakeClient

    await expect(provider.ingest([DOCUMENT], { containerTag: "beam_run" })).rejects.toThrow(
      "ontology unavailable"
    )
    expect(ontologyAttempts).toBe(1)
    expect(addAttempts).toBe(0)

    const retried = await provider.ingest([DOCUMENT], { containerTag: "beam_run" })

    expect(retried.documentIds).toEqual(["episode-1"])
    expect(ontologyAttempts).toBe(2)
    expect(addAttempts).toBe(1)
  })

  test("reconciles deterministic episodes and preserves canonical transcript order", async () => {
    const episodes: Array<{
      uuid: string
      sourceDescription: string
      content: string
      processed: boolean
      createdAt: string
    }> = []
    const addCalls: unknown[] = []
    const provider = new ZepProvider()
    const fakeClient = {
      graph: {
        create: async () => ({}),
        setOntology: async () => ({}),
        episode: {
          getByGraphId: async () => ({ episodes }),
          get: async (uuid: string) => episodes.find((episode) => episode.uuid === uuid)!,
        },
        add: async (request: { data: string; sourceDescription: string; createdAt: string }) => {
          addCalls.push(request)
          const episode = {
            uuid: `episode-${episodes.length + 1}`,
            sourceDescription: request.sourceDescription,
            content: request.data,
            processed: true,
            createdAt: request.createdAt,
          }
          episodes.push(episode)
          return episode
        },
      },
      task: { get: async () => ({ status: "completed" }) },
    }
    ;(provider as unknown as { client: typeof fakeClient }).client = fakeClient

    const first = await provider.ingest([DOCUMENT], { containerTag: "beam_run" })
    const resumed = await provider.ingest([DOCUMENT], { containerTag: "beam_run" })

    expect(first.documentIds).toEqual(["episode-1"])
    expect(resumed.documentIds).toEqual(["episode-1"])
    expect(addCalls).toHaveLength(1)
    expect(addCalls[0]).toMatchObject({
      data: DOCUMENT.content,
      sourceDescription: `memorybench:${DOCUMENT.customId}:1/1`,
      createdAt: "2025-03-14T10:00:00Z",
    })

    let progress: unknown
    await provider.awaitIndexing(first, "beam_run", (value) => {
      progress = value
    })
    expect(progress).toEqual({
      completedIds: ["episode-1"],
      failedIds: [],
      total: 1,
    })
  })

  test("requests at most K combined graph results and normalizes both types", async () => {
    const searchCalls: Array<{ limit: number; scope: string }> = []
    const provider = new ZepProvider()
    const fakeClient = {
      graph: {
        search: async (request: { limit: number; scope: string }) => {
          searchCalls.push(request)
          if (request.scope === "edges") {
            return {
              edges: Array.from({ length: request.limit }, (_, index) => ({
                uuid: `edge-${index}`,
                fact: `Fact ${index}`,
                relevance: 0.9 - index * 0.1,
              })),
            }
          }
          return {
            nodes: Array.from({ length: request.limit }, (_, index) => ({
              uuid: `node-${index}`,
              name: `Entity ${index}`,
              summary: `Summary ${index}`,
              relevance: 0.6 - index * 0.1,
            })),
          }
        },
      },
    }
    const internals = provider as unknown as {
      client: typeof fakeClient
      graphIds: Map<string, string>
    }
    internals.client = fakeClient
    internals.graphIds.set("beam_run", "memorybench_beam_run")

    const response = await provider.search("query", { containerTag: "beam_run", limit: 5 })
    const results = response.results

    expect(searchCalls.map(({ limit, scope }) => ({ limit, scope }))).toEqual([
      { limit: 3, scope: "edges" },
      { limit: 2, scope: "nodes" },
    ])
    expect(results).toHaveLength(5)
    expect(results.map((result) => result.rank)).toEqual([1, 2, 3, 4, 5])
    expect(new Set(results.map((result) => result.resultType))).toEqual(
      new Set(["graph-edge", "graph-node"])
    )
    expect(response.diagnostics.providerRequests).toEqual([
      {
        operation: "graph.edges",
        limit: 3,
        parameters: { scope: "edges", reranker: "cross_encoder" },
      },
      {
        operation: "graph.nodes",
        limit: 2,
        parameters: { scope: "nodes", reranker: "cross_encoder" },
      },
    ])
  })

  test("orders mixed graph evidence by the common score", () => {
    const results = normalizeZepSearchResults(
      [
        { _type: "node", uuid: "node-1", name: "Vedant", summary: "Lives in Pune", relevance: 0.7 },
        { _type: "edge", uuid: "edge-1", fact: "Vedant moved to Pune", relevance: 0.9 },
      ],
      2
    )
    expect(results.map((result) => result.id)).toEqual(["edge-1", "node-1"])
    expect(results.map((result) => result.score)).toEqual([0.9, 0.7])
  })
})

describe("local provider normalization", () => {
  test("filesystem preserves canonical session and document date", () => {
    expect(
      normalizeFilesystemSearchResults(
        [
          {
            id: "document-1",
            sessionId: "session-1",
            content: "Stored memory",
            score: 0.75,
            documentDate: "2025-02-01T12:00:00Z",
          },
        ],
        1
      )
    ).toEqual([
      {
        id: "document-1",
        rank: 1,
        text: "Stored memory",
        score: 0.75,
        sessionId: "session-1",
        documentDate: "2025-02-01T12:00:00Z",
        provider: "filesystem",
        resultType: "document",
      },
    ])
  })

  test("RAG preserves exact dates and omits fake unknown dates", () => {
    const base = {
      vectorScore: 0.8,
      bm25Score: 0.7,
      chunkIndex: 0,
    }
    const results = normalizeRagSearchResults(
      [
        {
          ...base,
          id: "chunk-1",
          content: "Dated chunk",
          score: 0.9,
          sessionId: "session-1",
          date: "2025-03-14T10:00:00Z",
        },
        {
          ...base,
          id: "chunk-2",
          content: "Undated chunk",
          score: 0.8,
          sessionId: "session-2",
          date: "unknown",
        },
      ],
      2
    )

    expect(results[0].documentDate).toBe("2025-03-14T10:00:00Z")
    expect(results[1]).not.toHaveProperty("documentDate")
    expect(results).toHaveLength(2)
  })

  test("RAG persists reusable indexes and deterministic chunk retries are idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "memorybench-rag-index-"))
    const containerTag = "mb:durable-rag"
    const initial: Chunk = {
      id: "chunk-1",
      content: "Vedant moved to Pune",
      sessionId: "session-1",
      chunkIndex: 0,
      embedding: [1, 0],
      date: "2025-03-14",
      metadata: { documentDate: "2025-03-14" },
    }
    try {
      const firstProcess = new HybridSearchEngine()
      firstProcess.addChunks(containerTag, [initial])
      await persistRagChunks(root, containerTag, firstProcess.getChunks(containerTag))

      const persisted = await loadPersistedRagChunks(root, containerTag)
      expect(persisted).toEqual([initial])
      const resumedProcess = new HybridSearchEngine()
      resumedProcess.replaceChunks(containerTag, persisted!)
      resumedProcess.addChunks(containerTag, [{ ...initial, content: "Vedant moved to Mumbai" }])

      expect(resumedProcess.getChunkCount(containerTag)).toBe(1)
      expect(resumedProcess.search(containerTag, [1, 0], "Mumbai", 5)).toHaveLength(1)
      expect(resumedProcess.getChunks(containerTag)[0].content).toBe("Vedant moved to Mumbai")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("provider prompt safety", () => {
  test("renders only normalized evidence fields and never stringifies raw payloads", () => {
    const evidence = [
      {
        id: "result-1",
        rank: 1,
        text: "Safe normalized evidence",
        score: 0.9,
        sessionId: "session-1",
        documentDate: "2025-03-14",
        provider: "supermemory",
        resultType: "memory",
        rawPayload: { secret: "RAW_DEBUG_PAYLOAD_MUST_NOT_LEAK" },
      },
    ]
    const prompts = [
      buildSupermemoryAnswerPrompt("Question?", evidence),
      buildMem0AnswerPrompt("Question?", evidence),
      buildZepAnswerPrompt("Question?", evidence),
      buildFilesystemAnswerPrompt("Question?", evidence),
      buildRAGAnswerPrompt("Question?", evidence),
    ]

    for (const prompt of prompts) {
      expect(prompt).toContain("Safe normalized evidence")
      expect(prompt).not.toContain("RAW_DEBUG_PAYLOAD_MUST_NOT_LEAK")
    }
  })
})
