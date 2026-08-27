import { embedMany, embed } from "ai"
import { createOpenAI } from "@ai-sdk/openai"
import { Database } from "bun:sqlite"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import type {
  Provider,
  BuildAwareSessionBridge,
  ProviderConfig,
  IngestOptions,
  IngestResult,
  SearchOptions,
  IndexingProgressCallback,
} from "../../types/provider"
import type { UnifiedSession } from "../../types/unified"
import { logger } from "../../utils/logger"
import { HybridSearchEngine } from "./search"
import type { Chunk } from "./search"
import { RAG_PROMPTS } from "./prompts"
import { extractMemories } from "../../prompts/extraction"

/** Target chunk size in characters (~400 tokens) */
const CHUNK_SIZE = 1600
/** Overlap between chunks in characters (~80 tokens, matching OpenClaw) */
const CHUNK_OVERLAP = 320
/** Maximum chunks to embed in a single API call */
const EMBEDDING_BATCH_SIZE = 100
/** Embedding model to use */
const EMBEDDING_MODEL = "text-embedding-3-small"
const BASE_DIR = join(process.cwd(), "data", "providers", "rag")

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
export class RAGProvider implements Provider, BuildAwareSessionBridge {
  name = "rag"
  capabilities = {
    deterministicExternalIds: true,
    batchUpload: false,
    documentDependencies: false,
    ingestionMetadataFilters: false,
    searchMetadataFilters: false,
    searchModes: ["hybrid"] as const,
    reranking: false,
    queryRewriting: false,
    remoteClear: true,
    readinessStates: true,
    mediaIngestion: false,
    durableLocalPersistence: true,
    splitPhaseSafe: true,
  }
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
  private databases = new Map<string, Database>()

  async initialize(config: ProviderConfig): Promise<void> {
    this.apiKey = config.apiKey
    if (!this.apiKey) {
      throw new Error("RAG provider requires OPENAI_API_KEY for memory extraction and embeddings")
    }
    this.openai = createOpenAI({ apiKey: this.apiKey })
    await mkdir(BASE_DIR, { recursive: true })
    logger.info(
      "Initialized RAG memory provider (OpenClaw/QMD-style with LLM extraction + hybrid search)"
    )
  }

  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
    if (!this.openai) throw new Error("Provider not initialized")
    await this.ensureLoaded(options.containerTag)

    const allChunks: Array<{
      text: string
      sessionId: string
      chunkIndex: number
      date: string
      metadata?: Record<string, unknown>
    }> = []

    // Step 1: Extract memories from each session via LLM, then chunk
    for (const session of sessions) {
      const extracted = await extractMemories(this.openai, session, options.signal)
      if (options.signal?.aborted) throw options.signal.reason ?? new Error("Ingestion aborted")

      // Extract ISO date for OpenClaw-style date organization
      const isoDate = (session.metadata?.date as string) || "unknown"
      const dateStr = isoDate !== "unknown" ? isoDate.split("T")[0] : "unknown"

      // Prepend date context (like OpenClaw's memory/YYYY-MM-DD.md)
      const dateHeader = `# Memories from ${dateStr}\n\n`
      const content = dateHeader + extracted

      const textChunks = chunkText(content)

      for (let i = 0; i < textChunks.length; i++) {
        allChunks.push({
          text: textChunks[i],
          sessionId: session.sessionId,
          chunkIndex: i,
          date: dateStr,
          metadata: {
            ...session.metadata,
            memoryDate: dateStr,
          },
        })
      }
    }

