/**
 * SandraProvider — memorybench adapter for the Sandra semantic graph database.
 *
 * Design notes:
 *   - Ingestion mirrors the Python harness's two-stage pipeline: LLM-extract
 *     entities + facts from each session, then push one sandra_batch per
 *     session. The extracted `{instance_id=containerTag}` ref is how
 *     per-question memory scoping is enforced at retrieval time.
 *   - Retrieval is single-shot: sandra_semantic_search on lme_fact storage,
 *     client-filter by instance_id == containerTag, return top-N. No
 *     multi-turn tool-use agent — that would be unfair vs Mem0/Zep, which
 *     return static search results. This is Sandra's out-of-the-box behavior.
 *   - clear() is a best-effort no-op like Supermemory's — test runs use a
 *     dedicated DB (SANDRA_DB=benchmark_mb) so physical isolation comes from
 *     the database, not per-containerTag deletion.
 */

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
import { SandraMCPClient, type SandraEntityHit } from "./mcp-client"
import { SessionExtractor } from "./extractor"
import {
  FACTORY_ENTITY,
  FACTORY_FACT,
  FACTORY_SESSION,
  FACTORY_SESSION_RAW,
  VERB_ABOUT,
  VERB_MENTIONS,
  VERB_STATES,
  type ExtractedEntity,
  type ExtractedFact,
} from "./schema"
import { SANDRA_PROMPTS, type SandraSearchHit } from "./prompts"

const DEFAULT_SANDRA_URL = process.env.SANDRA_URL || "http://localhost:8090/mcp"
const DEFAULT_SANDRA_TOKEN = process.env.SANDRA_TOKEN || ""

export class SandraProvider implements Provider {
  name = "sandra"
  prompts = SANDRA_PROMPTS
  concurrency = {
    default: 4,
    ingest: 4,
    indexing: 1,
    // Sandra's MCP HTTP server is a single-threaded PHP process; bursty
    // parallel search requests can drop keep-alive connections. Keep search
    // concurrency modest — the MCP client also retries on socket errors.
    search: 2,
  }

  private mcp: SandraMCPClient | null = null
  private extractor: SessionExtractor | null = null
  // One global batch-embed covers all containerTags because the factory-level
  // embed_all walks every unembedded `lme_fact` entity, regardless of
  // instance_id. We run it once per provider lifetime; subsequent
  // awaitIndexing() calls piggy-back on the same promise.
  private globalEmbedPromise: Promise<number> | null = null

  async initialize(config: ProviderConfig): Promise<void> {
    const baseUrl = (config.baseUrl as string | undefined) || DEFAULT_SANDRA_URL
    const token = (config.token as string | undefined) || DEFAULT_SANDRA_TOKEN || undefined
    this.mcp = new SandraMCPClient({ url: baseUrl, token })
    this.extractor = new SessionExtractor({ apiKey: config.apiKey })
    logger.info(`Initialized Sandra provider (url=${baseUrl})`)
  }

  async ingest(
    sessions: UnifiedSession[],
    options: IngestOptions
  ): Promise<IngestResult> {
    if (!this.mcp || !this.extractor) throw new Error("Provider not initialized")

    const documentIds: string[] = []
    const INNER_CONCURRENCY = Math.max(1, Number(process.env.SANDRA_SESSION_PARALLELISM ?? 6))

    // Run sessions in parallel chunks. A single LongMemEval question can have
    // 40+ sessions; serial ingestion means Sandra spends most of its time
    // idle. Cap with SANDRA_SESSION_PARALLELISM (default 6) to avoid pounding
    // the LLM extractor or the MCP server.
    for (let i = 0; i < sessions.length; i += INNER_CONCURRENCY) {
      const batch = sessions.slice(i, i + INNER_CONCURRENCY)
      const results = await Promise.all(batch.map((s) => this.ingestOneSession(options.containerTag, s)))
      for (const ids of results) documentIds.push(...ids)
    }

    return { documentIds }
  }

