import { embedMany, embed } from "ai"
import { createOpenAI } from "@ai-sdk/openai"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
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
import { HybridSearchEngine } from "./search"
import type { Chunk, SearchResult as RagSearchResult } from "./search"
import { RAG_PROMPTS } from "./prompts"
import { extractMemories, getMemoryExtractionConfigFingerprint } from "../../prompts/extraction"
import { stableSha256 } from "../../utils/stable"
import {
  assertResultBudget,
  canonicalDocumentToSession,
  rankResults,
  recordResultDrop,
  requireSearchLimit,
  resolveDocumentDate,
  createProviderSearchResponse,
} from "../normalization"

/** Target chunk size in characters (~400 tokens) */
const CHUNK_SIZE = 1600
/** Overlap between chunks in characters (~80 tokens, matching OpenClaw) */
const CHUNK_OVERLAP = 320
/** Maximum chunks to embed in a single API call */
const EMBEDDING_BATCH_SIZE = 100
/** Embedding model to use */
const EMBEDDING_MODEL = "text-embedding-3-small"
const RAG_INDEX_SCHEMA_VERSION = 1
const DEFAULT_INDEX_ROOT = join(process.cwd(), "data", "providers", "rag")

interface PersistedRagIndex {
  schemaVersion: typeof RAG_INDEX_SCHEMA_VERSION
  embeddingModel: typeof EMBEDDING_MODEL
  chunks: Chunk[]
}

function sanitizePath(input: string): string {
  return input.replace(/[^a-zA-Z0-9_.-]/g, "_")
}

function validatePersistedChunk(value: unknown, index: number): Chunk {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`RAG index chunk ${index} is not an object`)
  }
  const chunk = value as Partial<Chunk>
  if (
    typeof chunk.id !== "string" ||
    chunk.id.length === 0 ||
    typeof chunk.content !== "string" ||
    chunk.content.length === 0 ||
    typeof chunk.sessionId !== "string" ||
    chunk.sessionId.length === 0 ||
    !Number.isInteger(chunk.chunkIndex) ||
    (chunk.chunkIndex as number) < 0 ||
    !Array.isArray(chunk.embedding) ||
    chunk.embedding.length === 0 ||
    chunk.embedding.some((number) => typeof number !== "number" || !Number.isFinite(number))
  ) {
    throw new Error(`RAG index chunk ${index} is malformed`)
  }
  if (chunk.date !== undefined && typeof chunk.date !== "string") {
    throw new Error(`RAG index chunk ${index} has an invalid date`)
  }
  if (
    chunk.metadata !== undefined &&
    (!chunk.metadata || typeof chunk.metadata !== "object" || Array.isArray(chunk.metadata))
  ) {
    throw new Error(`RAG index chunk ${index} has invalid metadata`)
  }
  return chunk as Chunk
}

function indexPath(root: string, containerTag: string): string {
  return join(root, sanitizePath(containerTag), "index.json")
}

export async function loadPersistedRagChunks(
  root: string,
  containerTag: string
): Promise<Chunk[] | null> {
  const path = indexPath(root, containerTag)
  let content: string
  try {
    content = await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (error) {
    throw new Error(`RAG index ${path} is unreadable: ${String(error)}`)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`RAG index ${path} has an invalid root object`)
  }
  const index = parsed as Partial<PersistedRagIndex>
  if (
    index.schemaVersion !== RAG_INDEX_SCHEMA_VERSION ||
    index.embeddingModel !== EMBEDDING_MODEL
  ) {
    throw new Error(`RAG index ${path} uses an incompatible schema or embedding model`)
  }
  if (!Array.isArray(index.chunks)) throw new Error(`RAG index ${path} has no chunk array`)
  const chunks = index.chunks.map(validatePersistedChunk)
  if (new Set(chunks.map((chunk) => chunk.id)).size !== chunks.length) {
    throw new Error(`RAG index ${path} contains duplicate chunk IDs`)
  }
  return chunks
}

