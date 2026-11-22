import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { RAGProvider } from "./index"
import { HybridSearchEngine } from "./search"

const http: { fetch: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> } = globalThis

afterEach(() => mock.restore())

test("rejects a resumed search with a lost index before requesting an embedding", async () => {
  const provider = new RAGProvider()
  await provider.initialize({ apiKey: "test-key" })
  const fetchMock = spyOn(http, "fetch").mockImplementation(async () =>
    Response.json({ error: { message: "Unexpected embedding request" } }, { status: 400 })
  )

  await expect(
    provider.search("Example", { containerTag: "saved-run", expectedDocumentIds: ["saved-chunk"] })
  ).rejects.toThrow("missing documents recorded in the checkpoint")
  expect(fetchMock).not.toHaveBeenCalled()
})

test("a legitimately empty haystack still yields no search results", async () => {
  const provider = new RAGProvider()
  await provider.initialize({ apiKey: "test-key" })
  const fetchMock = spyOn(http, "fetch").mockImplementation(async () =>
    Response.json({ error: { message: "Unexpected embedding request" } }, { status: 400 })
  )

  await expect(
    provider.search("Example", { containerTag: "empty", expectedDocumentIds: [] })
  ).resolves.toEqual([])
  expect(fetchMock).not.toHaveBeenCalled()
})

test("only a complete local index satisfies the checkpoint", () => {
  const engine = new HybridSearchEngine()
  engine.addChunks("run", [
    {
      id: "present",
      content: "Example",
      sessionId: "session",
      chunkIndex: 0,
      embedding: [1],
      date: "2026-01-01",
    },
  ])
  expect(engine.hasChunks("run", ["present"])).toBe(true)
  expect(engine.hasChunks("run", ["present", "missing"])).toBe(false)
})
