// Memento Memory Provider
//
// Memento (https://github.com/veerps57/memento) is a local-first,
// MCP-native memory layer for AI assistants. It runs as a stdio MCP
// server over a local SQLite database. This provider spawns one
// `memento serve` for the lifetime of a memorybench run and routes
// ingest / search / clear through MCP tool calls.
//
// Memento is designed to store **distilled assertions, not transcripts**:
// the calling AI assistant uses its own LLM to decide what's worth
// remembering, then hands those distilled candidates to Memento's
// `extract_memory` MCP tool. Memento embeds, scrubs, dedups, and
// persists. To faithfully represent that flow inside the bench (which
// only gives the provider raw `UnifiedSession` transcripts), this
// provider performs the same distillation step itself — calling the
// configured LLM per session and passing the resulting candidates to
// `extract_memory`. See `./distill.ts`.
//
// Isolation: every benchmark question gets its own Memento `workspace`
// scope keyed by `containerTag` (workspace, not session — Memento's
// `session.id` requires a 26-char ULID while memorybench's
// `containerTag` is an arbitrary string). Memento's architectural
// rule that scope is immutable per memory makes per-question isolation
// reliable. One DB, one server, many scopes.
//
// Env contract:
//
//   - MEMENTO_BIN: shell-like command that already understands `serve`.
//                  Default `"npx -y @psraghuveer/memento"`. Override
//                  with `"node /abs/path/to/cli.js"` for local dev.
//   - MEMENTO_BENCH_DB: SQLite path. Default `/tmp/memento-bench-<ts>.db`.
//   - MEMENTO_DISTILL_MODEL: model alias for the distillation LLM
//                            (defaults to memorybench's answering model).
//   - MEMENTO_BENCH_SEARCH_LIMIT: top-K returned by search_memory. Default 30.
//   - MEMENTO_AWAIT_INDEXING_MS: per-question polling deadline. Default 180000.

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import type {
  IndexingProgressCallback,
  IngestOptions,
  IngestResult,
  Provider,
  ProviderConfig,
  SearchOptions,
} from "../../types/provider"
import type { UnifiedSession } from "../../types/unified"
import { logger } from "../../utils/logger"
import { distillSession } from "./distill"
import { parseSearchPage, parseToolResultJson } from "./mcp-helpers"
import { MEMENTO_PROMPTS } from "./prompts"

// Per-question isolation primitive. Workspace scope's `path` accepts any
// POSIX-absolute string; we synthesize `/memorybench/<containerTag>`.
interface MementoScope {
  type: "workspace"
  path: string
}

function scopeForContainer(containerTag: string): MementoScope {
  return { type: "workspace", path: `/memorybench/${containerTag}` }
}

// Memento's TagSchema enforces /^[a-z0-9][a-z0-9._:/-]*$/ (lowercase
// alphanumerics plus `._:/-`, 1-64 chars). Benchmark metadata (session
// ids, ISO dates) generally fits already; this normaliser is a safety
// net for unusual inputs.
function sanitizeTagValue(value: string): string {
  const lowered = value.toLowerCase().trim()
  const cleaned = lowered.replace(/[^a-z0-9._:/-]+/g, "-").replace(/^-+|-+$/g, "")
  return cleaned.length > 64 ? cleaned.slice(0, 64) : cleaned
}

function tag(key: string, value: string): string | null {
  const v = sanitizeTagValue(value)
  if (!v) return null
  const candidate = `${key}:${v}`
  return candidate.length > 64 ? candidate.slice(0, 64) : candidate
}

function parseBinSpec(spec: string): { command: string; baseArgs: string[] } {
  const trimmed = spec.trim()
  if (trimmed.length === 0) {
    throw new Error("MEMENTO_BIN is empty")
  }
  const parts = trimmed.split(/\s+/)
  return { command: parts[0]!, baseArgs: parts.slice(1) }
}

export class MementoProvider implements Provider {
  name = "memento"
  prompts = MEMENTO_PROMPTS
  concurrency = {
    // Per-phase tuned for one local stdio server. Ingest is heavier
    // than search because each ingest call makes an LLM round-trip
    // plus a write batch; we keep it modest to avoid back-pressure
    // stalls on the JSON-RPC stream.
    default: 10,
    ingest: 5,
    search: 10,
  }

  private client: Client | null = null
  private transport: StdioClientTransport | null = null
  private dbPath = ""
  private binSpec = ""
  // 180s gives the local bge-base-en-v1.5 embedder enough headroom to
  // finish a per-question haystack before search runs. Override via
  // MEMENTO_AWAIT_INDEXING_MS for unusually heavy haystacks.
  private awaitIndexingDeadlineMs = 180_000
  // 30 aligns with Supermemory (30), Mem0 (30), and Zep (20+10=30).
  private searchLimit = 30
  // Per-conversation distillation cache. memorybench typically issues
  // the same haystack sessions across many questions of the same
  // conversation (LoCoMo's `conv-26` underlies 5+ questions). Distilling
  // the same session every time is wasteful (5× LLM cost) AND amplifies
  // per-call LLM variance into per-scope drift. Cache the distill result
  // by `session.sessionId` for the lifetime of the provider; subsequent
  // ingests of the same session reuse the cached candidates and only
  // pay the extract_memory write cost.
  private distillCache = new Map<string, Awaited<ReturnType<typeof distillSession>>>()