export async function persistRagChunks(
  root: string,
  containerTag: string,
  chunks: Chunk[]
): Promise<void> {
  const path = indexPath(root, containerTag)
  const directory = join(root, sanitizePath(containerTag))
  const temporaryPath = `${path}.${process.pid}.tmp`
  await mkdir(directory, { recursive: true })
  const persisted: PersistedRagIndex = {
    schemaVersion: RAG_INDEX_SCHEMA_VERSION,
    embeddingModel: EMBEDDING_MODEL,
    chunks,
  }
  await writeFile(temporaryPath, JSON.stringify(persisted), "utf8")
  await rename(temporaryPath, path)
}

export function normalizeRagSearchResults(
  rawResults: RagSearchResult[],
  limit: number,
  threshold?: number,
  droppedResults: ProviderResultDropDiagnostic[] = []
): UnifiedSearchResult[] {
  requireSearchLimit(limit, "rag")
  assertResultBudget(rawResults.length, limit, "rag")
  const normalized: Omit<UnifiedSearchResult, "rank">[] = []
  for (const [index, result] of rawResults.entries()) {
    if (!result.content.trim()) {
      recordResultDrop(droppedResults, index, "empty-text")
      continue
    }
    if (threshold !== undefined && result.score < threshold) {
      recordResultDrop(droppedResults, index, "below-threshold")
      continue
    }
    const documentDate =
      result.date && result.date !== "unknown"
        ? resolveDocumentDate({ documentDate: result.date })
        : resolveDocumentDate(result.metadata)
    normalized.push({
      id: result.id,
      text: result.content,
      score: result.score,
      sessionId: result.sessionId,
      ...(documentDate ? { documentDate } : {}),
      provider: "rag",
      resultType: "chunk",
    })
  }
  return rankResults(normalized)
}

// ─── Chunking ────────────────────────────────────────────────────────────────

/**
 * Split text into overlapping chunks, attempting to break on sentence boundaries.
 * Follows the chunking approach from OpenClaw/QMD: ~400 tokens with overlap.
 */
function chunkText(
  text: string,
  chunkSize: number = CHUNK_SIZE,
  overlap: number = CHUNK_OVERLAP
): string[] {
  if (text.length <= chunkSize) {
    return [text.trim()]
  }

  const chunks: string[] = []
  let start = 0

  while (start < text.length) {
    let end = start + chunkSize

    if (end >= text.length) {
      chunks.push(text.slice(start).trim())
      break
    }

    // Try to break on sentence boundary
    let breakPoint = text.lastIndexOf(". ", end)
    if (breakPoint <= start || breakPoint < start + chunkSize * 0.5) {
      breakPoint = text.lastIndexOf("\n", end)
    }
    if (breakPoint <= start || breakPoint < start + chunkSize * 0.5) {
      breakPoint = text.lastIndexOf(" ", end)
    }
    if (breakPoint <= start) {
      breakPoint = end
    }

    chunks.push(text.slice(start, breakPoint + 1).trim())
    start = breakPoint + 1 - overlap

    if (start < 0) start = 0
  }

  return chunks.filter((c) => c.length > 0)
}

// ─── Provider ────────────────────────────────────────────────────────────────

/**
 * RAG Memory Provider
 *
 * Implements the hybrid BM25 + vector search approach used by OpenClaw's memory
 * system and QMD (Quick Markdown Search):
 *
 * - Ingestion: Extracts structured memories via LLM (like OpenClaw's pre-compaction
 *   flush), then chunks the extracted content into ~400-token pieces with overlap,
 *   generates embeddings via OpenAI text-embedding-3-small
 * - Search: Hybrid scoring combining BM25 keyword matching (30%) with
 *   vector cosine similarity (70%), following OpenClaw's formula
 * - Date-organized: Extracted memories include date context (like OpenClaw's
 *   memory/YYYY-MM-DD.md daily logs)
 * - No external memory service required - all local except for LLM + embedding API
 */
