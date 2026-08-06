import { describe, expect, test } from "bun:test"
import { validateProviderSearchResponse } from "../src/orchestrator/phases/search"
import { renderFilesystemMemoryFile } from "../src/providers/filesystem"
import { createProviderSearchResponse, resolveDocumentDate } from "../src/providers/normalization"
import { normalizeSupermemorySearchResults } from "../src/providers/supermemory"
import { configureMem0Project } from "../src/providers/mem0"
import type { ProviderResultDropDiagnostic } from "../src/types/unified"

describe("normalized result contract", () => {
  test("Mem0 project configuration fails closed", async () => {
    const failure = new Error("project update rejected")
    await expect(
      configureMem0Project({
        updateProject: async () => {
          throw failure
        },
      })
    ).rejects.toBe(failure)
  })

  test("records a reason for every malformed or empty provider result", () => {
    const droppedResults: ProviderResultDropDiagnostic[] = []
    const results = normalizeSupermemorySearchResults(
      [null, { id: "missing-text", memory: "   " }, { chunk: "missing id" }],
      3,
      droppedResults
    )

    expect(results).toEqual([])
    expect(droppedResults).toEqual([
      { index: 0, reason: "malformed-result" },
      { index: 1, reason: "empty-text" },
      { index: 2, reason: "missing-id" },
    ])
    expect(
      createProviderSearchResponse({
        results,
        requestedLimit: 3,
        rawReturnedCount: 3,
        droppedResults,
        providerRequests: [{ operation: "search.hybrid", limit: 3 }],
      }).diagnostics
    ).toMatchObject({ droppedCount: 3, droppedResults })
  })

  test("rejects unrecorded drops and unsupported normalized result types", () => {
    expect(() =>
      createProviderSearchResponse({
        results: [],
        requestedLimit: 1,
        rawReturnedCount: 1,
        providerRequests: [{ operation: "search", limit: 1 }],
      })
    ).toThrow("recorded 0/1 drop reasons")

    expect(() =>
      validateProviderSearchResponse(
        {
          results: [
            {
              id: "bad-type",
              rank: 1,
              text: "evidence",
              provider: "supermemory",
              resultType: "raw-json" as never,
            },
          ],
          diagnostics: {
            requestedLimit: 1,
            rawReturnedCount: 1,
            normalizedCount: 1,
            droppedCount: 0,
            droppedResults: [],
            providerRequests: [{ operation: "search", limit: 1 }],
          },
        },
        { name: "supermemory", searchRequestStructure: { kind: "single" } },
        1
      )
    ).toThrow("unsupported result type")
  })

  test("never promotes provider timestamps or unknown sentinels to source document dates", () => {
    expect(
      resolveDocumentDate({ createdAt: "2026-01-01", updatedAt: "2026-01-02" })
    ).toBeUndefined()
    expect(resolveDocumentDate({ documentDate: "Unknown date" })).toBeUndefined()
    expect(resolveDocumentDate({ temporalContext: { documentDate: "unknown" } })).toBeUndefined()
    expect(resolveDocumentDate({ date: "not specified" })).toBeUndefined()
    expect(resolveDocumentDate({ documentDate: "2024-03-01" })).toBe("2024-03-01")
  })

  test("filesystem undated documents omit the date header and sentinel", () => {
    const undated = renderFilesystemMemoryFile("session-1", undefined, "Stored fact")
    expect(undated).toBe("# Memory: session-1\n\nStored fact")
    expect(undated).not.toContain("**Date:**")
    expect(undated).not.toContain("Unknown date")

    expect(renderFilesystemMemoryFile("session-1", "2024-03-01", "Stored fact")).toContain(
      "**Date:** 2024-03-01"
    )
  })
})
