import { describe, expect, test } from "bun:test"
import { validateProviderSearchResponse } from "../src/orchestrator/phases/search"
import type { ProviderSearchRequestStructure, ProviderSearchResponse } from "../src/types/provider"

function provider(name: string, searchRequestStructure: ProviderSearchRequestStructure) {
  return { name, searchRequestStructure }
}

function response(input?: {
  provider?: string
  rawReturnedCount?: number
  normalizedCount?: number
  droppedCount?: number
  requestLimits?: number[]
}): ProviderSearchResponse {
  const providerName = input?.provider ?? "fake"
  const normalizedCount = input?.normalizedCount ?? 2
  const rawReturnedCount = input?.rawReturnedCount ?? 3
  return {
    results: Array.from({ length: normalizedCount }, (_, index) => ({
      id: `result-${index + 1}`,
      rank: index + 1,
      text: `Evidence ${index + 1}`,
      provider: providerName,
      resultType: "memory",
    })),
    diagnostics: {
      requestedLimit: 5,
      providerRequests: (input?.requestLimits ?? [5]).map((limit, index) => ({
        operation: `search.${index + 1}`,
        limit,
      })),
      rawReturnedCount,
      normalizedCount,
      droppedCount: input?.droppedCount ?? rawReturnedCount - normalizedCount,
      droppedResults: Array.from(
        { length: input?.droppedCount ?? rawReturnedCount - normalizedCount },
        (_, index) => ({ index: normalizedCount + index, reason: "empty-text" as const })
      ),
    },
  }
}

describe("search response contract", () => {
  test("accepts valid normalization drops and rejects malformed drop bookkeeping", () => {
    const adapter = provider("fake", { kind: "single" })

    expect(() => validateProviderSearchResponse(response(), adapter, 5)).not.toThrow()
    expect(() => validateProviderSearchResponse(response({ droppedCount: 0 }), adapter, 5)).toThrow(
      "droppedCount 0 does not equal raw minus normalized count"
    )
  })

  test("rejects a single-call adapter that under-requests benchmark Top-K", () => {
    expect(() =>
      validateProviderSearchResponse(
        response({ requestLimits: [4] }),
        provider("fake", { kind: "single" }),
        5
      )
    ).toThrow("single provider request limit 4 does not equal benchmark Top-K 5")
  })

  test("rejects a single-call adapter that over-requests benchmark Top-K", () => {
    expect(() =>
      validateProviderSearchResponse(
        response({ requestLimits: [6] }),
        provider("fake", { kind: "single" }),
        5
      )
    ).toThrow("single provider request limit 6 does not equal benchmark Top-K 5")
  })

  test("accepts Zep's edge/node split only when the shared request budget equals Top-K", () => {
    const zep = provider("zep", { kind: "split", budget: "shared-total" })

    expect(() =>
      validateProviderSearchResponse(response({ provider: "zep", requestLimits: [3, 2] }), zep, 5)
    ).not.toThrow()
    expect(() =>
      validateProviderSearchResponse(response({ provider: "zep", requestLimits: [2, 2] }), zep, 5)
    ).toThrow("split provider request limits total 4, expected benchmark Top-K 5")
    expect(() =>
      validateProviderSearchResponse(response({ provider: "zep", requestLimits: [3, 3] }), zep, 5)
    ).toThrow("split provider request limits total 6, expected benchmark Top-K 5")
  })
})
