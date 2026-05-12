/**
 * JSON-RPC 2.0 client for Sandra's MCP HTTP server. Ports the behavior of
 * `sandra/benchmark/longmemeval/src/sandra_mcp_client.py` so both benchmarks
 * share the exact same wire-level contract.
 *
 * Session lifecycle: first tool call lazily sends `initialize`, then the
 * `notifications/initialized` fire-and-forget, carrying the `Mcp-Session-Id`
 * returned by the server on subsequent requests. The server may respond in
 * either `application/json` or `text/event-stream`; we extract the first
 * `data:` line when streamed.
 */

import { logger } from "../../utils/logger"

export interface SandraConfig {
  url: string
  token?: string
  timeoutMs?: number
}

export class SandraMCPError extends Error {}

interface JsonRpcEnvelope {
  jsonrpc: "2.0"
  id?: string
  method?: string
  params?: unknown
  result?: { content?: Array<{ type: string; text: string }> } & Record<string, unknown>
  error?: { code: number; message: string; data?: unknown }
}

export class SandraMCPClient {
  private readonly url: string
  private readonly token: string | undefined
  private readonly timeoutMs: number
  private sessionId: string | undefined
  private initialized = false
  private initPromise: Promise<void> | null = null

  constructor(config: SandraConfig) {
    this.url = config.url
    this.token = config.token
    this.timeoutMs = config.timeoutMs ?? 600_000
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    }
    if (this.token) h["Authorization"] = `Bearer ${this.token}`
    if (this.sessionId) h["Mcp-Session-Id"] = this.sessionId
    return h
  }

  private async post(body: unknown): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      return await fetch(this.url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return
    if (!this.initPromise) {
      this.initPromise = this.doInitialize()
    }
    await this.initPromise
  }

  private async doInitialize(): Promise<void> {
    const initPayload = {
      jsonrpc: "2.0" as const,
      id: `init-${crypto.randomUUID().slice(0, 8)}`,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "memorybench-sandra", version: "0.1" },
      },
    }
    const resp = await this.post(initPayload)
    if (!resp.ok) {
      const text = await resp.text()
      throw new SandraMCPError(
        `MCP initialize failed: HTTP ${resp.status}: ${text.slice(0, 300)}`
      )
    }
    const sid = resp.headers.get("Mcp-Session-Id") || resp.headers.get("mcp-session-id")
    if (sid) this.sessionId = sid
    // drain body so the connection is returned to the pool
    await resp.text()

    const notify = {
      jsonrpc: "2.0" as const,
      method: "notifications/initialized",
      params: {},
    }
    // fire-and-forget
    try {
      await this.post(notify)
    } catch (e) {
      logger.debug(`notifications/initialized post failed: ${e}`)
    }
    this.initialized = true
  }

  async callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    await this.ensureInitialized()

    const payload = {
      jsonrpc: "2.0" as const,
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name, arguments: args },
    }

    // The built-in Bun HTTP server in Sandra occasionally drops concurrent
    // keep-alive connections ("socket connection was closed unexpectedly").
    // One retry with exponential backoff handles the spurious drops without
    // masking real problems.
    const MAX_ATTEMPTS = 3
    let lastErr: unknown
    let resp: Response | null = null
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        resp = await this.post(payload)
        break
      } catch (e) {
        lastErr = e
        if (attempt === MAX_ATTEMPTS) throw e
        const msg = e instanceof Error ? e.message : String(e)
        logger.debug(
          `MCP ${name} attempt ${attempt}/${MAX_ATTEMPTS} failed: ${msg}. Retrying...`
        )
        await new Promise((r) => setTimeout(r, 250 * attempt))
      }
    }
    if (!resp) throw lastErr

    if (!resp.ok) {
      const text = await resp.text()
      throw new SandraMCPError(`HTTP ${resp.status} from MCP: ${text.slice(0, 500)}`)
    }
    const raw = (await resp.text()).trim()

    let body = raw
    if (body.startsWith("event:") || body.startsWith("data:")) {
      for (const line of body.split("\n")) {
        if (line.startsWith("data:")) {
          body = line.slice(5).trim()
          break
        }
      }
    }

    let data: JsonRpcEnvelope
    try {
      data = JSON.parse(body) as JsonRpcEnvelope
    } catch (e) {
      throw new SandraMCPError(`Non-JSON body from MCP: ${body.slice(0, 300)}`)
    }
    if (data.error) {
      throw new SandraMCPError(
        `MCP error ${data.error.code}: ${data.error.message}`
      )
    }
    const result = data.result ?? {}
    const content = result.content
    if (Array.isArray(content) && content.length > 0 && content[0]?.type === "text") {
      const text = content[0].text
      try {
        return JSON.parse(text) as T
      } catch {
        return text as unknown as T
      }
    }
    return result as unknown as T
  }

  // Typed convenience wrappers ------------------------------------------------

  batch(payload: {
    concepts?: string[]
    entities?: Array<{ factory: string; refs: Record<string, unknown>; storage?: string }>
    triplets?: Array<{
      subject: string | number
      verb: string | number
      target: string | number
      refs?: Record<string, unknown>
    }>
  }): Promise<SandraBatchResult> {
    return this.callTool<SandraBatchResult>("sandra_batch", {
      concepts: payload.concepts ?? [],
      entities: payload.entities ?? [],
      triplets: payload.triplets ?? [],
    })
  }

  semanticSearch(args: {
    query: string
    factory?: string
    limit?: number
    threshold?: number
    include_storage?: boolean
    fields?: string[]
  }): Promise<{ results?: SandraEntityHit[] } | SandraEntityHit[]> {
    return this.callTool("sandra_semantic_search", args as Record<string, unknown>)
  }

  search(args: {
    query?: string
    factory?: string
    field?: string
    limit?: number
    fields?: string[]
    include_storage?: boolean
  }): Promise<{ results?: SandraEntityHit[] } | SandraEntityHit[]> {
    return this.callTool("sandra_search", args as Record<string, unknown>)
  }

  embedAll(args: { factory?: string; limit?: number }): Promise<{ embedded?: number }> {
    return this.callTool("sandra_embed_all", args as Record<string, unknown>)
  }

  listEntities(args: {
    factory: string
    limit?: number
    offset?: number
    fields?: string[]
    include_storage?: boolean
  }): Promise<{ entities?: SandraEntityHit[] } | SandraEntityHit[]> {
    return this.callTool("sandra_list_entities", args as Record<string, unknown>)
  }
}

export interface SandraBatchResult {
  summary?: {
    entitiesCreated?: number
    tripletsCreated?: number
    conceptsCreated?: number
    refsAttached?: number
  }
  entities?: Array<{ id?: number; factory?: string }>
  [key: string]: unknown
}

export interface SandraEntityHit {
  id?: number
  factory?: string
  refs?: Record<string, string>
  storage?: string
  similarity?: number
  score?: number
  [key: string]: unknown
}
