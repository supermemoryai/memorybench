/**
 * engram-trinity provider for MemoryBench
 *
 * Wraps the full Cartisien Trinity stack:
 *   Cogito (lifecycle/identity)
 *     → Engram (semantic memory, FTS5, hybrid search)
 *       → Extensa+Qdrant (vector backend) if TRINITY_QDRANT=1, else SQLite
 *
 * During ingest, each containerTag gets a dedicated Cogito instance that
 * calls wake() → trace(INTERACTION) per message → sleep().  The raw turns
 * are also written to Engram via remember() so that the FTS5/hybrid recall
 * path is identical to engram-mcp.
 *
 * Env vars:
 *   TRINITY_DB         - SQLite path (default: /tmp/engram-trinity-bench.db)
 *   TRINITY_TOPK       - search K (default: 100, matches V27+K100 baseline)
 *   TRINITY_QDRANT     - '1' to use Qdrant vector backend (requires TRINITY_QDRANT_URL)
 *   TRINITY_QDRANT_URL - Qdrant base URL (default: http://localhost:6333)
 *   ENGRAM_SEMANTIC    - '1' to enable semantic search
 */

import type { Provider, ProviderConfig, IngestOptions, IngestResult, SearchOptions } from '../../types/provider'
import type { UnifiedSession } from '../../types/unified'
import { Engram } from '@cartisien/engram'
import { Cogito } from '@cartisien/cogito'
import { TraceType } from '@cartisien/cogito'
import { existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'

const DB_PATH = process.env.TRINITY_DB ?? '/tmp/engram-trinity-bench.db'
const DEFAULT_TOPK = parseInt(process.env.TRINITY_TOPK ?? '100', 10)
const USE_COGITO = process.env.TRINITY_USE_COGITO === '1'
const SEMANTIC = process.env.ENGRAM_SEMANTIC === '1'
const USE_QDRANT = process.env.TRINITY_QDRANT === '1'
const QDRANT_URL = process.env.TRINITY_QDRANT_URL ?? 'http://localhost:6333'

// Common English stopwords — stripped from FTS queries
const STOPWORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with',
  'by','from','is','are','was','were','be','been','being','have','has','had',
  'do','does','did','will','would','could','should','may','might','must','can',
  'what','where','when','who','which','how','why','that','this','these','those',
  'it','its','he','she','they','we','you','i','my','your','his','her','their',
  'not','no','if','as','about','into','through','during','before','after',
  'above','below','between','did','does','been','their','there',
])

