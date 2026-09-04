/**
 * AricordProvider for MemoryBench
 * --------------------------------------------------------------------
 * Drop-in `Provider` for `github.com/supermemoryai/memorybench` so ARICORD
 * can be benchmarked side-by-side with supermemory / mem0 / zep on
 * LongMemEval, LoCoMo, and ConvoMem.
 *
 * Vendoring instructions:
 *   1. cp bench-providers/ame-memorybench-provider.ts \
 *        memorybench/src/providers/ame/index.ts
 *   2. memorybench/src/providers/index.ts — add:
 *        import { AricordProvider } from "./ame"
 *        providers.ame = AricordProvider
 *      and append "ame" to the ProviderName union in
 *        memorybench/src/types/provider.ts
 *
 * Runtime: requires ARICORD running (server + Python sidecar) at
 *   ARICORD_BASE_URL (default http://localhost:3100). Set
 *   ARICORD_BENCH_ADMIN=1 on the ARICORD server so /admin/bench/reset works.
 *
 * Each `containerTag` from the harness maps to an ARICORD workspace, so a
 * single ARICORD instance can host multiple parallel benchmark runs with
 * full tenant isolation between them.
 */

import type {
  Provider,
  ProviderConfig,
  IngestOptions,
  IngestResult,
  SearchOptions,
  IndexingProgressCallback,
} from '../../types/provider';
import type { UnifiedSession } from '../../types/unified';
import { logger } from '../../utils/logger';
import { buildAricordAnswerPrompt } from './prompts';

const DEFAULT_BASE_URL = 'http://localhost:3100';
const DEFAULT_TIMEOUT_MS = 3_600_000;

// "Indexing already drained" memo, kept at module scope.
//
// memorybench calls AricordProvider.awaitIndexing ONCE PER QUESTION (after the
// shared ingest phase finishes). Each call polls ARICORD's GET /stats and waits
// for the three counters to hit zero:
//     queue_depth (embed work pending)
//     chunks_without_embedding (storage state)
//     extractions_pending (LLM extraction backlog)
//
// Those counters are GLOBAL (process-wide on ARICORD), not per-workspace. After
// the orchestrator's ingest phase completes, no further ingest happens until
// the *next* run — so once any one awaitIndexing observes 0/0/0, every later
// call in the same memorybench process is guaranteed to also see 0/0/0.
// Re-polling /stats for each of the remaining ~499 questions is pure no-op,
// AND each poll runs a heavy OpenSearch aggregation over a ~1M-doc index
// (~1-3 s a piece). 500 questions × ~2 s ≈ 15-20 min of wasted wall-clock +
// load on the bench pod.
//
// Memoize: first call that sees 0/0/0 flips this to true, every subsequent
// call short-circuits to "done" without an HTTP round-trip. Lives at module
// scope so it survives across all AricordProvider instances within a single
// memorybench process; a new process (= new bench run) starts back at false.
//
// Doesn't change WHAT is measured — the "indexing complete" condition the
// orchestrator waits on is identical; we just stop re-asking once it's true.
let drainedOnce = false;

interface AricordIngestPayload {
  text: string;
  type: 'conversation';
  source_id: string;
  agent?: string;
  metadata?: Record<string, unknown>;
  workspace?: string;
  /**
   * Structured turn list — when set, ARICORD's chunker uses explicit role
   * metadata instead of regex-parsing role markers out of the text.
   * Multilingual-safe (no English-keyword pattern match on user input)
   * and gives the chunker clean turn boundaries instead of mid-sentence
   * word-rolling. Audit #1 finding B4. `text` is kept as a fallback for
   * older ARICORD builds that don't read `messages`.
   */
  messages?: { role: string; content: string }[];
}

interface AricordIngestResponse {
  chunk_ids: string[];
  count: number;
  extracted_memories?: number;
}

interface AricordSearchHit {
  chunk: {
    id: string;
    text: string;
    source_id: string;
    timestamp?: string;
    score?: number;
  };
  score: number;
}

