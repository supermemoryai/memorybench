import { describe, expect, test } from "bun:test"
import { chunkText } from "./index"

const CHUNK_SIZE = 1600
const CHUNK_OVERLAP = 320

// Every test that calls chunkText on unbreakable input gets an explicit timeout:
// before the forward-progress fix these spin forever rather than failing.
const HANG_TIMEOUT_MS = 5000

/** A long unbroken token — a URL, base64 blob or minified payload — after one early space. */
const UNBREAKABLE = "x".repeat(10) + " " + "a".repeat(5000)

describe("chunkText", () => {
  test("returns the whole text as one chunk when it fits", () => {
    expect(chunkText("a short memory")).toEqual(["a short memory"])
  })

  test(
    "terminates on text whose only break lies within the overlap of start",
    () => {
      const chunks = chunkText(UNBREAKABLE)

      expect(chunks.length).toBeGreaterThan(0)
      expect(chunks.length).toBeLessThan(20)
    },
    HANG_TIMEOUT_MS
  )

  test(
    "emits full-size chunks rather than slivers when no break point qualifies",
    () => {
      const chunks = chunkText(UNBREAKABLE)

      // Every chunk but the last should be a genuine chunk, not an 11-character
      // sliver cut at the single early space.
      for (const chunk of chunks.slice(0, -1)) {
        expect(chunk.length).toBeGreaterThan(CHUNK_SIZE * 0.5)
      }
    },
    HANG_TIMEOUT_MS
  )

  test(
    "covers the whole input when no break point qualifies",
    () => {
      const chunks = chunkText(UNBREAKABLE)

      // Chunks overlap, so concatenating them is longer than the input; what
      // matters is that no region of the source is skipped.
      expect(chunks.join("")).toContain("a".repeat(4000))
      expect(chunks[0]).toStartWith("xxxxxxxxxx")
      expect(chunks[chunks.length - 1]).toEndWith("a")
    },
    HANG_TIMEOUT_MS
  )

  test(
    "terminates when the caller's overlap is larger than the chunk step",
    () => {
      const chunks = chunkText("word ".repeat(500), 100, 90)

      expect(chunks.length).toBeGreaterThan(0)
    },
    HANG_TIMEOUT_MS
  )

  test("still breaks long prose on sentence boundaries", () => {
    const sentence = "The orbital sensor array reported a thermal anomaly. "
    const chunks = chunkText(sentence.repeat(100))

    expect(chunks.length).toBeGreaterThan(1)
    // The first break should land on a sentence end, not a hard cut at CHUNK_SIZE.
    expect(chunks[0]).toEndWith("anomaly.")
    expect(chunks[0].length).toBeLessThanOrEqual(CHUNK_SIZE + 1)
  })

  test("keeps overlapping context between consecutive chunks", () => {
    const sentence = "The orbital sensor array reported a thermal anomaly. "
    const chunks = chunkText(sentence.repeat(100))

    // The tail of chunk 0 should reappear at the head of chunk 1.
    const tail = chunks[0].slice(-(CHUNK_OVERLAP / 2))
    expect(chunks[1]).toContain(tail)
  })

  test("never emits an empty chunk", () => {
    for (const chunk of chunkText(UNBREAKABLE)) {
      expect(chunk.length).toBeGreaterThan(0)
    }
  })
})