  private async ingestOneSession(
    containerTag: string,
    session: UnifiedSession
  ): Promise<string[]> {
    if (!this.mcp || !this.extractor) throw new Error("Provider not initialized")
    const formattedDate = (session.metadata?.formattedDate as string) || ""
    const isoDate = (session.metadata?.date as string) || ""
    const sessionTimestamp = formattedDate || isoDate

    // Always dump the raw session transcript as an lme_session_raw entity,
    // even if the structured extraction fails later. The raw storage acts
    // as a verbatim fallback that semantic search can hit when the
    // extracted fact graph misses a detail.
    const rawTranscript = renderSessionTranscript(session, sessionTimestamp)

    let extracted
    try {
      extracted = await this.extractor.extract(session.messages, sessionTimestamp)
    } catch (e) {
      logger.warn(`Extraction failed for ${session.sessionId}: ${e}`)
      // Still push the raw transcript so retrieval at least has something.
      await this.pushRawSessionOnly(containerTag, session.sessionId, sessionTimestamp, rawTranscript).catch(() => undefined)
      return []
    }

    const batchPayload = buildBatchPayload(
      containerTag,
      session.sessionId,
      sessionTimestamp,
      extracted.entities,
      extracted.facts,
      rawTranscript
    )

    try {
      const result = await this.mcp.batch(batchPayload)
      const created = result.summary?.entitiesCreated ?? 0
      const ids: string[] = []
      for (let i = 0; i < created; i++) {
        ids.push(`${session.sessionId}:${i}`)
      }
      return ids
    } catch (e) {
      logger.warn(`sandra_batch failed for ${session.sessionId}: ${e}`)
      return []
    }
  }

  private async pushRawSessionOnly(
    containerTag: string,
    sessionId: string,
    sessionTimestamp: string,
    rawTranscript: string
  ): Promise<void> {
    if (!this.mcp) return
    if (!rawTranscript) return
    await this.mcp.batch({
      concepts: [],
      entities: [
        {
          factory: FACTORY_SESSION_RAW,
          refs: {
            session_id: sessionId,
            instance_id: containerTag,
            timestamp: sessionTimestamp,
          },
          storage: rawTranscript,
        },
      ],
      triplets: [],
    })
  }

  async awaitIndexing(
    _result: IngestResult,
    containerTag: string,
    onProgress?: IndexingProgressCallback
  ): Promise<void> {
    if (!this.mcp) throw new Error("Provider not initialized")

    onProgress?.({ completedIds: [], failedIds: [], total: 1 })
    // Kick off (or join) the single batch-embed pass for the whole run.
    if (this.globalEmbedPromise === null) {
      this.globalEmbedPromise = this.runBatchEmbed()
    }
    try {
      const total = await this.globalEmbedPromise
      logger.debug(
        `sandra_embed_all(lme_fact) total embedded=${total} (container=${containerTag})`
      )
    } catch (e) {
      logger.warn(`sandra_embed_all failed: ${e}`)
    }
    onProgress?.({ completedIds: ["embed"], failedIds: [], total: 1 })
  }

  private async runBatchEmbed(): Promise<number> {
    if (!this.mcp) throw new Error("Provider not initialized")
    // Per-page size must be small enough for a single embed_all call to
    // finish within the MCP client timeout. Each embedding takes
    // ~200-400ms, so PAGE_LIMIT=200 → page ≤ 80s — comfortably under the
    // 10-min client timeout.
    const PAGE_LIMIT = Math.max(
      50,
      Number(process.env.SANDRA_EMBED_PAGE ?? 200)
    )
    let totalEmbedded = 0
    // Embed every factory that the search path might hit via semantic
    // search. Without this, new session_raw entities created with
    // SANDRA_SKIP_AUTO_EMBED=1 would never get an embedding and the
    // fallback retrieval would silently return empty.
    const factories = [FACTORY_FACT, FACTORY_ENTITY, FACTORY_SESSION_RAW]
    for (const factory of factories) {
      let pageIdx = 0
      while (true) {
        pageIdx += 1
        const resp = await this.mcp.embedAll({ factory, limit: PAGE_LIMIT })
        const n = resp.embedded ?? 0
        totalEmbedded += n
        logger.info(
          `sandra_embed_all(${factory}) page ${pageIdx}: embedded=${n}, total=${totalEmbedded}`
        )
        if (n === 0) break
      }
    }
    return totalEmbedded
  }

