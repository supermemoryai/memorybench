import { describe, expect, test } from "bun:test"
import { HybridSearchEngine, type Chunk } from "./search"

function chunk(id: string, sessionId: string, content = "same memory"): Chunk {
  return {
    id,
    sessionId,
    chunkIndex: 0,
    content,
    embedding: [1, 0],
  }
}

describe("durable RAG search index primitives", () => {
  test("deterministic upserts do not duplicate BM25 documents", () => {
    const engine = new HybridSearchEngine()
    engine.addChunks("build", [chunk("b", "session-b"), chunk("a", "session-a")])
    engine.addChunks("build", [chunk("a", "session-a", "same memory updated")])
    expect(engine.getChunkCount("build")).toBe(2)
    expect(engine.getChunks("build").find((item) => item.id === "a")?.content).toBe(
      "same memory updated"
    )
  })

  test("session replacement removes stale chunk ordinals and ties break by chunk ID", () => {
    const engine = new HybridSearchEngine()
    engine.addChunks("build", [
      { ...chunk("b", "session-1"), chunkIndex: 1 },
      chunk("a", "session-1"),
    ])
    expect(engine.search("build", [1, 0], "same", 2).map((item) => item.sessionId)).toEqual([
      "session-1",
      "session-1",
    ])
    engine.removeSessions("build", ["session-1"])
    engine.addChunks("build", [chunk("a", "session-1", "replacement")])
    expect(engine.getChunks("build").map((item) => item.id)).toEqual(["a"])
  })
})
