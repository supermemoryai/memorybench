import { createHash } from "node:crypto"
import type { AdvancedSupermemoryApi, V4SearchRequest } from "./client"
import { SupermemoryContractError, isRecord, redact } from "./client"
import type { SupermemoryBuildIdentity } from "./build"

export interface AdvancedRetrievalConfig {
  topK: number
  threshold?: number
  searchMode?: "hybrid" | "memories"
  rerank?: boolean
  rewriteQuery?: boolean
  includeSummaries?: boolean
  includeChunks?: boolean
  includeDocuments?: boolean
  includeRelatedMemories?: boolean
  metadataFilter?: Record<string, unknown>
  maxAttempts?: number
  strictProvenance?: boolean
}

export interface AdvancedNormalizedRetrievalResult {
  rank: number
  score?: number
  kind: "memory" | "chunk"
  text: string
  memory?: string
  summaries: string[]
  chunks: string[]
  providerResultId: string
  documentIds: string[]
  trajectoryId?: string
  stateIndex?: number
  screenshotPaths: string[]
  screenshotAssets: Array<{
    path: string
    assetId: string
    sha256: string
    mimeType: string
    byteLength: number
  }>
  provenanceValid: boolean
  provenanceErrors: string[]
  rawResult: Record<string, unknown>
}

export interface AdvancedRetrievalOutcome {
  request: V4SearchRequest
  rawResponse: Record<string, unknown>
  normalizedResults: AdvancedNormalizedRetrievalResult[]
  remoteDurationMs: number
  diagnostics: {
    resultCount: number
    evidenceCount: number
    chunksTotal: number
    chunksDeduplicated: number
    invalidProvenanceRanks: number[]
  }
}

export class SupermemoryProvenanceError extends Error {
  readonly invalidResults: AdvancedNormalizedRetrievalResult[]

  constructor(invalidResults: AdvancedNormalizedRetrievalResult[]) {
    super(
      `Supermemory returned ${invalidResults.length} result${
        invalidResults.length === 1 ? "" : "s"
      } outside the expected run fingerprint at ranks ${invalidResults
        .map((result) => result.rank)
        .join(", ")}`
    )
    this.name = "SupermemoryProvenanceError"
    this.invalidResults = invalidResults
  }
}

export interface AdvancedSupermemoryRetrievalOptions {
  clock?: () => number
}

export class AdvancedSupermemoryRetrieval {
  private readonly clock: () => number

  constructor(
    private readonly client: AdvancedSupermemoryApi,
    options: AdvancedSupermemoryRetrievalOptions = {}
  ) {
    this.clock = options.clock ?? Date.now
  }

  async search(input: {
    identity: SupermemoryBuildIdentity
    query: string
    config: AdvancedRetrievalConfig
  }): Promise<AdvancedRetrievalOutcome> {
    validateSearchInput(input)
    const metadataFilter = buildSupermemorySearchFilter(
      input.config.metadataFilter ?? {},
      input.identity.runFingerprint
    )

    const request: V4SearchRequest = {
      q: input.query,
      containerTag: input.identity.containerTag,
      limit: input.config.topK,
      threshold: input.config.threshold ?? 0.3,
      searchMode: input.config.searchMode ?? "hybrid",
      rerank: input.config.rerank ?? true,
      rewriteQuery: input.config.rewriteQuery ?? false,
      include: {
        summaries: input.config.includeSummaries ?? true,
        documents: input.config.includeDocuments ?? true,
        relatedMemories: input.config.includeRelatedMemories ?? true,
      },
      filters: metadataFilter,
    }

    const startedAt = this.clock()
    const rawResponse = await this.client.searchV4(request, input.config.maxAttempts)
    const remoteDurationMs = Math.max(0, this.clock() - startedAt)
    const rawResults = rawResponse.results
    if (!Array.isArray(rawResults)) {
      throw new SupermemoryContractError("V4 search response has no results array")
    }
    if (rawResults.length > input.config.topK) {
      throw new SupermemoryContractError(
        `V4 search returned ${rawResults.length} results for topK=${input.config.topK}`
      )
    }

    const normalized = normalizeV4Results(rawResponse, {
      runFingerprint: input.identity.runFingerprint,
      includeChunks: input.config.includeChunks ?? true,
      includeSummaries: input.config.includeSummaries ?? true,
    })
    const invalidResults = normalized.results.filter((result) => !result.provenanceValid)
    if ((input.config.strictProvenance ?? true) && invalidResults.length > 0) {
      throw new SupermemoryProvenanceError(invalidResults)
    }

    return {
      request: redact(request),
      rawResponse: redact(rawResponse),
      normalizedResults: normalized.results,
      remoteDurationMs,
      diagnostics: {
        resultCount: rawResults.length,
        evidenceCount: normalized.results.length,
        chunksTotal: normalized.chunksTotal,
        chunksDeduplicated: normalized.chunksDeduplicated,
        invalidProvenanceRanks: invalidResults.map((result) => result.rank),
      },
    }
  }
}