    if (allChunks.length === 0) {
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
        abortSignal: options.signal,
      })
      if (options.signal?.aborted) throw options.signal.reason ?? new Error("Ingestion aborted")

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
    const sessionIds = sessions.map((session) => session.sessionId)
    this.searchEngine.removeSessions(options.containerTag, sessionIds)
    this.searchEngine.addChunks(options.containerTag, embeddedChunks)
    this.persistSessions(options.containerTag, sessionIds)

    const documentIds = embeddedChunks.map((c) => c.id)
    logger.debug(
      `Ingested ${sessions.length} session(s) as ${embeddedChunks.length} extracted memory chunks for ${options.containerTag}`
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

  async search(query: string, options: SearchOptions): Promise<unknown[]> {
    if (!this.openai) throw new Error("Provider not initialized")
    await this.ensureLoaded(options.containerTag)

    // Generate query embedding
    const embeddingModel = this.openai.embedding(EMBEDDING_MODEL)
    const { embedding: queryEmbedding } = await embed({
      model: embeddingModel,
      value: query,
      abortSignal: options.signal,
    })

    const limit = options.limit || 10

    // Hybrid search
    const results = this.searchEngine.search(options.containerTag, queryEmbedding, query, limit)

    logger.debug(
      `Search returned ${results.length} results for "${query.substring(0, 50)}..." ` +
        `(${this.searchEngine.getChunkCount(options.containerTag)} total chunks)`
    )

    return results
  }

  async clear(containerTag: string): Promise<void> {
    this.searchEngine.clear(containerTag)
    this.loadedContainers.delete(containerTag)
    this.databases.get(containerTag)?.close()
    this.databases.delete(containerTag)
    const path = this.containerPath(containerTag)
    await Promise.all([
      rm(path, { force: true }),
      rm(`${path}-wal`, { force: true }),
      rm(`${path}-shm`, { force: true }),
    ])
    logger.info(`Cleared RAG data for: ${containerTag}`)
  }

  async inspectSessions(
    containerTag: string,
    sessionIds: string[]
  ): Promise<
    Array<{
      sessionId: string
      status: "ready" | "absent"
      metadata?: Record<string, unknown>
    }>
  > {
    await this.ensureLoaded(containerTag)
    const chunks = this.searchEngine.getChunks(containerTag)
    return sessionIds.map((sessionId) => {
      const chunk = chunks.find((candidate) => candidate.sessionId === sessionId)
      return chunk
        ? { sessionId, status: "ready" as const, metadata: chunk.metadata }
        : { sessionId, status: "absent" as const }
    })
  }

  async deleteSessions(containerTag: string, sessionIds: string[]): Promise<void> {
    await this.ensureLoaded(containerTag)
    this.searchEngine.removeSessions(containerTag, sessionIds)
    this.persistSessions(containerTag, sessionIds)
  }

  private containerPath(containerTag: string): string {
    return join(BASE_DIR, `${sanitizePath(containerTag)}.sqlite`)
  }

  private async ensureLoaded(containerTag: string): Promise<void> {
    if (this.loadedContainers.has(containerTag)) return
    const db = new Database(this.containerPath(containerTag), { create: true, strict: true })
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("PRAGMA synchronous = FULL")
    db.exec("PRAGMA busy_timeout = 10000")
    db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        embedding_json TEXT NOT NULL,
        date TEXT,
        metadata_json TEXT,
        UNIQUE(session_id, chunk_index)
      );
      CREATE INDEX IF NOT EXISTS chunks_session_id ON chunks(session_id);
    `)
    const existingTag = db.query("SELECT value FROM metadata WHERE key = 'containerTag'").get() as {
      value: string
    } | null
    if (existingTag && existingTag.value !== containerTag) {
      db.close()
      throw new Error("Persisted RAG container identity does not match")
    }
    db.query("INSERT OR REPLACE INTO metadata (key, value) VALUES ('schemaVersion', '1')").run()
    db.query("INSERT OR REPLACE INTO metadata (key, value) VALUES ('containerTag', ?)").run(
      containerTag
    )
    const rows = db
      .query(
        `SELECT id, session_id, chunk_index, content, embedding_json, date, metadata_json
         FROM chunks ORDER BY session_id, chunk_index, id`
      )
      .all() as Array<{
      id: string
      session_id: string
      chunk_index: number
      content: string
      embedding_json: string
      date: string | null
      metadata_json: string | null
    }>
    this.searchEngine.replaceChunks(
      containerTag,
      rows.map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        chunkIndex: row.chunk_index,
        content: row.content,
        embedding: JSON.parse(row.embedding_json) as number[],
        date: row.date ?? undefined,
        metadata: row.metadata_json
          ? (JSON.parse(row.metadata_json) as Record<string, unknown>)
          : undefined,
      }))
    )
    this.databases.set(containerTag, db)
    this.loadedContainers.add(containerTag)
  }

  private persistSessions(containerTag: string, sessionIds: string[]): void {
    const db = this.databases.get(containerTag)
    if (!db) throw new Error(`RAG container ${containerTag} is not initialized`)
    const selected = new Set(sessionIds)
    const chunks = this.searchEngine
      .getChunks(containerTag)
      .filter((chunk) => selected.has(chunk.sessionId))
    const transaction = db.transaction(() => {
      const remove = db.query("DELETE FROM chunks WHERE session_id = ?")
      for (const sessionId of sessionIds) remove.run(sessionId)
      const insert = db.query(
        `INSERT INTO chunks
          (id, session_id, chunk_index, content, embedding_json, date, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      for (const chunk of chunks) {
        insert.run(
          chunk.id,
          chunk.sessionId,
          chunk.chunkIndex,
          chunk.content,
          JSON.stringify(chunk.embedding),
          chunk.date ?? null,
          chunk.metadata ? JSON.stringify(chunk.metadata) : null
        )
      }
    })
    transaction.immediate()
  }
}

function sanitizePath(input: string): string {
  return input.replace(/[^a-zA-Z0-9_.-]/g, "_")
}

export default RAGProvider
