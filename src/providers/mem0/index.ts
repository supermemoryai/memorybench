import { webcrypto } from "crypto"
if (typeof window === "undefined") {
  ;(globalThis as unknown as { window: { crypto: Crypto } }).window = {
    crypto: webcrypto as Crypto,
  }
}
if (!globalThis.crypto) {
  globalThis.crypto = webcrypto as Crypto
}

import MemoryClient, { type MemoryOptions, type SearchOptions as Mem0SearchOptions } from "mem0ai"
import type {
  Provider,
  ProviderConfig,
  IngestOptions,
  IngestResult,
  SearchOptions,
  IndexingProgressCallback,
  ProviderSearchResponse,
} from "../../types/provider"
import type {
  CanonicalIngestionDocument,
  ProviderResultDropDiagnostic,
  UnifiedSearchResult,
} from "../../types/unified"
import { logger } from "../../utils/logger"
import { stableSha256 } from "../../utils/stable"
import { MEM0_PROMPTS } from "./prompts"
import {
  asFiniteNumber,
  asNonEmptyString,
  asRecord,
  assertResultBudget,
  canonicalDocumentToSession,
  rankResults,
  recordResultDrop,
  requireSearchLimit,
  resolveDocumentDate,
  resolveSessionId,
  createProviderSearchResponse,
} from "../normalization"