  async search(query: string, options: SearchOptions): Promise<unknown[]> {
    if (!this.mcp) throw new Error("Provider not initialized")
    // Ignore memorybench's default limit=10 — we want a wider context window
    // for the answerer. Respect an explicit caller-provided limit if set > 10.
    const limit = Math.max(options.limit ?? 10, 50)

    // Instance-scoped retrieval strategy:
    //
    // 1. Fetch ALL facts tagged with this instance_id via
    //    `sandra_search(field=instance_id)`. This is full-recall for the
    //    question's scope — no cross-instance top-K dilution.
    //    WITHOUT storage to keep the response small (storage text can be
    //    several KB per fact × 500 facts → multi-MB response that drops
    //    the keep-alive connection). We fetch storage in a second pass
    //    only for the top-N after ranking.
    // 2. Also fetch entities tagged with this instance_id.
    // 3. Run semantic_search on the main query globally, then use the ranking
    //    ONLY to promote relevant items from within the instance-scoped pool.
    // 4. The final list is instance-scoped facts+entities, reordered so that
    //    items semantically closest to the query come first.
    //
    // Why not filter `sandra_semantic_search` results by instance_id?
    // Because that operation is a top-K over the global factory; if another
    // instance's content is a better semantic match, we lose our own
    // candidates before we can look at them. Instance-scoped first, ranked
    // after.
    // Instance-scoped pool size. Kept moderate so the response payload
    // stays under Sandra's HTTP keep-alive comfort zone — going too high
    // (tried 600) drops the socket mid-transfer.
    const POOL_LIMIT = 300

    // Extended retrieval now also covers `lme_session_raw` — the verbatim
    // transcript fallback. Semantic search on these hits finds details the
    // LLM extractor skipped. We also do a scoped search on session_raw to
    // guarantee at least a baseline presence in the pool — a global top-K
    // over this factory often returns raw sessions from other instances.
    const [factPool, entityPool, rawPool, semHits, semEntityHits, semRawHits] = await Promise.all([
      this.mcp
        .search({
          query: options.containerTag,
          factory: FACTORY_FACT,
          field: "instance_id",
          limit: POOL_LIMIT,
          include_storage: false, // keep response lean
        })
        .catch((e) => {
          logger.warn(`scoped lme_fact search failed: ${e}`)
          return { items: [] as SandraEntityHit[] }
        }),
      this.mcp
        .search({
          query: options.containerTag,
          factory: FACTORY_ENTITY,
          field: "instance_id",
          limit: POOL_LIMIT,
          include_storage: false,
        })
        .catch((e) => {
          logger.warn(`scoped lme_entity search failed: ${e}`)
          return { items: [] as SandraEntityHit[] }
        }),
      // Scoped raw sessions: we need the transcripts (storage) but the
      // payload size is the critical constraint — even ~60 sessions of
      // 5-15KB each drops the HTTP keep-alive. Fetch just 20, then rely on
      // semantic ranking (semRawHits) to surface the most-relevant raw
      // sessions for this query.
      this.mcp
        .search({
          query: options.containerTag,
          factory: FACTORY_SESSION_RAW,
          field: "instance_id",
          limit: 20,
          include_storage: true,
        })
        .catch((e) => {
          logger.warn(`scoped lme_session_raw search failed: ${e}`)
          return { items: [] as SandraEntityHit[] }
        }),
      this.mcp
        .semanticSearch({
          query,
          factory: FACTORY_FACT,
          limit: 200,
          threshold: options.threshold ?? 0.0,
          include_storage: true, // semantic hits already bring storage
        })
        .catch((e) => {
          logger.warn(`semantic_search lme_fact failed: ${e}`)
          return { results: [] as SandraEntityHit[] }
        }),
      this.mcp
        .semanticSearch({
          query,
          factory: FACTORY_ENTITY,
          limit: 60,
          threshold: options.threshold ?? 0.0,
          include_storage: true,
        })
        .catch((e) => {
          logger.warn(`semantic_search lme_entity failed: ${e}`)
          return { results: [] as SandraEntityHit[] }
        }),
      this.mcp
        .semanticSearch({
          query,
          factory: FACTORY_SESSION_RAW,
          limit: 12,
          threshold: options.threshold ?? 0.0,
          include_storage: true,
        })
        .catch((e) => {
          logger.warn(`semantic_search lme_session_raw failed: ${e}`)
          return { results: [] as SandraEntityHit[] }
        }),
    ])

    const poolById = new Map<number, SandraEntityHit>()
    // Seed pool from the instance-scoped searches (guaranteed instance_id).
    for (const r of [factPool, entityPool, rawPool]) {
      for (const h of normalizeHits(r)) {
        if (typeof h.id !== "number") continue
        poolById.set(h.id, h)
      }
    }
    // Merge semantic hits into the pool only when they match instance_id.
    // These bring storage (the `statement` field) that the scoped search
    // did not fetch. For items already in the pool, upgrade their entry
    // with the richer semantic hit (keeps the storage).
    for (const r of [semHits, semEntityHits, semRawHits]) {
      for (const h of normalizeHits(r)) {
        if (typeof h.id !== "number") continue
        if (h.refs?.instance_id !== options.containerTag) continue
        poolById.set(h.id, h)
      }
    }

    // Build semantic rank: earlier in the sem list → higher rank.
    const semRank = new Map<number, number>()
    let rankCounter = 0
    for (const r of [semRawHits, semHits, semEntityHits]) {
      for (const h of normalizeHits(r)) {
        if (typeof h.id !== "number") continue
        if (!poolById.has(h.id)) continue
        if (!semRank.has(h.id)) semRank.set(h.id, rankCounter++)
      }
    }

    // Split the limit budget: guarantee a fixed slice for raw-session
    // transcripts (fallback coverage) and a fixed slice for facts+entities
    // (structured extraction). The raw budget is small — a couple of
    // transcripts are enough to let the answerer cross-check details the
    // extractor missed — but it MUST be non-zero or the whole mechanism
    // is invisible.
    const RAW_BUDGET = Math.min(8, Math.floor(limit * 0.15) + 2)

    const rawHits: SandraEntityHit[] = []
    const structuredHits: SandraEntityHit[] = []
    for (const h of poolById.values()) {
      if (h.factory === FACTORY_SESSION_RAW) rawHits.push(h)
      else structuredHits.push(h)
    }
    const semSort = (a: SandraEntityHit, b: SandraEntityHit) => {
      const ra = semRank.has(a.id!) ? semRank.get(a.id!)! : Infinity
      const rb = semRank.has(b.id!) ? semRank.get(b.id!)! : Infinity
      if (ra !== rb) return ra - rb
      const af = a.refs?.predicate ? 0 : 1
      const bf = b.refs?.predicate ? 0 : 1
      return af - bf
    }
    rawHits.sort(semSort)
    structuredHits.sort(semSort)

    // Only keep raw hits that actually carry storage (the transcript).
    // Raw pool entries without storage are useless to the answerer.
    const rawWithStorage = rawHits.filter((h) => h.storage && h.storage.length > 0)
    const rawSlice = rawWithStorage.slice(0, RAW_BUDGET)
    const structuredSlice = structuredHits.slice(0, limit - rawSlice.length)

    // Interleave so raw transcripts show up near the top of the prompt —
    // the answerer is more likely to cite them when they're not buried.
    const ranked = [...rawSlice, ...structuredSlice]
    return ranked.map((h) => hitToSearchResult(h))
  }

