import { Supermemory } from "supermemory"
import type {
  Provider,
  ProviderConfig,
  IngestOptions,
  IngestResult,
  SearchOptions,
  IndexingProgressCallback,
  ProviderSearchResponse,
  AwaitIndexingOptions,
} from "../../types/provider"
import type {
  CanonicalIngestionDocument,
  ProviderResultDropDiagnostic,
  UnifiedSearchResult,
} from "../../types/unified"
import { logger } from "../../utils/logger"
import { stableSha256 } from "../../utils/stable"
import { SUPERMEMORY_PROMPTS } from "./prompts"
import {
  asFiniteNumber,
  asNonEmptyString,
  asRecord,
  assertContainerTag,
  assertResultBudget,
  rankResults,
  recordResultDrop,
  requireSearchLimit,
  resolveDocumentDate,
  resolveSessionId,
  createProviderSearchResponse,
} from "../normalization"

type SupermemoryAddBody = Parameters<Supermemory["add"]>[0] & {
  dreaming?: "instant"
}

type SupermemoryBatchAddBody = {
  documents: Array<{
    content: string
    customId: string
    metadata: Record<string, string | number | boolean | string[]>
  }>
  containerTag: string
  dreaming?: "instant"
}

type SupermemoryDocumentStatus = {
  status?: string
  dreamingStatus?: string
}

export type SupermemoryReadiness = "pending" | "completed" | "failed"

export function resolveSupermemoryBatchIngestResult(
  response: unknown,
  documents: CanonicalIngestionDocument[]
): IngestResult {
  const responseRecord = asRecord(response)
  const rawItems = Array.isArray(response)
    ? response
    : responseRecord && Array.isArray(responseRecord.results)
      ? responseRecord.results
      : null
  if (!rawItems) throw new Error("Supermemory batch ingest returned an invalid response")
  if (rawItems.length !== documents.length) {
    throw new Error(
      `Supermemory batch ingest returned ${rawItems.length} results for ${documents.length} documents`
    )
  }

  const failedByCustomId = new Map<string, string>()
  const successfulDocumentIds: string[] = []
  for (const [index, rawItem] of rawItems.entries()) {
    const item = asRecord(rawItem)
    const id = asNonEmptyString(item?.id)
    const status = asNonEmptyString(item?.status)
    if (!item || !id) {
      throw new Error(
        `Supermemory batch ingest returned an invalid item at index ${index}: missing document ID`
      )
    }
    if (status === "error") {
      if (!documents.some((document) => document.customId === id)) {
        throw new Error(`Supermemory batch ingest returned an error for unknown custom ID ${id}`)
      }
      if (failedByCustomId.has(id)) {
        throw new Error(`Supermemory batch ingest returned duplicate failure for ${id}`)
      }
      failedByCustomId.set(
        id,
        asNonEmptyString(item.error) ?? asNonEmptyString(item.details) ?? "batch validation failed"
      )
      continue
    }
    successfulDocumentIds.push(id)
  }

  const unclaimedFailures = new Set(failedByCustomId.keys())
  let successIndex = 0
  const items = documents.map((document) => {
    const error = failedByCustomId.get(document.customId)
    if (error) {
      unclaimedFailures.delete(document.customId)
      return { customId: document.customId, documentIds: [], error }
    }
    const documentId = successfulDocumentIds[successIndex++]
    if (!documentId) {
      throw new Error(`Supermemory batch ingest did not return a result for ${document.customId}`)
    }
    return { customId: document.customId, documentIds: [documentId] }
  })
  if (successIndex !== successfulDocumentIds.length || unclaimedFailures.size > 0) {
    throw new Error("Supermemory batch ingest response could not be attributed to every input")
  }

  return { documentIds: successfulDocumentIds, items }
}

/** Mono exposes memory inference separately from the normal document lifecycle. */
export function classifySupermemoryReadiness(
  document: SupermemoryDocumentStatus
): SupermemoryReadiness {
  if (document.status === "failed") return "failed"
  if (document.status === "done" && document.dreamingStatus === "done") return "completed"
  return "pending"
}

function resolveSupermemoryMetadataField(
  resultId: string,
  fieldName: "sessionId" | "documentDate",
  resultMetadata: unknown,
  documentMetadata: unknown[],
  resolve: (...values: unknown[]) => string | undefined
): string | undefined {
  const resultValue = resolve(resultMetadata)
  if (resultValue) return resultValue

  const documentValues = documentMetadata
    .map((metadata) => resolve(metadata))
    .filter((value): value is string => value !== undefined)
  const distinctValues = [...new Set(documentValues)]
  if (distinctValues.length > 1) {
    throw new Error(
      `Supermemory result ${resultId} has conflicting document ${fieldName} values: ${distinctValues.join(", ")}`
    )
  }
  return documentValues[0]
}