interface AricordSearchResponse {
  results: AricordSearchHit[];
  total: number;
  took_ms: number;
}

interface AricordShapedFact {
  text: string;
  asserted_at?: string;
  confidence?: number;
}

interface AricordShapedRelation {
  text: string;
  predicate: string;
  source_node_id: string;
  target_node_id: string;
}

interface AricordShapedPassage {
  text: string;
  source_id: string;
  relevance: number;
  chunk_id?: string;
  /**
   * ISO timestamp the chunk's source content was authored / asserted at.
   * ARICORD's `/context/shape` carries it through `chunk.timestamp` so the
   * answerer can compute relative-date deltas ("X weeks ago"). Audit #2
   * finding N13 — the field used to be read via `(p as { timestamp?: string })`
   * cast at the bench `search()` call site; now part of the contract.
   */
  timestamp?: string;
  /**
   * Provenance of the chunk text — `user_explicit`, `retrieval`, `tool`,
   * `extractor`, `system_seed`. Used by render-time data-block markers
   * to defend against prompt injection. Forwarded from the chunk's
   * `source_role` field, optional for back-compat with older ARICORD builds.
   */
  source_role?: string;
}

interface AricordShapeResponse {
  /**
   * Answer-ready prompt produced by ARICORD (`/context/shape` `answer_prompt`):
   * the shaped memory bundle wrapped with ARICORD's generalist answer-instruction
   * preamble + format scaffold + the question. We use this verbatim as the
   * answer prompt — the prompt-engineering lives in ARICORD's product surface,
   * not in this harness's `buildAricordAnswerPrompt` (which now just forwards it).
   */
  answer_prompt?: string;
  sections: {
    working_memory?: AricordShapedFact[];
    facts: AricordShapedFact[];
    relations: AricordShapedRelation[];
    passages: AricordShapedPassage[];
  };
  token_estimate: number;
}

/**
 * Render a UnifiedSession into the plain-text form ARICORD's chunker can
 * consume. Each turn is prefixed with the speaker so the chunker's
 * conversation-mode boundary detection works.
 */
function renderSession(session: UnifiedSession): string {
  const dateLine = session.metadata?.formattedDate
    ? `Date: ${session.metadata.formattedDate}\n`
    : session.metadata?.date
      ? `Date: ${session.metadata.date}\n`
      : '';
  const turns = session.messages
    .map((m) => {
      const speaker = m.speaker ?? (m.role === 'user' ? 'User' : 'Assistant');
      const ts = m.timestamp ? ` (${m.timestamp})` : '';
      return `${speaker}${ts}: ${m.content}`;
    })
    .join('\n\n');
  return `${dateLine}${turns}`;
}


export class AricordProvider implements Provider {
  name = 'ame';

  // Per-phase concurrency. All knobs env-overridable so the same provider
  // works against gpt-4o direct (Tier-3+ = 5K RPM, headroom for 8+) and
  // OpenRouter (free = 20 req/min → answer=2; $10 tier ~200/min → 8;
  // $50 tier ~1000/min → 16). Defaults stay tuned for OpenAI direct.
  //   default:  ARICORD_BENCH_CONC_DEFAULT  (default 8)  — any unlisted phase (e.g. indexing)
  //   ingest:   ARICORD_BENCH_CONC_INGEST   (default 32) — vLLM extractor
  //   search:   ARICORD_BENCH_CONC_SEARCH   (default 2)  — reranker bound
  //   answer:   ARICORD_BENCH_CONC_ANSWER   (default 8)  — answer LLM
  //   evaluate: ARICORD_BENCH_CONC_EVALUATE (default 4)  — judge LLM
  concurrency = {
    default: Number(process.env.ARICORD_BENCH_CONC_DEFAULT ?? 8),
    ingest: Number(process.env.ARICORD_BENCH_CONC_INGEST ?? 32),
    search: Number(process.env.ARICORD_BENCH_CONC_SEARCH ?? 2),
    answer: Number(process.env.ARICORD_BENCH_CONC_ANSWER ?? 8),
    evaluate: Number(process.env.ARICORD_BENCH_CONC_EVALUATE ?? 4),
  };