  async clear(containerTag: string): Promise<void> {
    // Sandra's MCP surface does not currently expose a bulk delete-by-ref.
    // Benchmark runs isolate via a dedicated database (SANDRA_DB=benchmark_mb).
    // We log a warning to make this explicit when the runner calls clear().
    logger.warn(
      `Sandra clear() is a no-op; per-containerTag deletion not exposed. Use a dedicated DB for isolation. (containerTag=${containerTag})`
    )
  }
}

function buildBatchPayload(
  instanceId: string,
  sessionId: string,
  sessionTimestamp: string,
  entities: ExtractedEntity[],
  facts: ExtractedFact[],
  rawTranscript: string
) {
  const sessionEntity = {
    factory: FACTORY_SESSION,
    refs: {
      session_id: sessionId,
      instance_id: instanceId,
      timestamp: sessionTimestamp,
    },
  }

  const sessionRawEntity = {
    factory: FACTORY_SESSION_RAW,
    refs: {
      session_id: sessionId,
      instance_id: instanceId,
      timestamp: sessionTimestamp,
    },
    storage: rawTranscript,
  }

  const entityDefs = entities.map((e) => ({
    factory: FACTORY_ENTITY,
    refs: {
      name: e.name,
      kind: e.kind || "other",
      instance_id: instanceId,
      session_id: sessionId,
      turn_idx: "0",
      notes: (e.notes || "").slice(0, 240),
    },
  }))

  const factDefs = facts.map((f) => {
    const refs: Record<string, string> = {
      predicate: f.predicate,
      subject: f.subject || "user",
      object: f.object || "",
      value: (f.value || "").slice(0, 240),
      event_date: f.event_date || "",
      source: f.source || "user",
      instance_id: instanceId,
      session_id: sessionId,
      turn_idx: String(f.turn_idx ?? 0),
      session_timestamp: sessionTimestamp,
    }
    if (f.typed_refs) {
      for (const [k, v] of Object.entries(f.typed_refs)) {
        refs[k] = String(v)
      }
    }
    return {
      factory: FACTORY_FACT,
      refs,
      storage: f.statement,
    }
  })

  const nameToIdx = new Map<string, number>()
  entities.forEach((e, i) => {
    if (!nameToIdx.has(e.name)) nameToIdx.set(e.name, i + 1) // +1 because session is at 0
  })
  const factStart = 1 + entityDefs.length

  const triplets: Array<{
    subject: string
    verb: string
    target: string
  }> = []

  for (let i = 0; i < entityDefs.length; i++) {
    triplets.push({ subject: "$entity.0", verb: VERB_MENTIONS, target: `$entity.${i + 1}` })
  }
  for (let j = 0; j < facts.length; j++) {
    const factIdx = factStart + j
    triplets.push({ subject: "$entity.0", verb: VERB_STATES, target: `$entity.${factIdx}` })
    const objName = facts[j].object
    if (objName && nameToIdx.has(objName)) {
      triplets.push({
        subject: `$entity.${factIdx}`,
        verb: VERB_ABOUT,
        target: `$entity.${nameToIdx.get(objName)!}`,
      })
    }
  }

  // sessionRawEntity is appended last; it does not participate in any
  // triplet so it doesn't affect the $entity.N indices for facts above.
  return {
    concepts: [VERB_MENTIONS, VERB_STATES, VERB_ABOUT],
    entities: [sessionEntity, ...entityDefs, ...factDefs, sessionRawEntity],
    triplets,
  }
}

