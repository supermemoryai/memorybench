import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { Engram, extractPropositions } from "@cartisien/engram"
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

const BASE_DIR = join(process.cwd(), "data", "providers", "engram-v2-fast-epistemic")

function sanitizePath(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, "_")
}

/**
 * Phase-3.2: v2-fast + epistemic labels.
 *
 * Replaces eng.recall() with eng.recallWithEpistemic() and prepends each
 * retrieved memory's epistemic confidence to its content before it reaches
 * the answerer:
 *
 *   [FIRM · 3 sources] [user]: I've watched 5 films...
 *   [CONTESTED · 2 sources] [user]: I've watched 4 films...
 *
 * Hypothesis: gpt-4o is conservative when memories conflict (e.g. MCU films
 * count question). Source-count + corroboration label gives the answerer
 * permission to extract the FIRM-er value instead of waffling.
 *
 * Targets: knowledge-update + temporal-reasoning (the categories where
 * P2.1 gpt-4o regressed or stalled).
 */
export class EngramV2FastEpistemicProvider implements Provider {
  name = "engram-v2-fast-epistemic"
  concurrency = { default: 10, ingest: 4, search: 10 }

  private apiKey: string | null = null
  private instances = new Map<string, Engram>()

  async initialize(config: ProviderConfig): Promise<void> {
    const apiKey = config.apiKey || process.env.OPENAI_API_KEY_ENGRAM || process.env.OPENAI_API_KEY
    if (!apiKey || apiKey === "none") {
      throw new Error("engram-v2-fast-epistemic requires OPENAI_API_KEY for embeddings")
    }
    this.apiKey = apiKey
    await mkdir(BASE_DIR, { recursive: true })
    logger.info(`Initialized engram-v2-fast-epistemic (sqlite, dedup=0.90, threshold=0.3, recallWithEpistemic)`)
  }

  private async getEngram(containerTag: string): Promise<Engram> {
    const tag = sanitizePath(containerTag)
    let eng = this.instances.get(tag)
    if (!eng) {
      const dbPath = join(BASE_DIR, `${tag}.db`)
      eng = new Engram({
        dbPath,
        embeddingProvider: "openai",
        embeddingModel: "text-embedding-3-small",
        embeddingApiKey: this.apiKey!,
        dedupThreshold: 0.90,
      })
      this.instances.set(tag, eng)
    }
    return eng
  }

  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
    const eng = await this.getEngram(options.containerTag)
    const documentIds: string[] = []

    // Pre-batch all embeddings in one OpenAI request per session to avoid
    // serial per-message API calls (was the main ingest bottleneck).
    for (const session of sessions) {
      const isoDate = (session.metadata?.date as string) || undefined
      const displayDate = (session.metadata?.formattedDate as string) || undefined
      const messages = session.messages

      // Pre-warm the embedding cache for all messages + their propositions in
      // one OpenAI batch request, so sequential remember() calls hit cache.
      const msgTexts = messages.map((m) => m.content)
      const propTexts = msgTexts.flatMap((t) => extractPropositions(t))
      const allTexts = [...new Set([...msgTexts, ...propTexts])]
      try {
        await (eng as any).embedBatch(allTexts)
        logger.info(`[v2-fast-epistemic] pre-warmed ${allTexts.length} embeddings (${msgTexts.length} msgs + ${propTexts.length} props)`)
      } catch (err) {
        logger.warn(`[v2-fast-epistemic] embedBatch pre-warm failed, falling back: ${(err as Error).message}`)
      }

      // Sequential remember() calls — SQLite doesn't support concurrent writes
      for (const msg of messages) {
        const role = (msg.role === "user" || msg.role === "assistant") ? msg.role : "system"
        const entry = await eng.remember(options.containerTag, msg.content, role, {
          sessionId: session.sessionId,
          date: displayDate,
          timestamp: msg.timestamp || isoDate,
        })
        documentIds.push(entry.id)
      }
    }