export function normalizeMem0SearchResults(
  rawResults: unknown[],
  limit: number,
  droppedResults: ProviderResultDropDiagnostic[] = []
): UnifiedSearchResult[] {
  requireSearchLimit(limit, "mem0")
  assertResultBudget(rawResults.length, limit, "mem0")

  const normalized: Omit<UnifiedSearchResult, "rank">[] = []
  for (const [index, rawResult] of rawResults.entries()) {
    const result = asRecord(rawResult)
    if (!result) {
      recordResultDrop(droppedResults, index, "malformed-result")
      continue
    }

    const data = asRecord(result.data)
    const id = asNonEmptyString(result.id) ?? asNonEmptyString(data?.id)
    const text = asNonEmptyString(result.memory) ?? asNonEmptyString(data?.memory)
    if (!id) {
      recordResultDrop(droppedResults, index, "missing-id")
      continue
    }
    if (!text) {
      recordResultDrop(droppedResults, index, "empty-text")
      continue
    }

    const metadata = asRecord(result.metadata) ?? asRecord(data?.metadata)
    const score = asFiniteNumber(result.score) ?? asFiniteNumber(data?.score)
    const sessionId = resolveSessionId(metadata)
    const documentDate = resolveDocumentDate(metadata)
    normalized.push({
      id,
      text,
      ...(score !== undefined ? { score } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(documentDate ? { documentDate } : {}),
      provider: "mem0",
      resultType: "memory",
    })
  }

  return rankResults(normalized)
}

/**
 * Custom instructions from Mem0's official evaluation.
 * Sets project-level instructions for memory extraction.
 */
const CUSTOM_INSTRUCTIONS = `Generate personal memories that follow these guidelines:

1. Each memory should be self-contained with complete context, including:
   - The person's name, do not use "user" while creating memories
   - Personal details (career aspirations, hobbies, life circumstances)
   - Emotional states and reactions
   - Ongoing journeys or future plans
   - Specific dates when events occurred

2. Include meaningful personal narratives focusing on:
   - Identity and self-acceptance journeys
   - Family planning and parenting
   - Creative outlets and hobbies
   - Mental health and self-care activities
   - Career aspirations and education goals
   - Important life events and milestones

3. Make each memory rich with specific details rather than general statements
   - Include timeframes (exact dates when possible)
   - Name specific activities (e.g., "charity race for mental health" rather than just "exercise")
   - Include emotional context and personal growth elements

4. Extract memories only from user messages, not incorporating assistant responses

5. Format each memory as a paragraph with a clear narrative structure that captures the person's experience, challenges, and aspirations`

export async function configureMem0Project(client: {
  updateProject(input: { custom_instructions: string }): Promise<unknown>
}): Promise<void> {
  await client.updateProject({ custom_instructions: CUSTOM_INSTRUCTIONS })
}

export class Mem0Provider implements Provider {
  name = "mem0"
  adapterVersion = "2.1.0"
  searchRequestStructure = { kind: "single" } as const
  prompts = MEM0_PROMPTS
  concurrency = {
    default: 50,
  }
  private client: MemoryClient | null = null

  getIngestionConfigFingerprint(_config: ProviderConfig): string {
    return stableSha256({
      schemaVersion: 1,
      provider: this.name,
      adapterVersion: this.adapterVersion,
      customInstructions: CUSTOM_INSTRUCTIONS,
      version: "v2",
      enableGraph: false,
      asyncMode: false,
      reconciliation: "user_id-run_id-v1",
    })
  }

  async initialize(config: ProviderConfig): Promise<void> {
    this.client = new MemoryClient({ apiKey: config.apiKey })

    await configureMem0Project(this.client)

    logger.info(`Initialized Mem0 provider`)
  }

  async ingest(
    documents: CanonicalIngestionDocument[],
    options: IngestOptions
  ): Promise<IngestResult> {
    if (!this.client) throw new Error("Provider not initialized")

    const eventIds: string[] = []

    for (const document of documents) {
      const existingResponse = await this.client.getAll({
        user_id: options.containerTag,
        run_id: document.customId,
        page_size: 100,
        output_format: "v1.1",
      })
      const existingRecord = asRecord(existingResponse)
      const existing = Array.isArray(existingResponse)
        ? existingResponse
        : Array.isArray(existingRecord?.results)
          ? existingRecord.results
          : []
      const existingIds = existing.flatMap((item) => {
        const record = asRecord(item)
        const data = asRecord(record?.data)
        const id = asNonEmptyString(record?.id) ?? asNonEmptyString(data?.id)
        return id ? [id] : []
      })
      if (existingIds.length > 0) {
        eventIds.push(...existingIds)
        logger.debug(`Reconciled previously ingested session ${document.customId}`)
        continue
      }

      const session = canonicalDocumentToSession(document)
      const messages = session.messages.map((m) => ({
        role: m.role,
        content: m.content,
      }))

      const addOptions: MemoryOptions = {
        user_id: options.containerTag,
        run_id: document.customId,
        version: "v2",
        enable_graph: false,
        // Synchronous completion makes the run_id marker queryable before this call returns.
        // Mem0's default infer-mode conflict resolution supplies duplicate protection if the
        // process dies after remote success but before the local checkpoint becomes durable.
        async_mode: false,
        metadata: {
          ...document.metadata,
          ...(document.metadata.documentDate ? { timestamp: document.metadata.documentDate } : {}),
          ...options.metadata,
        },
      }

      const result = (await this.client.add(messages, addOptions)) as Array<{
        id?: string
        event_id?: string
      }>
      for (const event of result) {
        const id = event.id ?? event.event_id
        if (id) eventIds.push(id)
      }
    }
    return { documentIds: eventIds }
  }

  async awaitIndexing(
    result: IngestResult,
    _containerTag: string,
    onProgress?: IndexingProgressCallback
  ): Promise<void> {
    const eventIds = result.documentIds || []
    if (eventIds.length === 0) {
      onProgress?.({ completedIds: [], failedIds: [], total: 0 })
      return
    }

    // async_mode=false returns fully processed memory IDs.
    onProgress?.({ completedIds: [...eventIds], failedIds: [], total: eventIds.length })
  }

  async search(query: string, options: SearchOptions): Promise<ProviderSearchResponse> {
    if (!this.client) throw new Error("Provider not initialized")
    const limit = requireSearchLimit(options.limit, this.name)

    const searchOptions: Mem0SearchOptions = {
      user_id: options.containerTag,
      top_k: limit,
      enable_graph: false,
      output_format: "v1.1",
      ...(options.threshold !== undefined ? { threshold: options.threshold } : {}),
      ...(options.filters ? { filters: options.filters } : {}),
    }

    const response = await this.client.search(query, searchOptions)
    const responseRecord = asRecord(response)
    const rawResults = Array.isArray(response)
      ? response
      : Array.isArray(responseRecord?.results)
        ? responseRecord.results
        : []
    const droppedResults: ProviderResultDropDiagnostic[] = []
    return createProviderSearchResponse({
      results: normalizeMem0SearchResults(rawResults, limit, droppedResults),
      requestedLimit: limit,
      rawReturnedCount: rawResults.length,
      droppedResults,
      providerRequests: [
        {
          operation: "search.memories",
          limit,
          parameters: {
            topK: limit,
            enableGraph: false,
            outputFormat: "v1.1",
            thresholdProvided: options.threshold !== undefined,
            ...(options.threshold !== undefined ? { threshold: options.threshold } : {}),
          },
        },
      ],
    })
  }

  async clear(containerTag: string): Promise<void> {
    if (!this.client) throw new Error("Provider not initialized")
    await this.client.deleteAll({ user_id: containerTag })
    logger.info(`Cleared memories for user: ${containerTag}`)
  }
}

export default Mem0Provider