/**
 * Build a plain-text transcript of a UnifiedSession for storage in the
 * `lme_session_raw` factory. Format: one line per turn, prefixed with a
 * short role tag. A header captures the timestamp so the answerer can
 * resolve relative dates without extra lookups.
 */
function renderSessionTranscript(session: UnifiedSession, sessionTimestamp: string): string {
  const lines: string[] = []
  if (sessionTimestamp) lines.push(`[session on ${sessionTimestamp}]`)
  lines.push(`[session_id ${session.sessionId}]`)
  for (let i = 0; i < session.messages.length; i++) {
    const m = session.messages[i]
    const tag = m.role === "user" ? "USER" : "ASSISTANT"
    lines.push(`[turn ${i} ${tag}] ${m.content}`)
  }
  return lines.join("\n")
}

function normalizeHits(
  resp: unknown
): SandraEntityHit[] {
  if (Array.isArray(resp)) return resp as SandraEntityHit[]
  if (resp && typeof resp === "object") {
    // Sandra's tools use a few different envelope shapes:
    //   sandra_semantic_search → {results: [...]}
    //   sandra_search          → {items: [...]}
    //   sandra_list_entities   → {entities: [...]}
    // We accept all three so callers don't need to care.
    const r = resp as Record<string, unknown>
    if (Array.isArray(r.results)) return r.results as SandraEntityHit[]
    if (Array.isArray(r.items)) return r.items as SandraEntityHit[]
    if (Array.isArray(r.entities)) return r.entities as SandraEntityHit[]
  }
  return []
}

