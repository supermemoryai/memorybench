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
import { RAGZOOM_PROMPTS } from "./prompts"

/**
 * RagZoom Memory Provider
 *
 * Connects to the RagZoom system via a thin HTTP bridge server that wraps
 * RagZoom's gRPC Python API. The bridge must be running before this
 * provider is used.
 *
 * Architecture:
 *   memorybench (TS) --HTTP--> bridge.py (Python) --gRPC--> ragzoom daemon
 *
 * Configuration (ProviderConfig):
 *   - baseUrl: URL of the bridge server (default: http://localhost:8079)
 *   - apiKey: not required (passed through but unused — RagZoom is local)
 *
 * Each benchmark run uses the containerTag as the RagZoom document_id,
 * providing full namespace isolation between runs.
 */
export class RagZoomProvider implements Provider {
  name = "ragzoom"
  prompts = RAGZOOM_PROMPTS
  concurrency = {
    default: 5,
    ingest: 3,
    indexing: 10,
  }

  private baseUrl: string = ""

  async initialize(config: ProviderConfig): Promise<void> {
    this.baseUrl = (config.baseUrl || "http://localhost:8079").replace(/\/$/, "")

    // Health check
    try {
      const resp = await fetch(`${this.baseUrl}/health`)
      if (!resp.ok) {
        throw new Error(`Bridge health check failed: ${resp.status} ${resp.statusText}`)
      }
      const data = (await resp.json()) as { status: string }
      if (data.status !== "ok") {
        throw new Error(`Bridge health check returned unexpected status: ${data.status}`)
      }
    } catch (err) {
      if (err instanceof TypeError && String(err).includes("fetch")) {
        throw new Error(
          `Cannot connect to RagZoom bridge at ${this.baseUrl}. ` +
            `Make sure the bridge server is running: python3 src/providers/ragzoom/bridge.py`
        )
      }
      throw err
    }

    logger.info(`Initialized RagZoom provider (bridge: ${this.baseUrl})`)
  }

  /**
   * Ingest sessions by converting them to AppendUnit payloads and
   * sending to the bridge's /ingest endpoint.
   *
   * Each session's messages are formatted as a text block with
   * speaker/role labels and optional timestamps. The containerTag
   * is used as the RagZoom document_id.
   */
  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
    const documentId = options.containerTag
    const units: Array<{ text: string; time_start?: string; time_end?: string }> = []

    for (const session of sessions) {
      // Format session messages into a single text block
      const formattedDate = session.metadata?.formattedDate as string
      const isoDate = session.metadata?.date as string

      let sessionText = ""
      if (formattedDate) {
        sessionText += `[Session: ${session.sessionId} | Date: ${formattedDate}]\n\n`
      } else {
        sessionText += `[Session: ${session.sessionId}]\n\n`
      }

      for (const msg of session.messages) {
        const speaker = msg.speaker || msg.role
        const timestamp = msg.timestamp ? ` (${msg.timestamp})` : ""
        sessionText += `${speaker}${timestamp}: ${msg.content}\n\n`
      }

      // Build the AppendUnit with optional temporal metadata
      const unit: { text: string; time_start?: string; time_end?: string } = {
        text: sessionText.trim(),
      }

      // If messages have timestamps, use the first and last as the time range
      const timestamps = session.messages
        .map((m) => m.timestamp)
        .filter((t): t is string => !!t)

      if (timestamps.length > 0) {
        unit.time_start = timestamps[0]
        unit.time_end = timestamps[timestamps.length - 1]
      } else if (isoDate) {
        // Fall back to session-level date
        unit.time_start = isoDate
        unit.time_end = isoDate
      }

      units.push(unit)
    }

    if (units.length === 0) {
      return { documentIds: [] }
    }