  prompts = {
    answerPrompt: buildAricordAnswerPrompt,
  };

  // Pool of ARICORD server base URLs — when more than one is configured (via
  // `ARICORD_BASE_URLS=http://host:3100,http://host:3101,...`), each request
  // is round-robined across the pool. Lets us scale the search phase past
  // Node's single-core ceiling by running N ARICORD procs that share the
  // OpenSearch + Valkey + sidecar layer.
  private baseUrls: string[] = [DEFAULT_BASE_URL];
  private rrIdx = 0;
  private get baseUrl(): string {
    // Read-only convenience for log lines that want a representative URL.
    return this.baseUrls[0];
  }
  private nextBaseUrl(): string {
    const url = this.baseUrls[this.rrIdx % this.baseUrls.length];
    this.rrIdx = (this.rrIdx + 1) % this.baseUrls.length;
    return url;
  }
  private authToken?: string;
  private timeoutMs: number = DEFAULT_TIMEOUT_MS;

  async initialize(config: ProviderConfig): Promise<void> {
    const csvUrls = process.env.ARICORD_BASE_URLS?.trim();
    const sources = csvUrls
      ? csvUrls.split(',').map((u) => u.trim()).filter(Boolean)
      : [(config.baseUrl as string) ?? process.env.ARICORD_BASE_URL ?? DEFAULT_BASE_URL];
    this.baseUrls = sources.map((u) => u.replace(/\/+$/, ''));
    this.authToken =
      (config.apiKey && config.apiKey !== 'none' ? (config.apiKey as string) : undefined) ??
      process.env.ARICORD_API_TOKEN ??
      undefined;
    this.timeoutMs = (config.timeoutMs as number | undefined) ?? DEFAULT_TIMEOUT_MS;

    // Health-check ALL pool urls up front — fail fast if any is unreachable.
    const probes = await Promise.all(
      this.baseUrls.map((u) =>
        fetch(`${u}/health`, { signal: AbortSignal.timeout(10_000) })
          .then((r) => ({ u, ok: r.ok }))
          .catch(() => ({ u, ok: false })),
      ),
    );
    const failed = probes.filter((p) => !p.ok).map((p) => p.u);
    if (failed.length > 0) {
      throw new Error(
        `AricordProvider: /health unreachable on ${failed.join(', ')}. Start each ARICORD proc + confirm sidecar is up.`,
      );
    }
    logger.info(
      `Initialized AricordProvider against pool of ${this.baseUrls.length}: ${this.baseUrls.join(', ')}`,
    );
  }

  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
    if (sessions.length === 0) return { documentIds: [] };

    const documents: AricordIngestPayload[] = sessions.map((s) => {
      // Source the asserted_at timestamp from the session's actual date
      // (LongMemEval provides simulated dates spanning months — using
      // wall-clock now collapses every fact onto the same instant and
      // breaks supersession ordering + temporal-validity / recency-decay
      // signals that the search/graph layer relies on). Prefer the ISO
      // `date` field over `formattedDate` (which is a human string like
      // "8:30 pm on 20 May, 2023" that Date.parse can't reliably handle).
      const sessionDate =
        (s.metadata?.date as string | undefined) ??
        (s.metadata?.formattedDate as string | undefined) ??
        undefined;
      // Build structured `messages` so ARICORD's chunker takes the
      // explicit-role path instead of word-rolling the rendered text.
      // The session's date is folded in as a synthetic `system` turn so
      // the chunker still sees the temporal signal that `renderSession`
      // baked into the text header — without it, KU/TR questions lose
      // the per-session date anchor when chunks split mid-conversation.
      const formattedDate =
        (s.metadata?.formattedDate as string | undefined) ??
        (s.metadata?.date as string | undefined);
      const messages: { role: string; content: string }[] = [];
      if (formattedDate) {
        messages.push({ role: 'system', content: `Date: ${formattedDate}` });
      }
      for (const m of s.messages) {
        if (typeof m?.content === 'string' && m.content.trim().length > 0) {
          const role = m.speaker ?? (m.role === 'user' ? 'User' : 'Assistant');
          const tsPrefix = m.timestamp ? `(${m.timestamp}) ` : '';
          messages.push({ role, content: `${tsPrefix}${m.content}` });
        }
      }
      return {
        text: renderSession(s),
        messages,
        type: 'conversation' as const,
        source_id: s.sessionId,
        metadata: {
          ...(s.metadata ?? {}),
          bench_session_id: s.sessionId,
          bench_container: options.containerTag,
          // Read by ingestion.ts to seed asserted_at for chunks + graph
          // upserts. Falls back to wall-clock now when absent.
          asserted_at: sessionDate,
        },
        workspace: options.containerTag,
      };
    });