  async initialize(_config: ProviderConfig): Promise<void> {
    this.dbPath = process.env.MEMENTO_BENCH_DB ?? `/tmp/memento-bench-${Date.now()}.db`
    this.binSpec = process.env.MEMENTO_BIN ?? "npx -y @psraghuveer/memento"

    const deadlineEnv = process.env.MEMENTO_AWAIT_INDEXING_MS
    if (deadlineEnv !== undefined) {
      const parsed = Number(deadlineEnv)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`MEMENTO_AWAIT_INDEXING_MS must be a positive number (got: ${deadlineEnv})`)
      }
      this.awaitIndexingDeadlineMs = parsed
    }
    const searchLimitEnv = process.env.MEMENTO_BENCH_SEARCH_LIMIT
    if (searchLimitEnv !== undefined) {
      const parsed = Number(searchLimitEnv)
      if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
        throw new Error(
          `MEMENTO_BENCH_SEARCH_LIMIT must be a positive integer (got: ${searchLimitEnv})`
        )
      }
      this.searchLimit = parsed
    }

    const { command, baseArgs } = parseBinSpec(this.binSpec)
    const args = [...baseArgs, "serve", "--db", this.dbPath]

    this.transport = new StdioClientTransport({
      command,
      args,
      env: process.env as Record<string, string>,
      stderr: "pipe",
    })

    // Drain stderr lines to our logger so a misbehaving server is
    // visible in the run output. Lines containing an error-like token
    // are bumped to warn; the rest go to info.
    this.transport.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        if (/error|fatal|panic|unhandled|throw/i.test(trimmed)) {
          logger.warn(`[memento-server] ${trimmed}`)
        } else {
          logger.info(`[memento-server] ${trimmed}`)
        }
      }
    })

    this.client = new Client(
      { name: "memorybench-memento-provider", version: "1.0.0" },
      { capabilities: {} }
    )
    await this.client.connect(this.transport)

    // memorybench's orchestrator doesn't expose a teardown hook for
    // providers, so when the run finishes there's no callback to close
    // the MCP client. The transport keeps the cli.js child process
    // refed in Node's event loop, which keeps Bun alive forever. Unref
    // the child + its pipes so the host can exit normally once its
    // main work is done; the orphaned `memento serve` child sees EOF
    // on stdin and exits cleanly via its own transport-closed handling.
    const childHandle = (
      this.transport as unknown as {
        _process?: {
          unref?: () => void
          stdin?: { unref?: () => void }
          stdout?: { unref?: () => void }
          stderr?: { unref?: () => void }
        }
      }
    )._process
    childHandle?.unref?.()
    childHandle?.stdin?.unref?.()
    childHandle?.stdout?.unref?.()
    childHandle?.stderr?.unref?.()

    const tools = await this.client.listTools()
    for (const t of ["extract_memory", "search_memory", "forget_many_memories"]) {
      if (!tools.tools.find((x) => x.name === t)) {
        throw new Error(`Memento server missing required tool: ${t}`)
      }
    }

    // Warmup: trigger embedder model load before the first benchmark
    // question, so the first real write doesn't pay the cold download.
    const warmupScope = scopeForContainer("__warmup__")
    try {
      await this.client.callTool({
        name: "extract_memory",
        arguments: {
          candidates: [
            {
              kind: "fact",
              content: "Provider warmup write to trigger embedder load.",
              tags: ["benchmark:memorybench", "warmup"],
            },
          ],
          scope: warmupScope,
        },
      })
      await this.client.callTool({
        name: "forget_many_memories",
        arguments: {
          filter: { scope: warmupScope },
          reason: "warmup teardown",
          confirm: true,
          dryRun: false,
        },
      })
    } catch (e) {
      logger.warn(`Memento warmup failed (continuing): ${(e as Error).message}`)
    }

    logger.info(`Initialized Memento provider (db=${this.dbPath}, bin=${this.binSpec})`)

    process.once("beforeExit", () => {
      void this.client?.close()
    })
  }

  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
    if (!this.client) throw new Error("Memento provider not initialized")
    const documentIds: string[] = []
    for (const session of sessions) {
      documentIds.push(...(await this.ingestSession(session, options)))
    }
    return { documentIds }
  }

  private async ingestSession(session: UnifiedSession, options: IngestOptions): Promise<string[]> {
    const scope = scopeForContainer(options.containerTag)
    const sessionDate = session.metadata?.date as string | undefined
    const baseTags = [
      "benchmark:memorybench",
      tag("session", session.sessionId),
      sessionDate ? tag("session-date", sessionDate) : null,
    ].filter((t): t is string => t !== null)

    const cached = this.distillCache.get(session.sessionId)
    const result = cached ?? (await distillSession(session))
    if (!cached) {
      this.distillCache.set(session.sessionId, result)
    }
    if (result.candidates.length === 0) {
      logger.debug(`distill produced 0 candidates for ${session.sessionId} (skipping)`)
      return []
    }

    // `extract_memory`'s ExtractionCandidate schema is FLAT — `kind` is a
    // string enum, `language` is a top-level optional (NOT nested inside
    // kind the way write_memory's discriminated union expects). The
    // schema is strict(), so a nested kind would fail validation.
    const candidates = result.candidates.map((c) => {
      const candidate: Record<string, unknown> = {
        kind: c.kind,
        content: c.content,
        tags: baseTags,
      }
      if (c.summary) candidate.summary = c.summary
      if (c.kind === "snippet") candidate.language = "text"
      return candidate
    })

    // Chunk into batches of <= 20 to respect Memento's
    // `extraction.maxCandidatesPerCall` cap (default 20). The cap is
    // operator-tunable but we'd rather not depend on it; a strong
    // distillation prompt regularly emits more than 20 candidates from
    // a substantive session.
    const CHUNK = 20
    for (let i = 0; i < candidates.length; i += CHUNK) {
      const slice = candidates.slice(i, i + CHUNK)
      const callResult = await this.client!.callTool({
        name: "extract_memory",
        arguments: { candidates: slice, scope },
      })
      // Surface validation / scrubber rejections that would otherwise be silent.
      parseToolResultJson(callResult)
    }
    logger.info(
      `distill: session=${session.sessionId} model=${result.modelAlias} ` +
        `candidates=${result.candidates.length} ` +
        `tokens=${result.promptTokens ?? "?"}p/${result.responseTokens ?? "?"}r` +
        `${cached ? " (cached)" : ""}`
    )
    return result.candidates.map((_, i) => `distill:${session.sessionId}:${i}`)
  }

  async awaitIndexing(
    result: IngestResult,
    containerTag: string,
    onProgress?: IndexingProgressCallback
  ): Promise<void> {
    if (!this.client) throw new Error("Memento provider not initialized")
    const total = result.documentIds.length
    if (total === 0) {
      onProgress?.({ completedIds: [], failedIds: [], total: 0 })
      return
    }

    const deadline = Date.now() + this.awaitIndexingDeadlineMs
    const completed = new Set<string>()
    const failed = new Set<string>()
    const scope = scopeForContainer(containerTag)

    onProgress?.({ completedIds: [], failedIds: [], total })

    // Poll the per-question scope until either every row's embedding is
    // ready (present or disabled) or the deadline expires. `total` is the
    // synthetic candidate count from ingest; extract_memory may dedup to
    // fewer rows. We're ready when at least one row exists and none are
    // still pending.
    while (Date.now() < deadline) {
      const probe = await this.client.callTool({
        name: "search_memory",
        arguments: {
          text: "user assistant",
          scopes: [scope],
          limit: 1000,
          includeStatuses: ["active"],
          projection: "summary",
        },
      })
      const page = parseSearchPage(probe)

      for (const r of page.results) {
        const status = r.memory.embeddingStatus
        if (status === "present" || status === "disabled") {
          completed.add(r.memory.id)
        }
      }

      onProgress?.({
        completedIds: [...completed],
        failedIds: [...failed],
        total,
      })

      if (
        page.results.length > 0 &&
        page.results.every((r) => r.memory.embeddingStatus !== "pending")
      ) {
        return
      }

      await new Promise((r) => setTimeout(r, 250))
    }

    logger.warn(
      `Memento awaitIndexing hit deadline (${this.awaitIndexingDeadlineMs}ms) for ${containerTag}: ` +
        `${completed.size}/${total} ready`
    )
  }

  async search(query: string, options: SearchOptions): Promise<unknown[]> {
    if (!this.client) throw new Error("Memento provider not initialized")
    const scope = scopeForContainer(options.containerTag)
    // We deliberately ignore `options.limit` (memorybench passes 10 in
    // every call) and use the provider-configured `this.searchLimit`
    // (default 30). The 10 default is calibrated for slow cloud
    // providers; native local retrieval comfortably handles 30+ and
    // matching peers (Supermemory, Mem0, Zep) all override it the
    // same way.
    const result = await this.client.callTool({
      name: "search_memory",
      arguments: {
        text: query,
        scopes: [scope],
        limit: this.searchLimit,
        projection: "full",
      },
    })
    const page = parseSearchPage(result)
    return page.results
  }

  async clear(containerTag: string): Promise<void> {
    if (!this.client) {
      logger.warn(`Memento clear called before initialize for ${containerTag}`)
      return
    }
    const result = await this.client.callTool({
      name: "forget_many_memories",
      arguments: {
        filter: { scope: scopeForContainer(containerTag) },
        reason: "benchmark container teardown",
        confirm: true,
        dryRun: false,
      },
    })
    const payload = parseToolResultJson<{ matched: number; applied: number }>(result)
    logger.info(
      `Memento clear ${containerTag}: matched=${payload.matched} applied=${payload.applied}`
    )
  }
}

export default MementoProvider
