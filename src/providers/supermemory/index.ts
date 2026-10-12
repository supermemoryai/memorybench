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
import { SUPERMEMORY_PROMPTS } from "./prompts"

/**
 * Tunable settings from the public v5 API (https://api.supermemory.ai/reference).
 * Anything left unset is omitted from requests, so an empty config is the API's out-of-the-box behaviour.
 */
export interface SupermemorySettings {
  /** Guides memory extraction (max 1500 chars). {speakerA}/{speakerB} are filled from the session. */
  supportingContext?: string
  dreaming?: "dynamic" | "instant"
  searchMode?: "hybrid" | "memories" | "chunks"
  limit?: number
  threshold?: number
  rerank?: "none" | "order" | "aggregate"
  rewriteQuery?: boolean
  include?: { documents?: boolean; related?: boolean }
}

const SETTING_KEYS: (keyof SupermemorySettings)[] = [
  "supportingContext",
  "dreaming",
  "searchMode",
  "limit",
  "threshold",
  "rerank",
  "rewriteQuery",
  "include",
]

/** Namespaces allow [a-zA-Z0-9_:-], max 100 chars */
function toNamespace(containerTag: string): string {
  return containerTag.replace(/[^a-zA-Z0-9_:-]/g, "_").slice(0, 100)
}

/** "Name: message" lines under a "Session date:" header */
export function formatSession(session: UnifiedSession): string {
  const date = session.metadata?.formattedDate as string | undefined
  const lines = session.messages.map((m) => `${m.speaker || m.role}: ${m.content}`)
  return (date ? `Session date: ${date}\n\n` : "") + lines.join("\n")
}

export class SupermemoryProvider implements Provider {
  name = "supermemory"
  prompts = SUPERMEMORY_PROMPTS
  concurrency = {
    default: 50,
    ingest: 20,
    indexing: 50,
  }
  private apiKey = ""
  private baseUrl = "https://api.supermemory.ai"
  private settings: SupermemorySettings = {}

  async initialize(config: ProviderConfig): Promise<void> {
    if (!config.apiKey) throw new Error("SUPERMEMORY_API_KEY is not set")
    this.apiKey = config.apiKey
    if (config.baseUrl) this.baseUrl = config.baseUrl.replace(/\/$/, "")
    for (const key of SETTING_KEYS) {
      if (config[key] !== undefined) (this.settings as Record<string, unknown>)[key] = config[key]
    }
    const unknown = Object.keys(config).filter(
      (k) => !["apiKey", "baseUrl", ...SETTING_KEYS].includes(k)
    )
    if (unknown.length > 0)
      logger.warn(`Unknown Supermemory settings ignored: ${unknown.join(", ")}`)
    logger.info(
      `Initialized Supermemory provider (v5 API, settings: ${Object.keys(this.settings).length ? JSON.stringify(this.settings) : "API defaults"})`
    )
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (res.ok) return (await res.json()) as T
      const text = await res.text()
      if ((res.status === 429 || res.status >= 500) && attempt < 8) {
        // Wait at least as long as the API asks (retryAfterSeconds / Retry-After), with jitter
        const asked =
          Number(res.headers.get("retry-after")) ||
          Number(text.match(/"retryAfterSeconds":\s*(\d+)/)?.[1]) ||
          0
        const waitMs = Math.max(asked * 1000, Math.min(1000 * 2 ** attempt, 30000))
        await new Promise((r) => setTimeout(r, waitMs + Math.random() * 1000))
        continue
      }
      throw new Error(`Supermemory ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`)
    }
  }

  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
    const namespace = toNamespace(options.containerTag)
    const documentIds: string[] = []

    for (const session of sessions) {
      const speakerA = (session.metadata?.speakerA as string) || ""
      const speakerB = (session.metadata?.speakerB as string) || ""
      const supportingContext = this.settings.supportingContext
        ?.replaceAll("{speakerA}", speakerA)
        .replaceAll("{speakerB}", speakerB)

      const response = await this.request<{ id: string; status: string }>(
        "POST",
        `/ns/${namespace}/document`,
        {
          id: session.sessionId,
          content: formatSession(session),
          // Relative times in the content resolve against this date
          ...(session.metadata?.date ? { date: session.metadata.date } : {}),
          metadata: {
            sessionId: session.sessionId,
            ...(session.metadata?.formattedDate
              ? { sessionDate: session.metadata.formattedDate }
              : {}),
          },
          ...(supportingContext ? { supportingContext } : {}),
          ...(this.settings.dreaming ? { dreaming: this.settings.dreaming } : {}),
        }
      )
      documentIds.push(response.id)
      logger.debug(`Ingested session ${session.sessionId} (${response.status})`)
    }

    return { documentIds }
  }

  async awaitIndexing(
    result: IngestResult,
    containerTag: string,
    onProgress?: IndexingProgressCallback
  ): Promise<void> {
    const namespace = toNamespace(containerTag)
    const total = result.documentIds.length
    const pending = new Set(result.documentIds)
    const completedIds: string[] = []
    const failedIds: string[] = []
    let backoffMs = 2000

    onProgress?.({ completedIds: [], failedIds: [], total })

    while (pending.size > 0) {
      const checks = await Promise.allSettled(
        Array.from(pending).map(async (id) => {
          const doc = await this.request<{ system?: { status?: string } }>(
            "GET",
            `/ns/${namespace}/document/${encodeURIComponent(id)}`
          )
          let status = doc.system?.status || "unknown"
          if (status === "done") {
            // v5 "done" covers chunks only; memory extraction status is on the v3 document
            const v3 = await this.request<{ dreamingStatus?: string }>(
              "GET",
              `/v3/documents/${encodeURIComponent(id)}?namespace=${namespace}`
            )
            if (v3.dreamingStatus && v3.dreamingStatus !== "done") status = v3.dreamingStatus
          }
          return { id, status }
        })
      )

      for (const check of checks) {
        if (check.status !== "fulfilled") continue
        const { id, status } = check.value
        if (status === "done") {
          pending.delete(id)
          completedIds.push(id)
        } else if (status === "failed" || status === "error") {
          pending.delete(id)
          failedIds.push(id)
        }
      }

      onProgress?.({ completedIds: [...completedIds], failedIds: [...failedIds], total })
      if (pending.size > 0) {
        await new Promise((r) => setTimeout(r, backoffMs))
        backoffMs = Math.min(backoffMs * 1.2, 10000)
      }
    }

    if (failedIds.length > 0) logger.warn(`${failedIds.length} documents failed indexing`)
  }

  async search(query: string, options: SearchOptions): Promise<unknown[]> {
    const s = this.settings
    const response = await this.request<{ results?: unknown[] }>(
      "POST",
      `/ns/${toNamespace(options.containerTag)}/search`,
      {
        query,
        limit: s.limit ?? options.limit,
        threshold: s.threshold ?? options.threshold,
        ...(s.searchMode ? { searchMode: s.searchMode } : {}),
        ...(s.rerank ? { rerank: s.rerank } : {}),
        ...(s.rewriteQuery !== undefined ? { rewriteQuery: s.rewriteQuery } : {}),
        ...(s.include ? { include: s.include } : {}),
      }
    )
    return response.results || []
  }

  async clear(containerTag: string): Promise<void> {
    logger.warn(`Clear not implemented for Supermemory - containerTag: ${containerTag}`)
  }
}

export default SupermemoryProvider
