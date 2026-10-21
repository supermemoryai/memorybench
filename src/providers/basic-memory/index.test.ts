import { describe, expect, test } from "bun:test"
import { formatSessionNote, parseJsonOutput, projectName } from "./index"
import type { UnifiedSession } from "../../types/unified"

describe("projectName", () => {
  test("passes through safe characters", () => {
    expect(projectName("q1-run_abc-123")).toBe("q1-run_abc-123")
  })

  test("replaces unsafe characters with dashes", () => {
    expect(projectName("q1/run abc:42")).toBe("q1-run-abc-42")
  })
})

describe("parseJsonOutput", () => {
  test("parses clean JSON", () => {
    expect(parseJsonOutput<{ a: number }>('{"a":1}')).toEqual({ a: 1 })
  })

  test("strips leading CLI noise before the JSON object", () => {
    const noisy = 'Fetching 5 files: 100%\nWarning: no HF_TOKEN\n{"results":[{"title":"x"}]}'
    expect(parseJsonOutput<{ results: unknown[] }>(noisy)).toEqual({
      results: [{ title: "x" }],
    })
  })

  test("parses a JSON array preceded by noise", () => {
    expect(parseJsonOutput<number[]>("progress...\n[1,2,3]")).toEqual([1, 2, 3])
  })

  test("throws when no JSON is present", () => {
    expect(() => parseJsonOutput("no json here")).toThrow()
  })
})

describe("formatSessionNote", () => {
  const session: UnifiedSession = {
    sessionId: "s1",
    metadata: { date: "2026-03-01T10:00:00Z", formattedDate: "March 1, 2026" },
    messages: [
      { role: "user", speaker: "Caroline", content: "I adopted Biscuit." },
      { role: "assistant", speaker: "Melanie", content: "Nice!" },
    ],
  }

  test("includes the formatted date and conversation", () => {
    const note = formatSessionNote(session)
    expect(note).toContain("**Date:** March 1, 2026")
    expect(note).toContain("## Conversation")
    expect(note).toContain("**Caroline**: I adopted Biscuit.")
    expect(note).toContain("**Melanie**: Nice!")
  })

  test("falls back to role and ISO date when speaker/formattedDate missing", () => {
    const note = formatSessionNote({
      sessionId: "s2",
      metadata: { date: "2026-03-02T00:00:00Z" },
      messages: [{ role: "user", content: "hi" }],
    })
    expect(note).toContain("**Date:** 2026-03-02T00:00:00Z")
    expect(note).toContain("**user**: hi")
  })
})
