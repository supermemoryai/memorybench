import { describe, expect, test } from "bun:test"
import { HybridSearchEngine, type Chunk } from "./search"

const CONTAINER = "test_container"

function makeChunk(id: string, content: string, embedding: number[]): Chunk {
  return {
    id,
    content,
    sessionId: id,
    chunkIndex: 0,
    embedding,
  }
}

// Deliberately uneven document lengths and term frequencies: avgDocLength and
// idf both have to be wrong for these scores to move.
const CHUNKS: Chunk[] = [
  makeChunk("c1", "quantum telescope", [1, 0, 0]),
  makeChunk(
    "c2",
    "harvest orbital drift sensor array calibration payload module thermal shielding harvest harvest",
    [0, 1, 0]
  ),
  makeChunk("c3", "harvest sensor", [0, 0, 1]),
]

const QUERY = "quantum harvest"
const QUERY_EMBEDDING = [0.5, 0.5, 0.5]

describe("HybridSearchEngine BM25 indexing", () => {
  test("re-ingesting the same chunks does not change search scores", () => {
    const fresh = new HybridSearchEngine()
    fresh.addChunks(CONTAINER, CHUNKS)

    const reingested = new HybridSearchEngine()
    reingested.addChunks(CONTAINER, CHUNKS)
    reingested.addChunks(CONTAINER, CHUNKS)

    expect(reingested.getChunkCount(CONTAINER)).toBe(CHUNKS.length)
    expect(reingested.search(CONTAINER, QUERY_EMBEDDING, QUERY, 10)).toEqual(
      fresh.search(CONTAINER, QUERY_EMBEDDING, QUERY, 10)
    )
  })

  test("re-indexing a chunk with new content drops its old terms", () => {
    const engine = new HybridSearchEngine()
    engine.addChunks(CONTAINER, [
      makeChunk("c1", "telescope calibration", [1, 0, 0]),
      makeChunk("c2", "telescope beacon", [0, 1, 0]),
    ])

    // Same chunk ID, different content — as produced by a forced re-ingest.
    engine.addChunks(CONTAINER, [makeChunk("c1", "harvest orbital", [1, 0, 0])])

    const results = engine.search(CONTAINER, [1, 1, 0], "telescope", 10)
    const c1 = results.find((r) => r.content === "harvest orbital")
    const c2 = results.find((r) => r.content === "telescope beacon")

    expect(c1).toBeDefined()
    expect(c2).toBeDefined()
    expect(c1!.bm25Score).toBe(0)
    expect(c2!.bm25Score).toBeGreaterThan(0)
  })

  test("scores match a freshly built index after content is replaced", () => {
    const replaced = new HybridSearchEngine()
    replaced.addChunks(CONTAINER, [makeChunk("c1", "telescope calibration payload", [1, 0, 0])])
    replaced.addChunks(CONTAINER, CHUNKS)

    const fresh = new HybridSearchEngine()
    fresh.addChunks(CONTAINER, CHUNKS)

    expect(replaced.search(CONTAINER, QUERY_EMBEDDING, QUERY, 10)).toEqual(
      fresh.search(CONTAINER, QUERY_EMBEDDING, QUERY, 10)
    )
  })
})