async function withDeadline<T>(
  operation: Promise<T>,
  deadlineMs: number,
  timeoutMessage: string
): Promise<T> {
  const remainingMs = deadlineMs - Date.now()
  if (remainingMs <= 0) throw new Error(timeoutMessage)

  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(timeoutMessage)), remainingMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export function normalizeSupermemorySearchResults(
  rawResults: unknown[],
  limit: number,
  droppedResults: ProviderResultDropDiagnostic[] = []
): UnifiedSearchResult[] {
  requireSearchLimit(limit, "supermemory")
  assertResultBudget(rawResults.length, limit, "supermemory")

  const normalized: Omit<UnifiedSearchResult, "rank">[] = []
  for (const [index, rawResult] of rawResults.entries()) {
    const result = asRecord(rawResult)
    if (!result) {
      recordResultDrop(droppedResults, index, "malformed-result")
      continue
    }

    const id = asNonEmptyString(result.id)
    const memory = asNonEmptyString(result.memory)
    const chunk = asNonEmptyString(result.chunk)
    if (!id) {
      recordResultDrop(droppedResults, index, "missing-id")
      continue
    }
    if (!memory && !chunk) {
      recordResultDrop(droppedResults, index, "empty-text")
      continue
    }

    const metadata = asRecord(result.metadata)
    const documents = Array.isArray(result.documents) ? result.documents : []
    const documentMetadata = documents
      .map((document) => asRecord(document))
      .map((document) => asRecord(document?.metadata))
      .filter((value): value is NonNullable<typeof value> => value !== undefined)
    const score = asFiniteNumber(result.similarity)
    const sessionId = resolveSupermemoryMetadataField(
      id,
      "sessionId",
      metadata,
      documentMetadata,
      resolveSessionId
    )
    const documentDate = resolveSupermemoryMetadataField(
      id,
      "documentDate",
      metadata,
      documentMetadata,
      resolveDocumentDate
    )

    normalized.push({
      id,
      text: memory ?? chunk!,
      ...(score !== undefined ? { score } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(documentDate ? { documentDate } : {}),
      provider: "supermemory",
      resultType: memory ? "memory" : "chunk",
    })
  }

  return rankResults(normalized)
}

export class SupermemoryProvider implements Provider {
  name = "supermemory"
  adapterVersion = "2.4.0"
  searchRequestStructure = { kind: "single" } as const
  prompts = SUPERMEMORY_PROMPTS
  concurrency = {
    default: 50,
    ingest: 100,
    indexing: 200,
  }
  private client: Supermemory | null = null

  constructor(
    private readonly indexingTimeoutMs = 30 * 60 * 1000,
    private readonly initialPollingIntervalMs = 1000
  ) {}

  getIngestionConfigFingerprint(config: ProviderConfig): string {
    return stableSha256({
      schemaVersion: 1,
      provider: this.name,
      adapterVersion: this.adapterVersion,
      baseUrl: config.baseUrl ?? "https://api.supermemory.ai",
      addContract: "single-or-batch-content-containerTag-customId-metadata-dreaming-idempotency-v3",
      readinessContract: "document-status-done-and-dreaming-status-done-v1",
      indexingTimeoutMs: this.indexingTimeoutMs,
      initialPollingIntervalMs: this.initialPollingIntervalMs,
    })
  }

  async initialize(config: ProviderConfig): Promise<void> {
    this.client = new Supermemory({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    })
    logger.info(`Initialized Supermemory provider`)
  }

  async ingest(
    documents: CanonicalIngestionDocument[],
    options: IngestOptions
  ): Promise<IngestResult> {
    if (!this.client) throw new Error("Provider not initialized")
    assertContainerTag(options.containerTag)

    if (documents.length > 1) {
      const request: SupermemoryBatchAddBody = {
        documents: documents.map((document) => ({
          content: document.content,
          customId: document.customId,
          metadata: document.metadata as Record<string, string | number | boolean | string[]>,
        })),
        containerTag: options.containerTag,
        ...(options.processingMode === "instant" ? { dreaming: "instant" as const } : {}),
      }
      const response = await this.client.documents.batchAdd(
        request as Parameters<Supermemory["documents"]["batchAdd"]>[0],
        {
          idempotencyKey: stableSha256({
            provider: this.name,
            operation: "documents.batchAdd",
            containerTag: options.containerTag,
            customIds: documents.map((document) => document.customId),
          }),
        }
      )
      const result = resolveSupermemoryBatchIngestResult(response, documents)
      for (const item of result.items ?? []) {
        if (item.error) {
          logger.warn(`Deferred session ${item.customId}: ${item.error}`)
        } else {
          logger.debug(`Ingested session ${item.customId}`)
        }
      }
      return result
    }

    const documentIds: string[] = []

    for (const document of documents) {
      const request: SupermemoryAddBody = {
        content: document.content,
        containerTag: options.containerTag,
        customId: document.customId,
        metadata: document.metadata as Record<string, string | number | boolean | string[]>,
        ...(options.processingMode === "instant" ? { dreaming: "instant" as const } : {}),
      }
      const response = await this.client.add(request, {
        idempotencyKey: stableSha256({
          provider: this.name,
          containerTag: options.containerTag,
          customId: document.customId,
        }),
      })
      documentIds.push(response.id)
      logger.debug(`Ingested session ${document.metadata.sessionId}`)
    }

    return {
      documentIds,
      items: documents.map((document, index) => ({
        customId: document.customId,
        documentIds: documentIds[index] ? [documentIds[index]!] : [],
      })),
    }
  }

  async awaitIndexing(
    result: IngestResult,
    _containerTag: string,
    onProgress?: IndexingProgressCallback,
    options?: AwaitIndexingOptions
  ): Promise<void> {
    if (!this.client) throw new Error("Provider not initialized")
    if (result.documentIds.length === 0) {
      onProgress?.({ completedIds: [], failedIds: [], total: 0 })
      return
    }

    const timeoutMs = options?.timeoutMs ?? this.indexingTimeoutMs
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new Error(`Supermemory indexing timeout cannot be negative; received ${timeoutMs}`)
    }
    const total = result.documentIds.length
    const pending = new Set(result.documentIds)
    const completedIds: string[] = []
    const failedIds: string[] = []
    let backoffMs = this.initialPollingIntervalMs
    const indexingStartedMs = Date.now()
    const indexingDeadlineMs = indexingStartedMs + timeoutMs

    onProgress?.({ completedIds: [], failedIds: [], total })

    while (pending.size > 0) {
      const timeoutMessage = `Supermemory indexing timed out after ${timeoutMs}ms with ${pending.size} documents pending`
      if (Date.now() >= indexingDeadlineMs) throw new Error(timeoutMessage)

      const pendingArray = Array.from(pending)
      const results = await withDeadline(
        Promise.allSettled(
          pendingArray.map(async (docId) => {
            const document = (await this.client!.documents.get(docId)) as SupermemoryDocumentStatus
            return { docId, readiness: classifySupermemoryReadiness(document) }
          })
        ),
        indexingDeadlineMs,
        timeoutMessage
      )

      for (const res of results) {
        if (res.status === "fulfilled") {
          const { docId, readiness } = res.value
          if (readiness === "failed") {
            pending.delete(docId)
            failedIds.push(docId)
          } else if (readiness === "completed") {
            pending.delete(docId)
            completedIds.push(docId)
          }
        }
      }

      onProgress?.({ completedIds: [...completedIds], failedIds: [...failedIds], total })

      if (pending.size > 0) {
        const remainingMs = indexingDeadlineMs - Date.now()
        if (remainingMs <= 0) {
          throw new Error(
            `Supermemory indexing timed out after ${timeoutMs}ms with ${pending.size} documents pending`
          )
        }
        await new Promise((r) => setTimeout(r, Math.min(backoffMs, remainingMs)))
        backoffMs = Math.min(Math.max(backoffMs * 1.2, this.initialPollingIntervalMs), 5000)
      }
    }

    if (failedIds.length > 0) {
      logger.warn(`${failedIds.length} documents failed indexing`)
    }
  }

  async search(query: string, options: SearchOptions): Promise<ProviderSearchResponse> {
    if (!this.client) throw new Error("Provider not initialized")
    const limit = requireSearchLimit(options.limit, this.name)
    assertContainerTag(options.containerTag)

    const searchMode = options.searchMode ?? "hybrid"
    if (searchMode !== "memories" && searchMode !== "hybrid") {
      throw new Error(`Supermemory adapter does not support search mode: ${searchMode}`)
    }

    const threshold = options.threshold ?? 0.6
    const response = await this.client.search.memories({
      q: query,
      containerTag: options.containerTag,
      limit,
      searchMode,
      include: { documents: true },
      threshold,
      rerank: false,
      rewriteQuery: false,
    })

    const rawResults = response.results ?? []
    const droppedResults: ProviderResultDropDiagnostic[] = []
    return createProviderSearchResponse({
      results: normalizeSupermemorySearchResults(rawResults, limit, droppedResults),
      requestedLimit: limit,
      rawReturnedCount: rawResults.length,
      droppedResults,
      providerRequests: [
        {
          operation: `search.${searchMode}`,
          limit,
          parameters: {
            searchMode,
            threshold,
            includeDocuments: true,
            includeChunks: false,
            rerank: false,
            rewriteQuery: false,
          },
        },
      ],
    })
  }

  async clear(containerTag: string): Promise<void> {
    if (!this.client) throw new Error("Provider not initialized")
    logger.warn(`Clear not implemented for Supermemory - containerTag: ${containerTag}`)
  }
}

export default SupermemoryProvider
