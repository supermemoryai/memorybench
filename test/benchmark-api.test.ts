import { describe, expect, test } from "bun:test"
import { handleBenchmarksRoutes } from "../src/server/routes/benchmarks"

describe("benchmark API dataset failures", () => {
  test("keeps an unknown benchmark distinct from a known benchmark with invalid data", async () => {
    const unknownUrl = new URL("http://localhost/api/benchmarks/not-a-benchmark/questions")
    const unknown = await handleBenchmarksRoutes(new Request(unknownUrl), unknownUrl)
    expect(unknown?.status).toBe(404)

    const beamUrl = new URL("http://localhost/api/benchmarks/beam-1m/questions")
    beamUrl.searchParams.set("dataPath", "/tmp/memorybench-definitely-missing-beam-api")
    beamUrl.searchParams.set("datasetRevision", "a".repeat(64))
    const beam = await handleBenchmarksRoutes(new Request(beamUrl), beamUrl)
    const body = (await beam?.json()) as { error?: string }

    expect(beam?.status).toBe(400)
    expect(body.error).toContain("run the BEAM prepare command")
  })
})