export class RAGProvider implements Provider {
  name = "rag"
  adapterVersion = "2.2.0"
  searchRequestStructure = { kind: "single" } as const
  prompts = RAG_PROMPTS
  concurrency = {
    default: 20,
    ingest: 10,
    indexing: 50,
  }

  private searchEngine = new HybridSearchEngine()
  private openai: ReturnType<typeof createOpenAI> | null = null
  private apiKey: string = ""
  private loadedContainers = new Set<string>()

  constructor(private readonly indexRoot: string = DEFAULT_INDEX_ROOT) {}

  getIngestionConfigFingerprint(_config: ProviderConfig): string {
    return stableSha256({
      schemaVersion: 1,
      provider: this.name,
      adapterVersion: this.adapterVersion,
      extractionConfigFingerprint: getMemoryExtractionConfigFingerprint(),
      chunkSize: CHUNK_SIZE,
      chunkOverlap: CHUNK_OVERLAP,
      embeddingBatchSize: EMBEDDING_BATCH_SIZE,
      embeddingModel: EMBEDDING_MODEL,
      indexSchemaVersion: RAG_INDEX_SCHEMA_VERSION,
      sessionReplacement: "replace-complete-session-v1",
    })
  }

  private async ensureContainerLoaded(containerTag: string, required: boolean): Promise<void> {
    if (this.loadedContainers.has(containerTag)) return
    const chunks = await loadPersistedRagChunks(this.indexRoot, containerTag)
    if (!chunks) {
      if (required) {
        throw new Error(
          `Durable RAG index is missing for ${containerTag}; rebuild this run from ingestion instead of reusing an empty in-memory build`
        )
      }
      this.loadedContainers.add(containerTag)
      return
    }
    this.searchEngine.replaceChunks(containerTag, chunks)
    this.loadedContainers.add(containerTag)
  }

  async initialize(config: ProviderConfig): Promise<void> {
    this.apiKey = config.apiKey
    if (!this.apiKey) {
      throw new Error("RAG provider requires OPENAI_API_KEY for memory extraction and embeddings")
    }
    this.openai = createOpenAI({ apiKey: this.apiKey })
    await mkdir(this.indexRoot, { recursive: true })
    logger.info(
      "Initialized RAG memory provider (OpenClaw/QMD-style with LLM extraction + hybrid search)"
    )
  }