type SearchFilterCondition = {
  key: string
  value: string
  filterType?: "metadata" | "numeric" | "array_contains" | "string_contains"
  numericOperator?: ">" | "<" | ">=" | "<=" | "="
  negate?: boolean | "true" | "false"
  ignoreCase?: boolean | "true" | "false"
}

type SearchFilterExpression =
  | SearchFilterCondition
  | { AND: SearchFilterExpression[] }
  | { OR: SearchFilterExpression[] }

function validateLogicalExpression(
  value: unknown,
  expectedRunFingerprint: string,
  depth = 0
): SearchFilterExpression {
  if (depth >= 5 || !isRecord(value)) {
    throw new Error("Invalid or over-nested Supermemory search filter")
  }
  if ("key" in value || "value" in value) {
    if (typeof value.key !== "string" || typeof value.value !== "string") {
      throw new Error("Search filter conditions require string key and value")
    }
    if (value.key === "runFingerprint" && value.value !== expectedRunFingerprint) {
      throw new Error("Retrieval metadata filter cannot override the build runFingerprint")
    }
    const filterType = value.filterType
    if (
      filterType !== undefined &&
      !["metadata", "numeric", "array_contains", "string_contains"].includes(String(filterType))
    ) {
      throw new Error(`Invalid search filter type: ${String(filterType)}`)
    }
    const numericOperator = value.numericOperator
    if (
      numericOperator !== undefined &&
      ![">", "<", ">=", "<=", "="].includes(String(numericOperator))
    ) {
      throw new Error(`Invalid numeric search operator: ${String(numericOperator)}`)
    }
    if (
      filterType === "numeric" &&
      (value.value.trim() === "" || Number.isNaN(Number(value.value)))
    ) {
      throw new Error(`Numeric search filter ${value.key} requires a numeric value`)
    }
    for (const field of ["negate", "ignoreCase"] as const) {
      const candidate = value[field]
      if (
        candidate !== undefined &&
        typeof candidate !== "boolean" &&
        candidate !== "true" &&
        candidate !== "false"
      ) {
        throw new Error(`Search filter ${field} must be a boolean`)
      }
    }
    return {
      key: value.key,
      value: value.value,
      ...(filterType === undefined
        ? {}
        : { filterType: filterType as SearchFilterCondition["filterType"] }),
      ...(numericOperator === undefined
        ? {}
        : {
            numericOperator: numericOperator as SearchFilterCondition["numericOperator"],
          }),
      ...(value.negate === undefined
        ? {}
        : { negate: value.negate as SearchFilterCondition["negate"] }),
      ...(value.ignoreCase === undefined
        ? {}
        : { ignoreCase: value.ignoreCase as SearchFilterCondition["ignoreCase"] }),
    }
  }
  const operator = "AND" in value ? "AND" : "OR" in value ? "OR" : undefined
  if (!operator || !Array.isArray(value[operator]) || value[operator].length === 0) {
    throw new Error("Search filters must contain a non-empty AND or OR array")
  }
  return {
    [operator]: value[operator].map((child) =>
      validateLogicalExpression(child, expectedRunFingerprint, depth + 1)
    ),
  } as { AND: SearchFilterExpression[] } | { OR: SearchFilterExpression[] }
}

