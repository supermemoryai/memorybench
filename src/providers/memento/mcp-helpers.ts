// Small helpers for working with `@modelcontextprotocol/sdk` CallToolResult
// payloads. Memento returns its command results as a JSON object encoded in
// a single `text` content part — we drill in here so the main provider file
// stays focused on lifecycle and orchestration.

// `callTool` returns a union for backwards compat: either the modern
// `CallToolResult` (with `content`) or the legacy `{toolResult: unknown}`.
// Memento always returns the modern shape, but we accept the wider union
// here so the helpers compose with `client.callTool(...)` directly without
// callers having to pass the result schema.
type CallToolResultLike = {
  content?: Array<{ type: string; text?: string }>
  isError?: boolean
  toolResult?: unknown
  [key: string]: unknown
}

/**
 * Parse a single tool result whose payload is `{...}` encoded as one
 * `text` content part. Throws when the result is missing, errored, or
 * malformed — the caller is expected to surface that as a phase failure.
 */
export function parseToolResultJson<T = unknown>(result: CallToolResultLike): T {
  if (result.isError) {
    const message = textOf(result) ?? "<no error body>"
    throw new Error(`Memento tool call returned isError: ${message}`)
  }
  const text = textOf(result)
  if (!text) {
    throw new Error("Memento tool call returned no text content")
  }
  try {
    return JSON.parse(text) as T
  } catch (e) {
    throw new Error(`Memento tool call returned non-JSON text: ${(e as Error).message}`)
  }
}

interface MementoSearchPage {
  results: Array<{
    memory: {
      id: string
      scope: { type: string; id?: string; path?: string; remote?: string; branch?: string }
      kind: { type: string }
      tags: string[]
      content: string | null
      createdAt: string
      lastConfirmedAt: string
      status: string
      embedding: number[] | null
      embeddingStatus: "present" | "pending" | "disabled"
      pinned: boolean
      summary: string | null
      supersedes: string[] | null
      supersededBy: string | null
      sensitive: boolean
      redacted: boolean
      storedConfidence: number
    }
    score: number
    breakdown?: {
      fts: number
      vector: number
      confidence: number
      recency: number
      scope: number
      pinned: number
    }
    conflicts?: Array<{ conflictId: string; otherMemoryId: string; kind: string }>
  }>
  nextCursor: string | null
}

export function parseSearchPage(result: CallToolResultLike): MementoSearchPage {
  return parseToolResultJson<MementoSearchPage>(result)
}

export type { MementoSearchPage }

function textOf(result: CallToolResultLike): string | null {
  if (!Array.isArray(result.content)) return null
  for (const part of result.content) {
    if (part.type === "text" && typeof part.text === "string") return part.text
  }
  return null
}
