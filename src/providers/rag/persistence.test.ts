import { test, expect } from "bun:test"
import { serializeChunks, parseCachedChunks, RAGProvider } from "./index"
import { HybridSearchEngine } from "./search"
import type { Chunk } from "./search"

// The bug this guards: ingest built the index in process memory only, while the checkpoint
// recorded ingest/indexing as completed. A resumed run skipped both phases, searched an empty
// index, recorded zero results as a *successful* search, and published ~0% accuracy.

function chunk(id: string, content: string, embedding: number[]): Chunk {
  return { id, content, sessionId: `s-${id}`, chunkIndex: 0, embedding, date: "2026-01-01" }
}

const CHUNKS: Chunk[] = [
  chunk("c1", "Ada adopted a tabby cat called Mochi", [1, 0, 0]),
  chunk("c2", "Ada moved to Lisbon in March", [0, 1, 0]),
  chunk("c3", "Grace prefers oat milk in her coffee", [0, 0, 1]),
]

test("chunks survive a serialize/parse round trip through the cache", () => {
  const restored = parseCachedChunks(serializeChunks(CHUNKS))

  expect(restored).toHaveLength(CHUNKS.length)
  for (const [i, original] of CHUNKS.entries()) {
    expect(restored[i].id).toBe(original.id)
    expect(restored[i].content).toBe(original.content)
    expect(restored[i].sessionId).toBe(original.sessionId)
    expect(restored[i].date).toBe(original.date)
    expect(restored[i].embedding).toEqual(original.embedding)
  }
})

test("float32 storage preserves embeddings closely enough not to change ranking", () => {
  const precise = chunk("c9", "text", [0.1234567, -0.7654321, 0.000123456])
  const [restored] = parseCachedChunks(serializeChunks([precise]))

  for (const [i, value] of precise.embedding.entries()) {
    expect(restored.embedding[i]).toBeCloseTo(value, 6)
  }
})

test("a restored index returns the same results as the index that ingested them", () => {
  // Simulates the process boundary: one engine ingests, a fresh one only ever sees the cache.
  const ingesting = new HybridSearchEngine()
  ingesting.addChunks("q1-run-1", CHUNKS)

  const resumed = new HybridSearchEngine()
  resumed.addChunks("q1-run-1", parseCachedChunks(serializeChunks(CHUNKS)))

  const query = [0, 1, 0] // matches c2
  const before = ingesting.search("q1-run-1", query, "where did Ada move", 10)
  const after = resumed.search("q1-run-1", query, "where did Ada move", 10)

  expect(after).toHaveLength(before.length)
  expect(after.map((r) => r.content)).toEqual(before.map((r) => r.content))
  expect(after[0].content).toBe("Ada moved to Lisbon in March")
  // The regression: a resumed run used to see nothing at all.
  expect(after.length).toBeGreaterThan(0)
})

test("a line truncated by a killed process does not discard the rest of the cache", () => {
  const raw = serializeChunks(CHUNKS)
  const truncated = raw.slice(0, raw.length - 20) // cut the final line mid-JSON

  const restored = parseCachedChunks(truncated)

  expect(restored.map((c) => c.id)).toEqual(["c1", "c2"])
})

test("searching a container with no cache fails loudly instead of returning nothing", async () => {
  // The original failure mode: search returned [], the phase recorded "completed" with zero
  // results, and the run published a fabricated ~0% score. Now it raises, so the search phase
  // marks the question failed with an actionable message and a resume can retry it.
  const provider = new RAGProvider()
  await provider.initialize({ apiKey: "sk-not-used-no-request-is-made" })

  await expect(
    provider.search("anything", { containerTag: "q-never-ingested-a1b2c3d4", limit: 10 })
  ).rejects.toThrow(/No ingested data/)
})

test("duplicate appends from a re-ingest are collapsed", () => {
  // Chunk IDs are deterministic, and the BM25 index counts every add, so replaying a
  // duplicate would skew IDF and document-length normalisation for the whole container.
  const restored = parseCachedChunks(serializeChunks(CHUNKS) + serializeChunks(CHUNKS))

  expect(restored.map((c) => c.id)).toEqual(["c1", "c2", "c3"])
})