  async ingest(
    documents: CanonicalIngestionDocument[],
    options: IngestOptions
  ): Promise<IngestResult> {
    if (!this.openai) throw new Error("Provider not initialized")
    await this.ensureContainerLoaded(options.containerTag, false)

    const allChunks: Array<{
      text: string
      sessionId: string
      chunkIndex: number
      date?: string
      metadata?: Record<string, unknown>
    }> = []

    // Step 1: Extract memories from each session via LLM, then chunk
    for (const document of documents) {
      const session = canonicalDocumentToSession(document)
      const extracted = await extractMemories(this.openai, session)

      // Extract ISO date for OpenClaw-style date organization
      const documentDate = document.metadata.documentDate
      const dateStr = documentDate?.split("T")[0]

      // Prepend date context (like OpenClaw's memory/YYYY-MM-DD.md)
      const dateHeader = dateStr ? `# Memories from ${dateStr}\n\n` : ""
      const content = dateHeader + extracted

      const textChunks = chunkText(content)

      for (let i = 0; i < textChunks.length; i++) {
        allChunks.push({
          text: textChunks[i],
          sessionId: document.metadata.sessionId,
          chunkIndex: i,
          date: documentDate,
          metadata: {
            ...document.metadata,
            ...(dateStr ? { memoryDate: dateStr } : {}),
          },
        })
      }
    }

    const replacedSessionIds = documents.map((document) => document.metadata.sessionId)
    if (allChunks.length === 0) {
      this.searchEngine.replaceSessionChunks(options.containerTag, replacedSessionIds, [])
      await persistRagChunks(
        this.indexRoot,
        options.containerTag,
        this.searchEngine.getChunks(options.containerTag)
      )
      return { documentIds: [] }
    }

    // Step 2: Generate embeddings in batches
    const embeddedChunks: Chunk[] = []
    const embeddingModel = this.openai.embedding(EMBEDDING_MODEL)

    for (let i = 0; i < allChunks.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = allChunks.slice(i, i + EMBEDDING_BATCH_SIZE)
      const texts = batch.map((c) => c.text)

      const { embeddings } = await embedMany({
        model: embeddingModel,
        values: texts,
      })

      for (let j = 0; j < batch.length; j++) {
        const chunk = batch[j]
        const id = `${options.containerTag}_${chunk.sessionId}_${chunk.chunkIndex}`
        embeddedChunks.push({
          id,
          content: chunk.text,
          sessionId: chunk.sessionId,
          chunkIndex: chunk.chunkIndex,
          embedding: embeddings[j],
          date: chunk.date,
          metadata: chunk.metadata,
        })
      }

      logger.debug(
        `Embedded batch ${Math.floor(i / EMBEDDING_BATCH_SIZE) + 1}/${Math.ceil(allChunks.length / EMBEDDING_BATCH_SIZE)} (${batch.length} chunks)`
      )
    }

    // Step 3: Add to search engine
    this.searchEngine.replaceSessionChunks(options.containerTag, replacedSessionIds, embeddedChunks)
    await persistRagChunks(
      this.indexRoot,
      options.containerTag,
      this.searchEngine.getChunks(options.containerTag)
    )

    const documentIds = embeddedChunks.map((c) => c.id)
    logger.debug(
      `Ingested ${documents.length} session(s) as ${embeddedChunks.length} extracted memory chunks for ${options.containerTag}`
    )

    return { documentIds }
  }

  async awaitIndexing(
    result: IngestResult,
    _containerTag: string,
    onProgress?: IndexingProgressCallback
  ): Promise<void> {
    // Indexing happens synchronously during ingest (embedding generation)
    onProgress?.({
      completedIds: result.documentIds,
      failedIds: [],
      total: result.documentIds.length,
    })
  }

  async search(query: string, options: SearchOptions): Promise<ProviderSearchResponse> {
    if (!this.openai) throw new Error("Provider not initialized")
    const limit = requireSearchLimit(options.limit, this.name)
    await this.ensureContainerLoaded(options.containerTag, true)

    // Generate query embedding
    const embeddingModel = this.openai.embedding(EMBEDDING_MODEL)
    const { embedding: queryEmbedding } = await embed({
      model: embeddingModel,
      value: query,
    })

    // Hybrid search
    const rawResults = this.searchEngine.search(options.containerTag, queryEmbedding, query, limit)
    const droppedResults: ProviderResultDropDiagnostic[] = []
    const results = normalizeRagSearchResults(rawResults, limit, options.threshold, droppedResults)

    logger.debug(
      `Search returned ${results.length} results for "${query.substring(0, 50)}..." ` +
        `(${this.searchEngine.getChunkCount(options.containerTag)} total chunks)`
    )

    return createProviderSearchResponse({
      results,
      requestedLimit: limit,
      rawReturnedCount: rawResults.length,
      droppedResults,
      providerRequests: [
        {
          operation: "rag.hybrid",
          limit,
          parameters: {
            vectorWeight: 0.7,
            bm25Weight: 0.3,
            embeddingModel: EMBEDDING_MODEL,
            ...(options.threshold !== undefined ? { threshold: options.threshold } : {}),
          },
        },
      ],
    })
  }

  async clear(containerTag: string): Promise<void> {
    this.searchEngine.clear(containerTag)
    this.loadedContainers.delete(containerTag)
    await rm(join(this.indexRoot, sanitizePath(containerTag)), { recursive: true, force: true })
    logger.info(`Cleared RAG data for: ${containerTag}`)
  }
}

export default RAGProvider