    const resp = await fetch(`${this.baseUrl}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        document_id: documentId,
        units,
      }),
    })

    if (!resp.ok) {
      const detail = await resp.text()
      throw new Error(`RagZoom ingest failed: ${resp.status} ${detail}`)
    }

    const result = (await resp.json()) as { document_id: string; chunks_created: number }
    logger.debug(
      `Ingested ${sessions.length} sessions into doc "${documentId}" (${result.chunks_created} chunks created)`
    )

    // Return the document_id as the single "document" for indexing tracking
    return { documentIds: [documentId] }
  }

  /**
   * Poll the bridge's /status endpoint until the document is fully indexed.
   *
   * RagZoom indexes asynchronously via background workers that build the
   * summary tree. We poll completion_pct until it reaches 100% or there
   * is no pending work.
   */
  async awaitIndexing(
    result: IngestResult,
    containerTag: string,
    onProgress?: IndexingProgressCallback
  ): Promise<void> {
    const documentIds = result.documentIds
    if (documentIds.length === 0) {
      onProgress?.({ completedIds: [], failedIds: [], total: 0 })
      return
    }

    const total = documentIds.length
    const completedIds: string[] = []
    const failedIds: string[] = []
    let backoffMs = 1000

    onProgress?.({ completedIds: [], failedIds: [], total })

    const pending = new Set(documentIds)

    while (pending.size > 0) {
      for (const docId of Array.from(pending)) {
        try {
          const resp = await fetch(`${this.baseUrl}/status/${encodeURIComponent(docId)}`)
          if (!resp.ok) {
            logger.warn(`Status check failed for ${docId}: ${resp.status}`)
            continue
          }

          const status = (await resp.json()) as {
            exists: boolean
            completion_pct: number
            has_pending_work: boolean
          }

          if (!status.exists) {
            // Document hasn't been created yet — still processing
            continue
          }

          // Done when completion is 100% or no pending work
          if (status.completion_pct >= 100.0 || !status.has_pending_work) {
            pending.delete(docId)
            completedIds.push(docId)
            logger.debug(`Document "${docId}" indexing complete (${status.completion_pct}%)`)
          } else {
            logger.debug(
              `Document "${docId}" indexing: ${status.completion_pct.toFixed(1)}%, pending work: ${status.has_pending_work}`
            )
          }
        } catch (err) {
          logger.warn(`Error checking status for ${docId}: ${err}`)
        }
      }

      onProgress?.({ completedIds: [...completedIds], failedIds: [...failedIds], total })

      if (pending.size > 0) {
        await new Promise((r) => setTimeout(r, backoffMs))
        backoffMs = Math.min(backoffMs * 1.5, 10000)
      }
    }

    if (failedIds.length > 0) {
      logger.warn(`${failedIds.length} documents failed indexing`)
    }
  }

  /**
   * Search via RagZoom's agentic search endpoint.
   *
   * Returns an array with a single result object containing the
   * synthesized answer from the search agent.
   */
  async search(query: string, options: SearchOptions): Promise<unknown[]> {
    const documentId = options.containerTag

    const resp = await fetch(`${this.baseUrl}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: query,
        document_id: documentId,
      }),
    })

    if (!resp.ok) {
      const detail = await resp.text()
      throw new Error(`RagZoom search failed: ${resp.status} ${detail}`)
    }

    const result = (await resp.json()) as { answer: string }

    logger.debug(`Search for "${query.substring(0, 50)}..." returned answer (${result.answer.length} chars)`)

    // Return as array for consistency with other providers
    return [
      {
        answer: result.answer,
        document_id: documentId,
        question: query,
      },
    ]
  }

  /**
   * Clear a document by sending a POST to the bridge's /clear endpoint.
   */
  async clear(containerTag: string): Promise<void> {
    try {
      const resp = await fetch(`${this.baseUrl}/clear`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document_id: containerTag }),
      })

      if (!resp.ok) {
        const detail = await resp.text()
        logger.warn(`Clear failed for "${containerTag}": ${resp.status} ${detail}`)
        return
      }

      logger.info(`Cleared RagZoom document: ${containerTag}`)
    } catch (err) {
      logger.warn(`Error clearing document "${containerTag}": ${err}`)
    }
  }
}

export default RagZoomProvider
