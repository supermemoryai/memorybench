import { describe, expect, test } from "bun:test"
import { SupermemoryProvider, classifySupermemoryReadiness } from "../src/providers/supermemory"
import { ZepProvider } from "../src/providers/zep"
import { HybridSearchEngine, type Chunk } from "../src/providers/rag/search"

function chunk(id: string, sessionId: string, chunkIndex: number, content: string): Chunk {
  return {
    id,
    sessionId,
    chunkIndex,
    content,
    embedding: [1, 0],
  }
}

describe("provider build lifecycle safety", () => {
  test("RAG retry replaces a complete session and removes stale trailing chunks", () => {
    const engine = new HybridSearchEngine()
    engine.addChunks("container", [
      chunk("session-1-0", "session-1", 0, "old zero"),
      chunk("session-1-1", "session-1", 1, "stale trailing chunk"),
      chunk("session-2-0", "session-2", 0, "unrelated session"),
    ])

    engine.replaceSessionChunks(
      "container",
      ["session-1"],
      [chunk("session-1-0", "session-1", 0, "new only chunk")]
    )

    expect(engine.getChunks("container").map(({ id, content }) => ({ id, content }))).toEqual([
      { id: "session-2-0", content: "unrelated session" },
      { id: "session-1-0", content: "new only chunk" },
    ])
  })

  test("Supermemory indexing has a bounded timeout", async () => {
    const provider = new SupermemoryProvider(0)
    ;(provider as unknown as { client: object }).client = {}

    await expect(
      provider.awaitIndexing({ documentIds: ["document-1"] }, "container")
    ).rejects.toThrow("Supermemory indexing timed out")
  })

  test("Supermemory indexing times out when an SDK polling request hangs", async () => {
    const provider = new SupermemoryProvider(20)
    ;(
      provider as unknown as {
        client: {
          documents: { get: () => Promise<never> }
        }
      }
    ).client = {
      documents: { get: () => new Promise<never>(() => {}) },
    }

    await expect(
      provider.awaitIndexing({ documentIds: ["document-1"] }, "container")
    ).rejects.toThrow("Supermemory indexing timed out")
  })

  test("Supermemory readiness requires both document processing and dreaming", () => {
    expect(classifySupermemoryReadiness({ status: "queued" })).toBe("pending")
    expect(classifySupermemoryReadiness({ status: "done" })).toBe("pending")
    expect(classifySupermemoryReadiness({ status: "done", dreamingStatus: "dreaming" })).toBe(
      "pending"
    )
    expect(classifySupermemoryReadiness({ status: "done", dreamingStatus: "done" })).toBe(
      "completed"
    )
    expect(classifySupermemoryReadiness({ status: "failed", dreamingStatus: "done" })).toBe(
      "failed"
    )
  })

  test("Supermemory polls one document endpoint until dreaming is complete", async () => {
    const responses = [
      { status: "done", dreamingStatus: "dreaming" },
      { status: "done", dreamingStatus: "done" },
    ]
    const documentGetCalls: string[] = []
    const provider = new SupermemoryProvider(100, 0)
    ;(
      provider as unknown as {
        client: { documents: { get: (id: string) => Promise<(typeof responses)[number]> } }
      }
    ).client = {
      documents: {
        get: async (id: string) => {
          documentGetCalls.push(id)
          return responses.shift() ?? { status: "done", dreamingStatus: "done" }
        },
      },
    }

    let finalProgress: unknown
    await provider.awaitIndexing({ documentIds: ["document-1"] }, "container", (progress) => {
      finalProgress = progress
    })

    expect(documentGetCalls).toEqual(["document-1", "document-1"])
    expect(finalProgress).toEqual({
      completedIds: ["document-1"],
      failedIds: [],
      total: 1,
    })
  })

  test("Zep indexing has a bounded timeout", async () => {
    const provider = new ZepProvider(0)
    ;(provider as unknown as { client: object }).client = {}

    await expect(
      provider.awaitIndexing({ documentIds: ["episode-1"] }, "container")
    ).rejects.toThrow("Zep indexing timed out")
  })

  test("Zep indexing times out when an SDK polling request hangs", async () => {
    const provider = new ZepProvider(20)
    ;(
      provider as unknown as {
        client: {
          task: { get: () => Promise<never> }
          graph: { episode: { get: () => Promise<never> } }
        }
      }
    ).client = {
      task: { get: () => new Promise<never>(() => {}) },
      graph: { episode: { get: () => new Promise<never>(() => {}) } },
    }

    await expect(
      provider.awaitIndexing({ documentIds: ["episode-1"] }, "container")
    ).rejects.toThrow("Zep indexing timed out")
  })

  test("provider build fingerprints are deterministic and include non-secret configuration", () => {
    const defaultSupermemory = new SupermemoryProvider().getIngestionConfigFingerprint({
      apiKey: "ignored-secret-a",
      baseUrl: "https://api.supermemory.ai",
    })
    const samePublicConfig = new SupermemoryProvider().getIngestionConfigFingerprint({
      apiKey: "ignored-secret-b",
      baseUrl: "https://api.supermemory.ai",
    })
    const differentEndpoint = new SupermemoryProvider().getIngestionConfigFingerprint({
      apiKey: "ignored-secret-a",
      baseUrl: "https://staging.example.test",
    })

    expect(samePublicConfig).toBe(defaultSupermemory)
    expect(differentEndpoint).not.toBe(defaultSupermemory)
    expect(new ZepProvider().getIngestionConfigFingerprint({ apiKey: "secret" })).toMatch(
      /^[a-f0-9]{64}$/
    )
  })
})
