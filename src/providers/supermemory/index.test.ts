import { afterEach, expect, mock, spyOn, test } from "bun:test"
import type { IndexingProgress } from "../../types/provider"
import { SupermemoryProvider } from "./index"

const http: { fetch: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> } = globalThis

afterEach(() => mock.restore())

async function providerWithTimeout(indexingTimeoutMs: number): Promise<SupermemoryProvider> {
  const provider = new SupermemoryProvider()
  await provider.initialize({ apiKey: "test-key", indexingTimeoutMs })
  return provider
}

test("aborts an in-flight indexing request at the deadline", async () => {
  const provider = await providerWithTimeout(50)
  let requestSignal: AbortSignal | null | undefined
  spyOn(http, "fetch").mockImplementation((_input, init) => {
    requestSignal = init?.signal
    return new Promise((resolve, reject) => {
      const fallback = setTimeout(
        () => resolve(Response.json({ system: { status: "done" }, dreamingStatus: "done" })),
        250
      )
      requestSignal?.addEventListener(
        "abort",
        () => {
          clearTimeout(fallback)
          reject(requestSignal?.reason)
        },
        { once: true }
      )
    })
  })

  await expect(provider.awaitIndexing({ documentIds: ["stalled"] }, "test")).rejects.toThrow(
    "Indexing timed out after 50ms in namespace test. Pending documents: stalled"
  )
  expect(requestSignal?.aborted).toBe(true)
}, 1000)

test("times out while a document stays queued", async () => {
  const provider = await providerWithTimeout(100)
  const fetchMock = spyOn(http, "fetch").mockImplementation(async () =>
    Response.json({ system: { status: "queued" } })
  )

  await expect(provider.awaitIndexing({ documentIds: ["queued"] }, "test")).rejects.toThrow(
    "Indexing timed out after 100ms in namespace test. Pending documents: queued"
  )
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test("the indexing deadline interrupts a rate-limit retry delay", async () => {
  const provider = await providerWithTimeout(100)
  const fetchMock = spyOn(http, "fetch").mockImplementation(
    async () => new Response("Too many requests", { status: 429, headers: { "Retry-After": "10" } })
  )

  await expect(provider.awaitIndexing({ documentIds: ["rate-limited"] }, "test")).rejects.toThrow(
    "Indexing timed out after 100ms in namespace test. Pending documents: rate-limited"
  )
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test("reports completed documents and surfaces repeated status errors", async () => {
  const provider = await providerWithTimeout(10000)
  const progress: IndexingProgress[] = []
  let failedChecks = 0
  spyOn(http, "fetch").mockImplementation(async (input) => {
    const url = String(input)
    if (url.endsWith("/inaccessible")) {
      failedChecks++
      return new Response("Unauthorized", { status: 401 })
    }
    if (url.includes("/v3/documents/")) return Response.json({ dreamingStatus: "done" })
    return Response.json({ system: { status: "done" } })
  })

  await expect(
    provider.awaitIndexing({ documentIds: ["ready", "inaccessible"] }, "test", (update) => {
      progress.push(update)
    })
  ).rejects.toThrow("Indexing status for document inaccessible in namespace test failed 3 times")
  expect(failedChecks).toBe(3)
  expect(progress.at(-1)).toEqual({
    completedIds: ["ready"],
    failedIds: ["inaccessible"],
    total: 2,
  })
}, 8000)