function hitToSearchResult(h: SandraEntityHit): SandraSearchHit {
  const refs = h.refs || {}
  const isEntity = h.factory === FACTORY_ENTITY
  const isRaw = h.factory === FACTORY_SESSION_RAW
  let statement: string
  let predicate: string | undefined
  if (isRaw) {
    // Session raw: storage holds the full transcript. Cap it so a single
    // massive session doesn't crowd out other facts from the answer prompt.
    const raw = h.storage || ""
    statement = raw.length > 3000 ? raw.slice(0, 3000) + " […transcript truncated]" : raw
    predicate = "raw_session_transcript"
  } else if (isEntity) {
    // Entities: synthesize a descriptor so the answer prompt treats entity
    // and fact hits uniformly.
    statement = [refs.name, refs.kind ? `(${refs.kind})` : "", refs.notes ? `: ${refs.notes}` : ""]
      .filter(Boolean)
      .join(" ")
      .trim()
    predicate = `entity:${refs.kind || "other"}`
  } else {
    statement = h.storage || refs.value || ""
    predicate = refs.predicate
  }
  return {
    predicate,
    statement,
    value: refs.value || refs.name,
    event_date: refs.event_date,
    session_timestamp: refs.session_timestamp || refs.timestamp,
    source: refs.source,
    turn_idx: refs.turn_idx,
    session_id: refs.session_id,
    similarity: h.similarity ?? h.score,
  }
}

/**
 * Extract significant content words from a natural-language query, for use
 * with sandra_search's LIKE-based matching. Strategy: strip punctuation,
 * drop stopwords (question words, articles, common prepositions, pronouns,
 * short tokens), cap at 3 to keep the parallel request count bounded.
 *
 * Returns an empty array if no keyword qualifies (rare) — in that case the
 * caller just falls back to semantic search only.
 */
function extractKeywords(query: string): string[] {
  const STOPWORDS = new Set([
    // question words
    "what", "when", "where", "who", "whom", "why", "how", "which", "whose",
    // auxiliaries / copulas
    "is", "are", "was", "were", "be", "been", "being", "am",
    "do", "does", "did", "have", "has", "had", "can", "could", "will", "would",
    "should", "may", "might", "must", "shall",
    // articles & determiners
    "the", "a", "an", "this", "that", "these", "those", "some", "any", "every",
    // prepositions
    "in", "of", "to", "for", "on", "at", "by", "with", "from", "about",
    "into", "over", "under", "between", "through",
    // pronouns
    "i", "me", "my", "mine", "you", "your", "yours", "he", "him", "his",
    "she", "her", "hers", "it", "its", "we", "us", "our", "ours",
    "they", "them", "their", "theirs",
    // common verbs / fillers
    "also", "just", "very", "really", "much", "many", "more", "most",
    "like", "want", "need", "tell", "say", "said",
    // conjunctions
    "and", "or", "but", "so", "if", "then", "because", "than",
    // other
    "not", "no", "yes", "now", "here", "there", "ever", "never",
    "please", "mine", "ours",
  ])
  const tokens = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w))
  // Deduplicate while preserving order.
  const seen = new Set<string>()
  const unique: string[] = []
  for (const w of tokens) {
    if (!seen.has(w)) {
      seen.add(w)
      unique.push(w)
    }
  }
  return unique.slice(0, 3)
}

export default SandraProvider