// Strip question-word prefixes and extract keywords for FTS
function extractKeywords(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/['''`]/g, '')          // strip possessives (Caroline's → carolines, then split)
    .replace(/[^\w\s]/g, ' ')        // strip punctuation
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOPWORDS.has(w))
    .slice(0, 8)                     // cap at 8 keywords
}

// Build FTS5 OR query from keywords — each keyword optionally quoted
function buildFtsQuery(keywords: string[]): string {
  if (keywords.length === 0) return ''
  return keywords.map(k => `"${k}"`).join(' OR ')
}

// Single shared Engram instance — FTS queries use its internal db to avoid
// dual-connection WAL snapshot issues that caused 0-result searches in k100-fixed.
let engram: Engram | null = null

// Fix 3: Cogito instances keyed by convId (e.g. "conv-26"), not containerTag.
// One wake/sleep per conversation instead of one per question (~7 vs ~1194 cycles).
const cogitoInstances = new Map<string, any>()

async function getEngram(): Promise<Engram> {
  if (engram) return engram
  const dir = dirname(DB_PATH)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  engram = new Engram({
    dbPath: DB_PATH,
    semanticSearch: SEMANTIC,
    graphMemory: true,
    enableFTS5: true,
    enableWAL: true,
    maxContextLength: 6000,
    dedupThreshold: 0.97,
    recencyHalfLifeDays: 365,
    ...(USE_QDRANT
      ? { vectorBackend: 'qdrant' as const, qdrantUrl: QDRANT_URL }
      : {}),
  })
  await engram.init()
  return engram
}

// Get Engram's internal db handle — single connection avoids WAL snapshot issues.
async function getDb() {
  const e = await getEngram()
  return (e as any).db
}

// Direct FTS5 search with OR semantics — bypasses Engram's AND-only FTS path.
// Also unions the cogito:state session (Fix 2) for additional recall coverage.
async function ftsSearch(sessionId: string, query: string, limit: number) {
  const db = await getDb()
  const keywords = extractKeywords(query)

  // cogito:state session pattern — traces written by Cogito during ingest
  const cogitoSessionId = `cogito:state:${sessionId}:trinity-bench-${sessionId}`

  if (keywords.length === 0) {
    // Fallback: return most recent entries from both sessions, deduplicated by content_hash
    return db.all(
      `SELECT m.id, m.content, m.metadata, m.tier, NULL as fts_rank
       FROM memories m
       WHERE m.session_id IN (?, ?) AND m.tier != 'archived'
       GROUP BY m.content_hash
       ORDER BY m.timestamp DESC LIMIT ?`,
      [sessionId, cogitoSessionId, limit]
    )
  }

  const ftsQuery = buildFtsQuery(keywords)
  // Union both sessions, deduplicate on content_hash, keep best rank
  return db.all(
    `SELECT id, content, metadata, tier, fts_rank FROM (
       SELECT m.id, m.content, m.metadata, m.tier,
              rank as fts_rank,
              m.content_hash,
              ROW_NUMBER() OVER (PARTITION BY m.content_hash ORDER BY rank) as rn
       FROM memories_fts
       JOIN memories m ON memories_fts.rowid = m.rowid
       WHERE memories_fts MATCH ? AND m.session_id IN (?, ?) AND m.tier != 'archived'
     ) WHERE rn = 1
     ORDER BY fts_rank
     LIMIT ?`,
    [ftsQuery, sessionId, cogitoSessionId, limit]
  )
}

// Extract speaker label from session metadata
function speakerLabel(session: UnifiedSession, role: 'user' | 'assistant'): string {
  const meta = session.metadata as Record<string, unknown> | undefined
  if (role === 'user') return (meta?.['user'] as string) ?? 'Person A'
  return (meta?.['assistant'] as string) ?? 'Person B'
}

export class EngramTrinityProvider implements Provider {
  name = 'engram-trinity'
  concurrency = { default: 1, ingest: 1, search: 4, indexing: 1 }

  async initialize(_config: ProviderConfig): Promise<void> {
    await getEngram()
  }

  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
    const db = await getEngram()
    const { containerTag } = options
    const ids: string[] = []

    // Fix 3: derive convId from containerTag (e.g. "conv-26-q7-run" → "conv-26")
    // One Cogito instance per conversation, not per question.
    const convId = containerTag.match(/^(conv-\d+)/)?.[1] ?? containerTag

    let cogito: any = null
    if (USE_COGITO) {
      if (!cogitoInstances.has(convId)) {
        const instance = new Cogito({
          id: `trinity-bench-${convId}`,
          identityConfig: { name: 'MemoryBench Trinity', role: 'benchmark-agent' },
          stateConfig: {
            persistence: 'engram',
            engram: db as any,
            sessionId: `cogito:state:${convId}`,
          },
        })
        await instance.wake()
        cogitoInstances.set(convId, instance)
      }
      cogito = cogitoInstances.get(convId)!
    }

    for (const session of sessions) {
      for (const msg of session.messages) {
        const content = (msg.content || '').trim()
        if (!content) continue

        const speaker = msg.speaker ?? speakerLabel(session, msg.role)
        const text = `[${speaker}]: ${content}`

        // Persist the raw turn to Engram (provides FTS5 + hybrid recall)
        const entry = await db.remember(containerTag, text, msg.role, {
          sessionId: session.sessionId,
          speaker: msg.speaker ?? speaker,
          timestamp: msg.timestamp,
        })
        ids.push(entry.id)

        // Record a MemoryTrace in Cogito if enabled
        if (cogito) {
          cogito.trace({
            type: TraceType.INTERACTION,
            content: text,
            metadata: {
              role: msg.role,
              sessionId: session.sessionId,
              timestamp: msg.timestamp,
              memoryId: entry.id,
            },
          })
        }
      }
    }

    return { documentIds: ids }
  }

  // Call once per benchmark run to flush all Cogito instances
  async flushCogito(): Promise<void> {
    for (const [, instance] of cogitoInstances) {
      try { await instance.sleep() } catch { /* best-effort */ }
    }
    cogitoInstances.clear()
  }

  async awaitIndexing(_result: IngestResult, _containerTag: string): Promise<void> {
    // FTS5 is synchronous — no async indexing needed
  }

  async search(query: string, options: SearchOptions): Promise<unknown[]> {
    const { containerTag, limit } = options
    const k = limit ?? DEFAULT_TOPK

    // Use direct FTS5 with OR semantics for better recall
    const results = await ftsSearch(containerTag, query, k)

    return results.map((r: any) => ({
      id: r.id,
      content: r.content,
      metadata: {
        ...(r.metadata ? JSON.parse(r.metadata) : {}),
        tier: r.tier,
        fts_rank: r.fts_rank,
      },
    }))
  }

  async clear(containerTag: string): Promise<void> {
    const db = await getEngram()
    await db.forget(containerTag, {})
  }
}

export default EngramTrinityProvider