    // ARICORD's bulk endpoint accepts arrays in chunks of 64.
    const documentIds: string[] = [];
    const BATCH = 64;
    for (let i = 0; i < documents.length; i += BATCH) {
      const slice = documents.slice(i, i + BATCH);
      // Top-level `workspace` so this.post() lifts it into the
      // X-Aricord-Workspace header. Auth resolver uses the header to scope
      // ingest writes to this question's container, the per-doc
      // workspace field stays as redundant metadata.
      const res = await this.post<
        { documents: AricordIngestPayload[]; workspace: string },
        AricordIngestResponse[]
      >('/ingest/bulk', { documents: slice, workspace: options.containerTag });
      // /ingest/bulk returns one IngestStats per input doc. We track the
      // session.sessionId, not the per-chunk id.
      for (let j = 0; j < slice.length; j += 1) {
        documentIds.push(slice[j].source_id);
        logger.debug(
          `Ingested ${res[j]?.count ?? 0} chunks for ${slice[j].source_id} (memories: ${
            res[j]?.extracted_memories ?? 0
          })`,
        );
      }
    }
    return { documentIds };
  }

  async awaitIndexing(
    result: IngestResult,
    _containerTag: string,
    onProgress?: IndexingProgressCallback,
  ): Promise<void> {
    // ARICORD indexes the BM25 view synchronously inside /ingest. Embeddings
    // are queued and processed by the embedding worker — we wait for the
    // queue to drain AND for `chunks_without_embedding` to hit zero
    // before declaring indexing complete. Audit #9 finding NN4: queue
    // can be 0 while a small number of chunks (≤10) sit unembedded
    // because their batch failed validation (dim mismatch / NaN); a
    // bench that proceeds to search at that point gets degraded
    // recall on those chunks.
    if (drainedOnce) {
      onProgress?.({
        completedIds: result.documentIds,
        failedIds: [],
        total: result.documentIds.length,
      });
      return;
    }
    const start = Date.now();
    const POLL_MS = 1000;
    // Full500 with the Gemma-4 extractor (~7× more memories than NuExtract)
    // takes ~7-10 h of extraction — the old 1 h cap killed the run. 14 h.
    const MAX_WAIT_MS = 14 * 60 * 60 * 1000;
    let lastSig = '';
    while (Date.now() - start < MAX_WAIT_MS) {
      const stats = await this.get<{
        queue?: { depth?: number };
        chunks_without_embedding?: number;
        extractions_pending?: number;
      }>('/stats');
      const depth = stats.queue?.depth ?? 0;
      const orphans = stats.chunks_without_embedding ?? 0;
      const extractions = stats.extractions_pending ?? 0;
      if (depth === 0 && orphans === 0 && extractions === 0) {
        drainedOnce = true;
        onProgress?.({
          completedIds: result.documentIds,
          failedIds: [],
          total: result.documentIds.length,
        });
        return;
      }
      const sig = `${depth}/${orphans}/${extractions}`;
      if (sig !== lastSig) {
        logger.debug(`ARICORD queue depth=${depth} orphans=${orphans} extractions=${extractions}`);
        lastSig = sig;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    throw new Error(
      `AricordProvider: embedding queue did not drain within ${MAX_WAIT_MS}ms — check sidecar.`,
    );
  }

  private async callShape(
    query: string,
    containerTag: string,
    tokenBudget: number,
  ): Promise<AricordShapeResponse> {
    return this.post<
      { query: string; workspace: string; max_tokens: number; include: string[] },
      AricordShapeResponse
    >('/context/shape', {
      query,
      workspace: containerTag,
      max_tokens: tokenBudget,
      include: ['passages', 'facts', 'relations'],
    });
  }

  async search(query: string, options: SearchOptions): Promise<unknown[]> {
    // F3 parity fix: Supermemory research page does not disclose top_k but
    // their memorybench fork passes the harness `limit` straight through and
    // their internal hybrid search overfetches. ARICORD's default fallback was 10,
    // which starved multi-session and temporal-reasoning categories. Match
    // the LongMemEval paper's recommended default of 30 when the harness
    // doesn't pin a value.
    const limit = options.limit ?? 30;

    // One /context/shape call. ARICORD does query decomposition internally (the
    // always-on QueryPlanner classifies intent and fans out aggregation /
    // multi-fact questions server-side, merging the union) — so the harness
    // asks once and gets ARICORD's whole bundle back, `answer_prompt` included.
    // 503 path: if the shaper is genuinely down (after post()'s retries), fall
    // back to plain /search; those results carry no answer_prompt, so the
    // answer phase fails loudly — the right signal that ARICORD is unhealthy.
    const TOKEN_BUDGET = 16000;
    let shaped: AricordShapeResponse;
    try {
      shaped = await this.callShape(query, options.containerTag, TOKEN_BUDGET);
    } catch (err) {
      const msg = (err as Error)?.message ?? '';
      if (!/503/.test(msg)) throw err;
      logger.warn(`AricordProvider: /context/shape unavailable (503) — falling back to /search — ${msg}`);
      const res = await this.post<
        { query: string; top_k: number; workspace: string },
        AricordSearchResponse
      >('/search', { query, top_k: limit, workspace: options.containerTag });
      return res.results.map((hit) => ({
        sessionId: hit.chunk.source_id,
        content: hit.chunk.text,
        score: hit.score,
        chunkId: hit.chunk.id,
        timestamp: hit.chunk.timestamp,
      }));
    }

    const out: Array<Record<string, unknown>> = [];

    // ARICORD's answer-ready prompt, forwarded verbatim. `buildAricordAnswerPrompt`
    // detects this sentinel entry and returns its content as the final prompt
    // (the prompt-engineering is ARICORD's product surface, not ours).
    if (typeof shaped.answer_prompt === 'string' && shaped.answer_prompt.length > 0) {
      out.push({ sessionId: '__aricord_answer_prompt__', content: shaped.answer_prompt, score: 1 });
    }

    // Passages first — full top-N verbatim chunks ranked by the cross-encoder.
    for (const p of shaped.sections.passages ?? []) {
      out.push({
        sessionId: p.source_id,
        content: p.text,
        score: p.relevance,
        chunkId: p.chunk_id,
        // Patch #1: forward the document timestamp so the answerer can
        // compute date deltas. Was undefined → temporal-reasoning failed
        // because every memory in the answer prompt looked undated.
        timestamp: p.timestamp,
      });
    }
    // Distillation tail — keep small to avoid drowning the chunk signal.
    // Patch #5 — pass through full facts list (server caps via
    // ARICORD_SHAPE_FACTS_LIMIT, default 8 → bench recommended 30). The
    // earlier hard cap at 5 cut aggregation queries ("how much total
    // spent on X", "list all events from Y") that needed all distilled
    // facts. Token budget is 30 facts × ~50 chars ≈ 5% of an 8k prompt
    // — safe to pass through and let the answerer aggregate.
    for (const f of (shaped.sections.facts ?? [])) {
      out.push({
        sessionId: '__graph_fact__',
        content: f.text,
        score: f.confidence ?? 1,
        chunkId: undefined,
        timestamp: f.asserted_at,
      });
    }
    for (const r of (shaped.sections.relations ?? [])) {
      out.push({
        sessionId: '__graph_relation__',
        content: r.text,
        score: 1,
        chunkId: undefined,
        timestamp: undefined,
      });
    }
    return out;
  }

  async clear(containerTag: string): Promise<void> {
    // ARICORD exposes a workspace-scoped wipe via /forget when ARICORD_BENCH_ADMIN=1.
    // The harness bench reset is full-cluster — we keep the per-container
    // path here so multiple bench runs don't trample each other.
    await this.post('/forget', {
      scope: 'agent',
      agent: containerTag,
      mode: 'hard',
      reason: `bench reset for container ${containerTag}`,
    }).catch((err) => {
      // If /forget rejects (auth disabled, no agent match, etc.) fall back
      // to a no-op so the harness can still drive ingest. Logged so the
      // operator notices stale state if it accumulates.
      logger.warn(`AricordProvider: clear(${containerTag}) failed — ${(err as Error).message}`);
    });
  }

  // ─── HTTP plumbing ────────────────────────────────────

  private headers(workspace?: string): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.authToken) h.Authorization = `Bearer ${this.authToken}`;
    // Bench-mode workspace isolation. ARICORD's request schemas (Search, Shape,
    // Ingest) strip a body `workspace` field — the auth resolver is the
    // only path that sets it, and `ARICORD_AUTH_DISABLED=true` collapses every
    // request onto the single `defaultWorkspace`. That destroys per-question
    // isolation in MemoryBench and lets graph facts/relations bleed across
    // questions (the v099-graph regression). When ARICORD_BENCH_ADMIN=1 the
    // server honours `X-Aricord-Workspace`, so we forward the per-question
    // containerTag here.
    if (workspace) h['X-Aricord-Workspace'] = workspace;
    return h;
  }

  private async post<TBody, TRes>(path: string, body: TBody): Promise<TRes> {
    const ws =
      body && typeof body === 'object' && 'workspace' in body
        ? ((body as { workspace?: unknown }).workspace as string | undefined)
        : undefined;
    // Retry transient errors (fetch failed, 500/502/503/504, ECONNRESET) with
    // exponential backoff. The bench orchestrator has no retry, so a single
    // network blip kills the whole run. We keep the retry inside the provider
    // so the orchestrator only sees a final success/failure.
    let lastErr: unknown = undefined;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        return await this.postOnce<TBody, TRes>(path, body, ws);
      } catch (err) {
        lastErr = err;
        const msg = (err as Error)?.message ?? String(err);
        const isTransient = /fetch failed|ECONN|EAI_AGAIN|ETIMEDOUT|abort|50\d|timeout/i.test(msg);
        if (!isTransient || attempt === 4) throw err;
        const backoffMs = attempt * 5_000;
        logger.warn(
          `AricordProvider: ${path} attempt ${attempt}/4 transient error — retrying in ${backoffMs}ms — ${msg}`,
        );
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
    throw lastErr;
  }

  private async postOnce<TBody, TRes>(
    path: string,
    body: TBody,
    ws: string | undefined,
  ): Promise<TRes> {
    const url = this.nextBaseUrl();
    const res = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: this.headers(ws),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`ARICORD ${path} → ${res.status} ${res.statusText}: ${text}`);
    }
    return (await res.json()) as TRes;
  }

  private async get<TRes>(path: string): Promise<TRes> {
    const url = this.nextBaseUrl();
    const res = await fetch(`${url}${path}`, {
      method: 'GET',
      headers: this.headers(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`ARICORD ${path} → ${res.status} ${res.statusText}: ${text}`);
    }
    return (await res.json()) as TRes;
  }
}