    // Chunked consolidation (same as v2-fast). Set SKIP_CONSOLIDATION=1 to disable.
    if (!process.env.SKIP_CONSOLIDATION) {
      try {
        const TARGET_KEEP = 100
        const CHUNK = 20
        let iterations = 0
        while (iterations < 200) {
          const stats = await eng.stats(options.containerTag)
          const working = stats.byTier.working
          if (working <= TARGET_KEEP) break
          const keep = Math.max(TARGET_KEEP, working - CHUNK)
          const result = await eng.consolidate(options.containerTag, { keep })
          if (result.summarized === 0) break
          iterations++
        }
        logger.info(`[v2-fast-epistemic] consolidation iterations: ${iterations}`)
      } catch (err) {
        logger.warn(`[v2-fast-epistemic] consolidate stopped: ${(err as Error).message}`)
      }
    } else {
      logger.info(`[v2-fast-epistemic] consolidation skipped (SKIP_CONSOLIDATION=1)`)
    }

    // Close and evict after ingest to prevent 265 open SQLite DBs accumulating in memory
    const tag = sanitizePath(options.containerTag)
    await eng.close()
    this.instances.delete(tag)

    return { documentIds }
  }

  async awaitIndexing(
    result: IngestResult,
    _containerTag: string,
    onProgress?: IndexingProgressCallback
  ): Promise<void> {
    onProgress?.({
      completedIds: result.documentIds,
      failedIds: [],
      total: result.documentIds.length,
    })
  }

  async search(query: string, options: SearchOptions): Promise<unknown[]> {
    const eng = await this.getEngram(options.containerTag)
    const finalLimit = Math.min(options.limit || 10, 50)
    const fetchLimit = Math.min(finalLimit * 3, 50)
    const MAX_CONTENT_LEN = 4000

    const raw = await eng.recallWithEpistemic(options.containerTag, query, {
      limit: fetchLimit,
      threshold: 0.3,
    })

    // De-dupe consolidated summaries whose source ids already appear in the candidate set
    const idsPresent = new Set(raw.map((r) => r.id))
    const deduped = raw.filter((r) => {
      const sourceIds = (r as any).consolidatedFrom as string[] | undefined
      if (!sourceIds || sourceIds.length === 0) return true
      return !sourceIds.some((sid) => idsPresent.has(sid))
    })

    // Score-based rerank (no decay) — same as v2-fast
    const reranked = deduped
      .map((r) => {
        const baseScore = (r as any).score ?? (r as any).similarity ?? r.importance ?? 0.5
        return { r, finalScore: baseScore }
      })
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, finalLimit)
      .map(({ r }) => r)

    // Epistemic label injection: prepend to content so the answerer prompt
    // sees `[FIRM · N sources]` before the role + text.
    // Suppress the label when contradictionIds is large (>10): that's proposition-dedup
    // noise from multi-session containers, not genuine factual conflict.
    return reranked.map((r) => {
      const ep = (r as any).epistemic
      const label = ep?.label ?? "PROVISIONAL"
      const sources = ep?.sourceCount ?? 1
      const conflicts = ep?.contradictionIds?.length ?? 0
      const isNoise = conflicts > 10  // proposition dedup noise, not real conflict

      let prefix: string
      if (isNoise) {
        prefix = ""
      } else if (conflicts > 0) {
        prefix = `[${label} · ${sources} sources · ${conflicts} conflicting] `
      } else {
        prefix = `[${label} · ${sources} source${sources === 1 ? "" : "s"}] `
      }

      const decoratedContent = `${prefix}${r.content}`
      const trimmed = decoratedContent.length > MAX_CONTENT_LEN
        ? decoratedContent.slice(0, MAX_CONTENT_LEN) + "…[truncated]"
        : decoratedContent

      return {
        id: r.id,
        content: trimmed,
        role: r.role,
        timestamp: r.timestamp,
        importance: r.importance,
        tier: (r as any).tier,
        sessionId: (r.metadata as any)?.sessionId,
        date: (r.metadata as any)?.date,
        epistemic: ep,
      }
    })
  }

  async clear(containerTag: string): Promise<void> {
    const tag = sanitizePath(containerTag)
    const inst = this.instances.get(tag)
    if (inst) {
      await inst.close()
      this.instances.delete(tag)
    }
    const dbPath = join(BASE_DIR, `${tag}.db`)
    await rm(dbPath, { force: true }).catch(() => {})
    await rm(`${dbPath}-journal`, { force: true }).catch(() => {})
    await rm(`${dbPath}-wal`, { force: true }).catch(() => {})
    await rm(`${dbPath}-shm`, { force: true }).catch(() => {})
  }
}

export default EngramV2FastEpistemicProvider
