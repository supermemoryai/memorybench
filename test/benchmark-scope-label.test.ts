import { describe, expect, test } from "bun:test"
import { getBenchmarkDisplayName } from "../ui/lib/utils"

describe("benchmark scope labels", () => {
  test("qualifies every supported BEAM tier when checkpoint scope is unavailable", () => {
    expect(getBenchmarkDisplayName("beam-1m")).toBe("BEAM 1M")
    expect(getBenchmarkDisplayName("beam-10m")).toBe("BEAM 10M")
    expect(getBenchmarkDisplayName("beam-1m-10m")).toBe("BEAM 1M/10M")
  })

  test("uses the recorded benchmark scope as the authoritative display name", () => {
    expect(
      getBenchmarkDisplayName("beam-1m", {
        displayName: "BEAM 1M reviewed snapshot",
        includedTiers: ["1M"],
      })
    ).toBe("BEAM 1M reviewed snapshot")
  })
})
