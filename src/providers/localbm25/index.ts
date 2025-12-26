import type { Provider, ProviderConfig, IngestOptions, IngestResult, SearchOptions } from "../../types/provider"
import type { UnifiedSession } from "../../types/unified"
import { logger } from "../../utils/logger"

import bm25Factory from "wink-bm25-text-search"
import winkNLPUtils from "wink-nlp-utils"

const { string, tokens } = winkNLPUtils as any

type LocalDoc = {
  id: string
  content: string
  metadata: Record<string, unknown>
}

export class LocalBM25Provider implements Provider {
  name = "localbm25"

  private engine: any | null = null
  private docs = new Map<string, LocalDoc>()

  private docCount = 0
  private isConsolidated = false

  async initialize(_config: ProviderConfig): Promise<void> {
    this.engine = bm25Factory()
    this.engine.defineConfig({ fldWeights: { content: 1 } })

    const tasks = [string.lowerCase, string.tokenize0, tokens.removeWords, tokens.stem]

    for (const t of tasks) {
      if (typeof t !== "function") {
        throw new Error(`LocalBM25Provider: Invalid BM25 prep task: ${String(t)}`)
      }
    }

    this.engine.definePrepTasks(tasks)

    this.docCount = 0
    this.isConsolidated = false

    logger.info("Initialized LocalBM25 provider (offline)")
  }

  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
    if (!this.engine) throw new Error("Provider not initialized")

    // If ingest is called after consolidation, rebuild the index to allow adds.
    if (this.isConsolidated) {
      logger.warn("LocalBM25 ingest called after consolidate; rebuilding index")
      await this.rebuildIndex()
    }

    const documentIds: string[] = []

    for (const session of sessions) {
      const sessionStr = JSON.stringify(session.messages)
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")

      const formattedDate = session.metadata?.formattedDate as string
      const isoDate = session.metadata?.date as string

      const content = formattedDate
        ? `Here is the date the following session took place: ${formattedDate}\n\nHere is the session as a stringified JSON:\n${sessionStr}`
        : `Here is the session as a stringified JSON:\n${sessionStr}`

      const docId = `localbm25-${options.containerTag}-${session.sessionId}`

      const doc: LocalDoc = {
        id: docId,
        content,
        metadata: {
          sessionId: session.sessionId,
          ...(isoDate ? { date: isoDate } : {}),
          containerTag: options.containerTag,
        },
      }

      this.docs.set(docId, doc)
      this.engine.addDoc({ content }, docId)

      this.docCount++
      documentIds.push(docId)

      logger.debug(`Ingested session ${session.sessionId} into LocalBM25`)
    }

    // ✅ Never consolidate here — MemoryBench ingests multiple times.
    return { documentIds }
  }

  async awaitIndexing(_result: IngestResult, _containerTag: string): Promise<void> {
    if (!this.engine) throw new Error("Provider not initialized")
    if (this.isConsolidated) return

    // winkBM25 requires a minimum number of docs to consolidate.
    // If too few, we keep running and use fallback retrieval later.
    if (this.docCount < 3) {
      logger.warn(`LocalBM25: docCount=${this.docCount} too small for consolidate; skipping BM25 consolidate`)
      return
    }

    try {
      this.engine.consolidate()
      this.isConsolidated = true
      logger.info(`LocalBM25 consolidated index (${this.docCount} docs)`)
    } catch (e) {
      logger.warn(`LocalBM25 consolidate failed (skipping): ${(e as Error).message}`)
      this.isConsolidated = false
    }
  }

  async search(query: string, options: SearchOptions): Promise<unknown[]> {
    if (!this.engine) throw new Error("Provider not initialized")

    const limit = options.limit || 10

    // ✅ For very small doc counts, BM25 can't consolidate/search reliably.
    // Use deterministic fallback ranking.
    if (this.docCount < 3) {
      logger.warn(`LocalBM25: docCount=${this.docCount} too small for BM25; using fallback search`)
      return this.fallbackSearch(query, limit)
    }

    // Ensure consolidated before searching
    if (!this.isConsolidated) {
      try {
        this.engine.consolidate()
        this.isConsolidated = true
        logger.info(`LocalBM25 consolidated lazily before search (${this.docCount} docs)`)
      } catch (e) {
        logger.warn(`LocalBM25 lazy consolidate failed: ${(e as Error).message}; using fallback search`)
        return this.fallbackSearch(query, limit)
      }
    }

    try {
      const results = this.engine.search(query, limit)

      // wink returns [docId, score]
      return results.map((r: any) => {
        const docId = r[0]
        const score = r[1]
        const doc = this.docs.get(docId)

        return {
          id: docId,
          score,
          content: doc?.content || "",
          metadata: doc?.metadata || {},
        }
      })
    } catch (e) {
      logger.warn(`LocalBM25 BM25 search failed: ${(e as Error).message}; using fallback search`)
      return this.fallbackSearch(query, limit)
    }
  }

  async clear(containerTag: string): Promise<void> {
    const prefix = `localbm25-${containerTag}-`

    for (const key of this.docs.keys()) {
      if (key.startsWith(prefix)) this.docs.delete(key)
    }

    await this.rebuildIndex()
    logger.info(`Cleared LocalBM25 docs for containerTag: ${containerTag}`)
  }

  // -----------------------
  // Internal helpers
  // -----------------------

  private async rebuildIndex(): Promise<void> {
    this.engine = bm25Factory()
    this.engine.defineConfig({ fldWeights: { content: 1 } })

    const tasks = [string.lowerCase, string.tokenize0, tokens.removeWords, tokens.stem]
    this.engine.definePrepTasks(tasks)

    this.docCount = 0
    this.isConsolidated = false

    for (const [id, doc] of this.docs.entries()) {
      this.engine.addDoc({ content: doc.content }, id)
      this.docCount++
    }
  }

  // Simple deterministic fallback for tiny doc collections
  // Uses token overlap scoring (better than raw substring)
  private fallbackSearch(query: string, limit: number): unknown[] {
    const qTokens = new Set(
      query
        .toLowerCase()
        .split(/\W+/)
        .filter(Boolean)
    )

    const scored = Array.from(this.docs.values()).map((doc) => {
      const dTokens = doc.content
        .toLowerCase()
        .split(/\W+/)
        .filter(Boolean)

      let overlap = 0
      for (const t of dTokens) {
        if (qTokens.has(t)) overlap++
      }

      return { doc, score: overlap }
    })

    scored.sort((a, b) => b.score - a.score)

    return scored.slice(0, limit).map(({ doc, score }) => ({
      id: doc.id,
      score,
      content: doc.content,
      metadata: doc.metadata,
    }))
  }
}

export default LocalBM25Provider
