import type {
  CanonicalIngestionDocument,
  UnifiedSearchResult,
  UnifiedSession,
} from "../types/unified"
import type { ProviderSearchResponse } from "../types/provider"
import type { ProviderRequestDiagnostic } from "../types/unified"
import type { ProviderResultDropDiagnostic } from "../types/unified"

export type UnknownRecord = Record<string, unknown>

export function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined
}

export function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function requireSearchLimit(limit: number, provider: string): number {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`${provider} search limit must be a positive integer, received ${limit}`)
  }
  return limit
}

export function assertResultBudget(rawCount: number, limit: number, provider: string): void {
  if (rawCount > limit) {
    throw new Error(
      `${provider} returned ${rawCount} results for requested Top-K ${limit}; refusing to silently truncate evidence`
    )
  }
}

export function rankResults(results: Omit<UnifiedSearchResult, "rank">[]): UnifiedSearchResult[] {
  return results.map((result, index) => ({ ...result, rank: index + 1 }))
}

export function recordResultDrop(
  drops: ProviderResultDropDiagnostic[],
  index: number,
  reason: ProviderResultDropDiagnostic["reason"]
): void {
  drops.push({ index, reason })
}

export function resolveSessionId(...values: unknown[]): string | undefined {
  for (const value of values) {
    const record = asRecord(value)
    const sessionId = asNonEmptyString(record?.sessionId)
    if (sessionId) return sessionId
  }
  return undefined
}

export function resolveDocumentDate(...values: unknown[]): string | undefined {
  const sourceDate = (value: unknown): string | undefined => {
    const date = asNonEmptyString(value)
    if (!date) return undefined
    const normalized = date.toLowerCase()
    return normalized === "unknown" ||
      normalized === "unknown date" ||
      normalized === "not specified"
      ? undefined
      : date
  }
  for (const value of values) {
    const record = asRecord(value)
    if (!record) continue

    const direct = sourceDate(record.documentDate)
    if (direct) return direct

    const temporal = asRecord(record.temporalContext)
    const temporalDate = sourceDate(temporal?.documentDate)
    if (temporalDate) return temporalDate

    const legacy = sourceDate(record.date)
    if (legacy) return legacy
  }
  return undefined
}

export function canonicalDocumentToSession(document: CanonicalIngestionDocument): UnifiedSession {
  return {
    sessionId: document.metadata.sessionId,
    messages:
      document.messages && document.messages.length > 0
        ? document.messages
        : [{ role: "user", content: document.content }],
    metadata: {
      ...document.metadata,
      ...(document.metadata.documentDate ? { date: document.metadata.documentDate } : {}),
    },
  }
}

export function assertContainerTag(containerTag: string): void {
  if (containerTag.length === 0 || containerTag.length > 100) {
    throw new Error("containerTag must be between 1 and 100 characters")
  }
  if (!/^[a-zA-Z0-9_:-]+$/.test(containerTag)) {
    throw new Error(
      "containerTag may only contain alphanumeric characters, hyphens, underscores, and colons"
    )
  }
}

export function createProviderSearchResponse(input: {
  results: UnifiedSearchResult[]
  requestedLimit: number
  rawReturnedCount: number
  providerRequests: ProviderRequestDiagnostic[]
  droppedResults?: ProviderResultDropDiagnostic[]
}): ProviderSearchResponse {
  const droppedCount = input.rawReturnedCount - input.results.length
  const droppedResults = input.droppedResults ?? []
  if (droppedResults.length !== droppedCount) {
    throw new Error(
      `Provider normalized ${input.results.length}/${input.rawReturnedCount} results but recorded ${droppedResults.length}/${droppedCount} drop reasons`
    )
  }
  return {
    results: input.results,
    diagnostics: {
      requestedLimit: input.requestedLimit,
      providerRequests: input.providerRequests,
      rawReturnedCount: input.rawReturnedCount,
      normalizedCount: input.results.length,
      droppedCount,
      droppedResults,
    },
  }
}
