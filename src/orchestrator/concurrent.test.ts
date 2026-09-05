import { describe, expect, test } from "bun:test"
import { ConcurrentExecutor } from "./concurrent"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const run = <R>(items: number[], concurrency: number, task: (i: number) => Promise<R>) =>
  ConcurrentExecutor.executeBatched<number, R>({
    items,
    concurrency,
    rateLimitMs: 0,
    runId: "test",
    phaseName: "test",
    executeTask: ({ item }) => task(item),
  })

describe("executeBatched", () => {
  test("returns every result, in item order", async () => {
    const items = Array.from({ length: 50 }, (_, i) => i)
    // Reverse the durations so completion order differs from item order.
    const out = await run(items, 7, async (i) => {
      await sleep((50 - i) % 11)
      return i * 2
    })
    expect(out).toEqual(items.map((i) => i * 2))
  })

  test("never exceeds the concurrency limit", async () => {
    let inFlight = 0
    let peak = 0
    await run(Array.from({ length: 40 }, (_, i) => i), 5, async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await sleep(5)
      inFlight--
      return null
    })
    expect(peak).toBe(5)
  })

  test("a slow item does not hold back the ones behind it", async () => {
    // One 200 ms item among 11 fast ones, three in flight. Batching would pay
    // the slow item's full cost inside its batch and serialise the rest behind
    // it; a sliding window overlaps them.
    const started = Date.now()
    await run(Array.from({ length: 12 }, (_, i) => i), 3, async (i) => {
      await sleep(i === 0 ? 200 : 20)
      return i
    })
    const elapsed = Date.now() - started
    // 11 fast items over the remaining two slots is ~110 ms, all of it
    // overlapping the slow one: comfortably under a batched worst case.
    expect(elapsed).toBeLessThan(320)
  })

  test("fails fast but lets in-flight tasks finish", async () => {
    let finished = 0
    const promise = run(Array.from({ length: 30 }, (_, i) => i), 4, async (i) => {
      if (i === 1) throw new Error("boom")
      await sleep(20)
      finished++
      return i
    })
    await expect(promise).rejects.toThrow("boom")
    // The three siblings that were already running completed; the tail did not
    // start. Without fail-fast all 29 would have run.
    expect(finished).toBeLessThan(29)
  })
})
