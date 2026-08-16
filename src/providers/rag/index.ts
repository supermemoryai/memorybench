import { mkdir, appendFile, readFile, writeFile, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { embedMany, embed } from "ai"
import { createOpenAI } from "@ai-sdk/openai"
import type {
  Provider,
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

/**
 * Where ingested chunks are cached so a resumed run can search data it ingested in an earlier
 * process. Mirrors the layout the filesystem provider already uses
 * (`data/providers/filesystem/...`), one appendable JSONL file per container.
 */
const BASE_DIR = join(process.cwd(), "data", "providers", "rag")

/** Target chunk size in characters (~400 tokens) */
const CHUNK_SIZE = 1600
/** Overlap between chunks in characters (~80 tokens, matching OpenClaw) */
const CHUNK_OVERLAP = 320
/** Maximum chunks to embed in a single API call */
const EMBEDDING_BATCH_SIZE = 100
/** Embedding model to use */
const EMBEDDING_MODEL = "text-embedding-3-small"

// ─── Chunking ────────────────────────────────────────────────────────────────

/**
 * Split text into overlapping chunks, attempting to break on sentence boundaries.
 * Follows the chunking approach from OpenClaw/QMD: ~400 tokens with overlap.
 */
function chunkText(text: string, chunkSize: number = CHUNK_SIZE, overlap: number = CHUNK_OVERLAP): string[] {
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

// ─── Chunk persistence ───────────────────────────────────────────────────────

/** Sanitize a string for safe use as a filesystem path component */
function sanitizePath(input: string): string {
  return input.replace(/[^a-zA-Z0-9_.-]/g, "_")
}

function containerFile(containerTag: string): string {
  return join(BASE_DIR, `${sanitizePath(containerTag)}.jsonl`)
}

/**
 * Embeddings dominate the on-disk size (1536 floats per chunk), so they are stored as
 * base64 float32 rather than JSON numbers — roughly a quarter of the bytes. float32 is the
 * precision the cosine similarity needs; it does not change ranking.
 */
function encodeEmbedding(embedding: number[]): string {
  return Buffer.from(new Float32Array(embedding).buffer).toString("base64")
}

function decodeEmbedding(encoded: string): number[] {
  const buf = Buffer.from(encoded, "base64")
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4))
}

/** One JSON object per line, so ingest can append without rewriting the container. */
export function serializeChunks(chunks: Chunk[]): string {
  return chunks
    .map((c) => JSON.stringify({ ...c, embedding: encodeEmbedding(c.embedding) }) + "\n")
    .join("")
}

export function parseCachedChunks(raw: string): Chunk[] {
  const chunks: Chunk[] = []
  const seen = new Set<string>()

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    let parsed: (Omit<Chunk, "embedding"> & { embedding: string }) | null = null
    try {
      parsed = JSON.parse(line)
    } catch {
      // A process killed mid-append can leave one truncated line; the rest is still good.
      logger.warn("Skipping unreadable cached RAG chunk")
      continue
    }
    // Chunk IDs are deterministic, so a re-ingest can append duplicates. Collapse them here:
    // the BM25 index counts each add, so replaying them would skew IDF and length norms.
    if (!parsed || seen.has(parsed.id)) continue
    seen.add(parsed.id)
    chunks.push({ ...parsed, embedding: decodeEmbedding(parsed.embedding) })
  }

  return chunks
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
 * - Durable: chunks and their embeddings are cached under data/providers/rag so a run
 *   resumed in a new process searches the data it ingested earlier, instead of an empty
 *   index. Expect a few MB per question; `data/` is scratch space and gitignored.
 */
export class RAGProvider implements Provider {
  name = "rag"
  prompts = RAG_PROMPTS
  concurrency = {
    default: 20,
    ingest: 10,
    indexing: 50,
  }

  private searchEngine = new HybridSearchEngine()
  private openai: ReturnType<typeof createOpenAI> | null = null
  private apiKey: string = ""

  async initialize(config: ProviderConfig): Promise<void> {
    this.apiKey = config.apiKey
    if (!this.apiKey) {
      throw new Error("RAG provider requires OPENAI_API_KEY for memory extraction and embeddings")
    }
    this.openai = createOpenAI({ apiKey: this.apiKey })
    logger.info("Initialized RAG memory provider (OpenClaw/QMD-style with LLM extraction + hybrid search)")
  }

  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
    if (!this.openai) throw new Error("Provider not initialized")

    // Create the container file up front, before we know whether these sessions produce any
    // chunks. Its *existence* is what tells a later search "ingest ran for this container",
    // which distinguishes a genuinely empty container from data that was lost with the
    // process — the two used to be indistinguishable, and both scored 0%.
    await mkdir(BASE_DIR, { recursive: true })
    const file = containerFile(options.containerTag)
    if (!existsSync(file)) {
      await writeFile(file, "", "utf-8")
    }

    const allChunks: Array<{
      text: string
      sessionId: string
      chunkIndex: number
      date: string
      metadata?: Record<string, unknown>
    }> = []

    // Step 1: Extract memories from each session via LLM, then chunk
    for (const session of sessions) {
      const extracted = await extractMemories(this.openai, session)

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

    // Step 3: Add to search engine and cache to disk so a resumed run can still find them
    this.searchEngine.addChunks(options.containerTag, embeddedChunks)
    await appendFile(file, serializeChunks(embeddedChunks), "utf-8")

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

  /**
   * Repopulate the in-memory index from the on-disk cache. Needed whenever search runs in a
   * different process than ingest did: the checkpoint records ingest/indexing as completed, so
   * both phases are skipped on resume and nothing else would ever put the chunks back.
   *
   * Cached embeddings are reused rather than recomputed, which keeps this pure disk I/O — an
   * embedding call here would land inside the search phase's measured latency.
   */
  private async loadFromCache(containerTag: string): Promise<void> {
    if (this.searchEngine.getChunkCount(containerTag) > 0) return

    const file = containerFile(containerTag)
    if (!existsSync(file)) {
      throw new Error(
        `No ingested data for ${containerTag}. The RAG cache at ${file} is missing, ` +
          `so this run cannot be resumed — re-run ingest for it (e.g. with --force).`
      )
    }

    const chunks = parseCachedChunks(await readFile(file, "utf-8"))

    if (chunks.length > 0) {
      this.searchEngine.addChunks(containerTag, chunks)
      logger.debug(`Restored ${chunks.length} cached chunks for ${containerTag}`)
    }
  }

  async search(query: string, options: SearchOptions): Promise<unknown[]> {
    if (!this.openai) throw new Error("Provider not initialized")

    await this.loadFromCache(options.containerTag)

    // Generate query embedding
    const embeddingModel = this.openai.embedding(EMBEDDING_MODEL)
    const { embedding: queryEmbedding } = await embed({
      model: embeddingModel,
      value: query,
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
    await rm(containerFile(containerTag), { force: true })
    logger.info(`Cleared RAG data for: ${containerTag}`)
  }
}

export default RAGProvider