function flatCondition(key: string, value: unknown): SearchFilterExpression {
  if (!/^[A-Za-z0-9_.-]+$/.test(key)) {
    throw new Error(`Invalid search metadata key: ${key}`)
  }
  if (Array.isArray(value)) {
    if (value.length === 0 || !value.every((item) => typeof item === "string")) {
      throw new Error(`Search metadata array ${key} must contain strings`)
    }
    return {
      OR: value.map((item) => ({
        key,
        value: item,
        filterType: "array_contains",
      })),
    }
  }
  if (!["string", "number", "boolean"].includes(typeof value)) {
    throw new Error(`Unsupported search metadata value for ${key}`)
  }
  return typeof value === "number"
    ? {
        key,
        value: String(value),
        filterType: "numeric",
        numericOperator: "=",
      }
    : { key, value: String(value), filterType: "metadata" }
}

export function buildSupermemorySearchFilter(
  configured: Record<string, unknown>,
  runFingerprint: string
): { AND: SearchFilterExpression[] } {
  if (!runFingerprint.trim()) throw new Error("runFingerprint must not be empty")
  const runCondition: SearchFilterCondition = {
    key: "runFingerprint",
    value: runFingerprint,
    filterType: "metadata",
  }
  if ("AND" in configured || "OR" in configured) {
    return {
      AND: [runCondition, validateLogicalExpression(configured, runFingerprint)],
    }
  }
  if (configured.runFingerprint !== undefined && configured.runFingerprint !== runFingerprint) {
    throw new Error("Retrieval metadata filter cannot override the build runFingerprint")
  }
  return {
    AND: [
      runCondition,
      ...Object.entries(configured)
        .filter(([key]) => key !== "runFingerprint")
        .map(([key, value]) => flatCondition(key, value)),
    ],
  }
}

export function normalizeV4Results(
  rawResponse: Record<string, unknown>,
  options: {
    runFingerprint: string
    includeChunks: boolean
    includeSummaries: boolean
  }
): {
  results: AdvancedNormalizedRetrievalResult[]
  chunksTotal: number
  chunksDeduplicated: number
} {
  const rawResults = Array.isArray(rawResponse.results) ? rawResponse.results : []
  const seenChunkHashes = new Set<string>()
  const results: AdvancedNormalizedRetrievalResult[] = []
  let chunksTotal = 0
  let chunksDeduplicated = 0

  for (const [rank, value] of rawResults.entries()) {
    if (!isRecord(value)) continue
    const resultMetadata = isRecord(value.metadata) ? value.metadata : {}
    const documents = Array.isArray(value.documents) ? value.documents.filter(isRecord) : []
    const documentIds: string[] = []
    const summaries: string[] = []
    const screenshotPaths: string[] = []
    const screenshotAssets: AdvancedNormalizedRetrievalResult["screenshotAssets"] = []

    for (const document of documents) {
      const documentId = stringValue(document.id)
      if (documentId) documentIds.push(documentId)
      const summary = stringValue(document.summary)
      if (options.includeSummaries && summary) summaries.push(summary)
      const metadata = isRecord(document.metadata) ? document.metadata : {}
      const screenshotPath = stringValue(metadata.screenshotPath)
      if (screenshotPath && !screenshotPaths.includes(screenshotPath)) {
        screenshotPaths.push(screenshotPath)
      }
      appendScreenshotAsset(screenshotAssets, metadata)
    }

    const chunks: string[] = []
    if (options.includeChunks) {
      const candidates: string[] = []
      const singular = stringValue(value.chunk)
      if (singular) candidates.push(singular)
      if (Array.isArray(value.chunks)) {
        for (const chunk of value.chunks) {
          if (typeof chunk === "string" && chunk.trim()) candidates.push(chunk)
          if (isRecord(chunk)) {
            const content = stringValue(chunk.content)
            if (content) candidates.push(content)
          }
        }
      }
      chunksTotal += candidates.length
      for (const candidate of candidates) {
        const hash = createHash("sha256").update(candidate).digest("hex")
        if (seenChunkHashes.has(hash)) {
          chunksDeduplicated += 1
        } else {
          seenChunkHashes.add(hash)
          chunks.push(candidate)
        }
      }
    }

    const memory = stringValue(value.memory)
    const textParts = [...(memory ? [memory] : []), ...summaries, ...chunks]
    if (textParts.length === 0) continue

    const metadataCandidates = [
      resultMetadata,
      ...documents.map((document) => (isRecord(document.metadata) ? document.metadata : {})),
    ].filter((metadata) => Object.keys(metadata).length > 0)
    const provenanceErrors: string[] = []
    if (metadataCandidates.length === 0) {
      provenanceErrors.push("result has no provenance metadata")
    } else {
      for (const [index, metadata] of metadataCandidates.entries()) {
        if (metadata.runFingerprint !== options.runFingerprint) {
          provenanceErrors.push(
            `${index === 0 ? "result" : `document ${index}`} runFingerprint is missing or mismatched`
          )
        }
      }
    }

    const primaryMetadata =
      documents.length > 0 && isRecord(documents[0].metadata)
        ? documents[0].metadata
        : resultMetadata
    const resultScreenshot = stringValue(resultMetadata.screenshotPath)
    if (resultScreenshot && !screenshotPaths.includes(resultScreenshot)) {
      screenshotPaths.unshift(resultScreenshot)
    }
    appendScreenshotAsset(screenshotAssets, resultMetadata)
    for (const screenshotPath of screenshotPaths) {
      if (!screenshotAssets.some((asset) => asset.path === screenshotPath)) {
        provenanceErrors.push(
          `screenshot ${screenshotPath} is missing hash, MIME type, byte length, or asset ID`
        )
      }
    }

    results.push({
      rank,
      score: numberValue(value.similarity) ?? numberValue(value.score),
      kind: memory ? "memory" : "chunk",
      text: textParts.join("\n\n"),
      memory,
      summaries,
      chunks,
      providerResultId: stringValue(value.id) ?? `result-${rank}`,
      documentIds,
      trajectoryId:
        stringValue(primaryMetadata.trajectoryId) ?? stringValue(resultMetadata.trajectoryId),
      stateIndex:
        integerValue(primaryMetadata.stateIndex) ?? integerValue(resultMetadata.stateIndex),
      screenshotPaths,
      screenshotAssets,
      provenanceValid: provenanceErrors.length === 0,
      provenanceErrors,
      rawResult: redact(value),
    })
  }

  return { results, chunksTotal, chunksDeduplicated }
}

function appendScreenshotAsset(
  output: AdvancedNormalizedRetrievalResult["screenshotAssets"],
  metadata: Record<string, unknown>
): void {
  const path = stringValue(metadata.screenshotPath)
  if (!path) return
  const assetId = stringValue(metadata.screenshotAssetId)
  const sha256 = stringValue(metadata.screenshotSha256)
  const mimeType = stringValue(metadata.screenshotMimeType)
  const byteLength = integerValue(metadata.screenshotByteLength)
  if (
    !assetId ||
    !sha256 ||
    !/^[a-f0-9]{64}$/i.test(sha256) ||
    !mimeType?.startsWith("image/") ||
    byteLength === undefined ||
    byteLength < 0
  ) {
    return
  }
  if (!output.some((asset) => asset.path === path && asset.assetId === assetId)) {
    output.push({ path, assetId, sha256, mimeType, byteLength })
  }
}

function validateSearchInput(input: {
  identity: SupermemoryBuildIdentity
  query: string
  config: AdvancedRetrievalConfig
}): void {
  if (!input.query.trim()) throw new Error("Retrieval query must not be empty")
  if (!input.identity.containerTag.trim() || !input.identity.runFingerprint.trim()) {
    throw new Error("Retrieval requires containerTag and runFingerprint")
  }
  if (!Number.isInteger(input.config.topK) || input.config.topK < 1) {
    throw new Error("Retrieval topK must be an integer >= 1")
  }
  if (
    input.config.threshold !== undefined &&
    (!Number.isFinite(input.config.threshold) || input.config.threshold < 0)
  ) {
    throw new Error("Retrieval threshold must be a finite number >= 0")
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function integerValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value)
  return undefined
}
