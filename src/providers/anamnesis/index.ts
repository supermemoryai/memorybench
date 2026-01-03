import Database from "bun:sqlite"
import { createOpenAI } from "@ai-sdk/openai"
import { generateText } from "ai"
import type { Provider, ProviderConfig, IngestOptions, IngestResult, SearchOptions } from "../../types/provider"
import type { UnifiedSession } from "../../types/unified"
import { logger } from "../../utils/logger"
import { config } from "../../utils/config"
import { ANAMNESIS_PROMPTS } from "./prompts"

/**
 * Extracted observation structure matching production claude-mem.
 */
interface ExtractedObservation {
    title: string
    subtitle: string
    facts: string[]
    narrative: string
    type: string
    concepts: string[]
}

/**
 * Extraction prompt - matches production claude-mem XML format.
 * Uses structured facts array to preserve specific details like dates.
 */
const EXTRACTION_PROMPT = `You are a memory extraction system. Extract key facts from this conversation using structured observations.

CRITICAL: Preserve ALL specific details, especially:
- EXACT DATES (e.g., "7 May 2023", "last Tuesday")
- SPECIFIC TIMES (e.g., "at 2pm", "morning")
- NUMBERS (ages, amounts, durations)
- NAMES (people, places, organizations)

Output XML observations in this exact format:

<observations>
<observation>
  <type>fact</type>
  <title>Brief title (5-7 words)</title>
  <subtitle>One sentence context</subtitle>
  <facts>
    <fact>First specific fact with exact details</fact>
    <fact>Second specific fact including any dates/numbers</fact>
    <fact>Third fact preserving temporal information</fact>
  </facts>
  <narrative>2-3 sentence summary connecting the facts</narrative>
  <concepts>
    <concept>category-tag</concept>
  </concepts>
</observation>
</observations>

Focus on:
- Life events and WHEN they occurred (exact dates if mentioned)
- Personal preferences with specific details
- Relationships and how people are connected
- Activities and hobbies with timeframes
- Health, work, and future plans

Conversation to analyze:
`

/**
 * AnamnesisProvider - MemoryBench provider for Tim's claude-mem memory system.
 *
 * Anamnesis (Greek: ἀνάμνησις) - Plato's concept that learning is recollection.
 * This reflects Claude's reality: we don't truly "remember" between sessions,
 * we reconstruct memory from stored artifacts.
 *
 * Architecture:
 * - Ingest: Direct SQLite inserts (worker API is hook-based, not for bulk ingestion)
 * - Search: HTTP calls to worker's MCP search endpoint
 * - Clear: Direct SQLite deletes by namespace
 */
export class AnamnesisProvider implements Provider {
    name = "anamnesis"
    prompts = ANAMNESIS_PROMPTS
    private workerUrl: string = ""
    private dbPath: string = ""
    private containerTags: Set<string> = new Set()
    private extractionMode: boolean = false


    /**
     * Parse XML observations from LLM response.
     */
    private parseXmlObservations(xml: string): ExtractedObservation[] {
        const observations: ExtractedObservation[] = []
        const obsMatches = xml.matchAll(/<observation>([\s\S]*?)<\/observation>/g)

        for (const match of obsMatches) {
            const obsXml = match[1]

            const typeMatch = obsXml.match(/<type>([\s\S]*?)<\/type>/)
            const titleMatch = obsXml.match(/<title>([\s\S]*?)<\/title>/)
            const subtitleMatch = obsXml.match(/<subtitle>([\s\S]*?)<\/subtitle>/)
            const narrativeMatch = obsXml.match(/<narrative>([\s\S]*?)<\/narrative>/)

            // Extract facts array
            const facts: string[] = []
            const factMatches = obsXml.matchAll(/<fact>([\s\S]*?)<\/fact>/g)
            for (const factMatch of factMatches) {
                facts.push(factMatch[1].trim())
            }

            // Extract concepts array
            const concepts: string[] = []
            const conceptMatches = obsXml.matchAll(/<concept>([\s\S]*?)<\/concept>/g)
            for (const conceptMatch of conceptMatches) {
                concepts.push(conceptMatch[1].trim())
            }

            if (titleMatch && narrativeMatch) {
                observations.push({
                    type: typeMatch?.[1]?.trim() || "fact",
                    title: titleMatch[1].trim(),
                    subtitle: subtitleMatch?.[1]?.trim() || "",
                    facts,
                    narrative: narrativeMatch[1].trim(),
                    concepts
                })
            }
        }

        return observations
    }

    /**
     * Extract observations from a conversation using LLM extraction.
     * Matches production claude-mem XML format with facts array.
     */
    private async extractObservations(conversationText: string, sessionDate?: string): Promise<ExtractedObservation[]> {
        if (!config.openaiApiKey) {
            logger.warn("No OpenAI API key - falling back to raw storage")
            return []
        }

        const client = createOpenAI({ apiKey: config.openaiApiKey })

        try {
            const result = await generateText({
                model: client("gpt-4.1-mini"),
                messages: [{ role: "user", content: EXTRACTION_PROMPT + conversationText }],
            })

            // Parse XML observations
            const text = result.text.trim()
            const observations = this.parseXmlObservations(text)

            if (observations.length === 0) {
                logger.warn("Extraction returned no valid observations, falling back to raw storage")
                return []
            }

            // Add session date context to narrative
            if (sessionDate) {
                return observations.map(obs => ({
                    ...obs,
                    narrative: `[${sessionDate}] ${obs.narrative}`
                }))
            }
            return observations
        } catch (e) {
            logger.warn(`Extraction failed: ${e}, falling back to raw storage`)
            return []
        }
    }

    async initialize(providerConfig: ProviderConfig): Promise<void> {
        this.workerUrl = providerConfig.baseUrl || process.env.ANAMNESIS_WORKER_URL || "http://localhost:37777"
        this.dbPath = process.env.ANAMNESIS_DB || `${process.env.HOME}/.claude-mem/claude-mem.db`

        // Check for extraction mode - when enabled, uses LLM to extract observations
        // like Mem0 does, rather than storing raw transcripts
        this.extractionMode = process.env.ANAMNESIS_EXTRACTION === "true"
        if (this.extractionMode) {
            logger.info("Extraction mode ENABLED - will use LLM to extract observations (like Mem0)")
        } else {
            logger.info("Extraction mode disabled - storing raw transcripts (RAG mode)")
        }

        // Verify worker is running
        try {
            const health = await fetch(`${this.workerUrl}/api/health`, {
                signal: AbortSignal.timeout(5000)
            })
            if (!health.ok) {
                throw new Error(`Worker health check failed: ${health.status}`)
            }
            const healthData = await health.json() as { status: string }
            logger.info(`Anamnesis worker connected: ${healthData.status}`)
        } catch (e) {
            throw new Error(`Anamnesis worker not running at ${this.workerUrl}. Run 'mem-status' to check.`)
        }

        // Verify database exists
        try {
            const db = new Database(this.dbPath, { readonly: true })
            const result = db.query("SELECT COUNT(*) as count FROM observations").get() as { count: number }
            logger.info(`Anamnesis database connected: ${result.count} existing observations`)
            db.close()
        } catch (e) {
            throw new Error(`Anamnesis database not found at ${this.dbPath}`)
        }

        logger.info(`Initialized Anamnesis provider`)
    }

    async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
        const containerTag = options.containerTag
        this.containerTags.add(containerTag)
        const documentIds: string[] = []

        const db = new Database(this.dbPath)
        // Enable WAL mode and busy timeout for better concurrent access
        db.exec("PRAGMA journal_mode = WAL")
        db.exec("PRAGMA busy_timeout = 30000") // Wait up to 30s for locks
        const now = Date.now()
        const nowISO = new Date(now).toISOString()

        // Prepare insert statement
        const insert = db.prepare(`
            INSERT INTO observations (
                memory_session_id, project, type, title, subtitle,
                narrative, facts, concepts, files_read, files_modified,
                created_at, created_at_epoch, namespace, confidence
            ) VALUES (
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?
            )
        `)

        // Process each session
        for (const session of sessions) {
            const formattedDate = session.metadata?.formattedDate as string | undefined
            const datePrefix = formattedDate
                ? `[Conversation Date: ${formattedDate}]\n\n`
                : ''

            const conversationText = datePrefix + session.messages
                .map(m => `[${m.speaker || m.role}]: ${m.content}`)
                .join("\n\n")

            // EXTRACTION MODE: Use LLM to extract semantic observations (like Mem0)
            if (this.extractionMode) {
                const extractedObs = await this.extractObservations(conversationText, formattedDate)

                if (extractedObs.length > 0) {
                    for (const obs of extractedObs) {
                        // Combine extracted concepts with benchmark tags
                        const concepts = [...obs.concepts, "benchmark", "memorybench", containerTag, "extracted"]
                        const result = insert.run(
                            `memorybench-${containerTag}`,   // memory_session_id
                            "memorybench",                   // project
                            obs.type || "discovery",         // type (semantic type from extraction)
                            obs.title,                       // title from extraction
                            obs.subtitle || `Extracted from ${session.sessionId}`,  // subtitle
                            obs.narrative,                   // narrative from extraction
                            JSON.stringify(obs.facts),       // facts array (preserves dates!)
                            JSON.stringify(concepts),        // concepts from extraction + tags
                            "[]",                            // files_read
                            "[]",                            // files_modified
                            nowISO,                          // created_at
                            now,                             // created_at_epoch
                            containerTag,                    // namespace
                            0.8                              // confidence
                        )
                        documentIds.push(result.lastInsertRowid.toString())
                    }
                    logger.debug(`Extracted ${extractedObs.length} observations from session ${session.sessionId}`)
                    continue
                }
                // Fall through to raw storage if extraction failed
                logger.warn(`Extraction failed for ${session.sessionId}, using raw storage`)
            }

            // RAW MODE: Store full conversation text (default behavior)
            const facts = session.messages
                .filter(m => m.role === "assistant" || m.speaker)
                .map(m => m.content.slice(0, 500))

            const dateStr = formattedDate ? ` (${formattedDate})` : ''
            const result = insert.run(
                `memorybench-${containerTag}`,  // memory_session_id
                "memorybench",                   // project
                "fact",                          // type (benchmark data is factual)
                `Session ${session.sessionId}${dateStr}`,  // title with date
                `MemoryBench session with ${session.messages.length} messages`,  // subtitle
                conversationText,                // narrative (full conversation)
                JSON.stringify(facts),           // facts (individual message excerpts)
                JSON.stringify(["benchmark", "memorybench", containerTag]),  // concepts
                "[]",                            // files_read
                "[]",                            // files_modified
                nowISO,                          // created_at
                now,                             // created_at_epoch
                containerTag,                    // namespace (for easy cleanup)
                0.8                              // confidence (benchmark data is reliable)
            )

            documentIds.push(result.lastInsertRowid.toString())
            logger.debug(`Ingested session ${session.sessionId} as observation ${result.lastInsertRowid}`)
        }

        db.close()

        logger.info(`Ingested ${sessions.length} sessions for container ${containerTag}`)
        return { documentIds }
    }

    async awaitIndexing(result: IngestResult, containerTag: string): Promise<void> {
        // SQLite inserts are synchronous, but ChromaDB needs embeddings for semantic search
        // Call the worker's on-demand sync endpoint to embed the new observations

        if (result.documentIds.length === 0) {
            logger.debug(`No documents to index for ${containerTag}`)
            return
        }

        const allIds = result.documentIds.map(id => parseInt(id, 10))

        // Batch embeddings - keep batches small since embedding is ~9s per observation
        // 20 obs × 9s = 180s, plus overhead → 5 min timeout for safety
        const BATCH_SIZE = 20
        const BATCH_TIMEOUT = 300000 // 5 minutes per batch
        let totalEmbedded = 0

        logger.info(`Embedding ${allIds.length} observations in batches of ${BATCH_SIZE}...`)

        for (let i = 0; i < allIds.length; i += BATCH_SIZE) {
            const batchIds = allIds.slice(i, i + BATCH_SIZE)
            const batchNum = Math.floor(i / BATCH_SIZE) + 1
            const totalBatches = Math.ceil(allIds.length / BATCH_SIZE)

            try {
                logger.info(`Embedding batch ${batchNum}/${totalBatches} (${batchIds.length} docs)...`)

                const response = await fetch(`${this.workerUrl}/api/sync/observations`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ ids: batchIds }),
                    signal: AbortSignal.timeout(BATCH_TIMEOUT)
                })

                if (!response.ok) {
                    throw new Error(`Sync failed: ${response.status}`)
                }

                const data = await response.json() as { success: boolean; embeddedCount: number }
                totalEmbedded += data.embeddedCount
                logger.info(`Batch ${batchNum} complete: ${data.embeddedCount} docs embedded`)

            } catch (e) {
                logger.warn(`Batch ${batchNum} embedding failed: ${e}, continuing with remaining batches...`)
            }
        }

        logger.info(`Embedding complete: ${totalEmbedded}/${allIds.length} documents for ${containerTag}`)
    }

    async search(query: string, options: SearchOptions): Promise<unknown[]> {
        // FIXED: Now properly uses semantic search from worker, not just recency ordering
        //
        // Strategy:
        // 1. Call worker's semantic search endpoint
        // 2. Parse observation IDs from the markdown table response
        // 3. Fetch full content for those specific IDs from SQLite
        // 4. Filter by containerTag (namespace) to ensure test isolation

        const limit = options.limit || 10
        const containerTag = options.containerTag

        // First, try to use the worker's semantic search
        // Request MANY more results because we filter by namespace afterward
        // With 11k+ total observations vs ~1k in benchmark namespace, we need to overfetch
        const semanticLimit = Math.max(500, limit * 50)

        // Store partial semantic results for hybrid merge
        let semanticResultsPartial: Array<{id: string, content: string, score: number, metadata: {title: string, created_at: string}}> = []

        try {
            const params = new URLSearchParams({
                query,
                limit: semanticLimit.toString(),
                project: "memorybench",  // Filter to benchmark observations only
                namespace: containerTag,  // Filter to this question's observations only
            })

            const response = await fetch(`${this.workerUrl}/api/search?${params}`, {
                signal: AbortSignal.timeout(30000)
            })

            if (!response.ok) {
                throw new Error(`Worker search failed: ${response.status}`)
            }

            const data = await response.json() as { content?: Array<{ text: string }> }

            // Parse observation IDs from worker's markdown table response
            // Format: | #1234 | 7:14 PM | 🔵 | Title | ~415 |
            const observationIds: number[] = []
            if (data.content?.[0]?.text) {
                const text = data.content[0].text
                // Match pattern: | #NNNN | where NNNN is the observation ID
                const idMatches = text.matchAll(/\|\s*#(\d+)\s*\|/g)
                for (const match of idMatches) {
                    observationIds.push(parseInt(match[1], 10))
                }
            }

            if (observationIds.length > 0) {
                // Fetch full content for semantic search results, filtered by namespace
                const db = new Database(this.dbPath, { readonly: true })
                const placeholders = observationIds.map(() => '?').join(',')
                const observations = db.query(`
                    SELECT id, title, narrative, facts, confidence, created_at_epoch
                    FROM observations
                    WHERE id IN (${placeholders})
                      AND namespace = ?
                    ORDER BY CASE id ${observationIds.map((id, i) => `WHEN ${id} THEN ${i}`).join(' ')} END
                    LIMIT ?
                `).all(...observationIds, containerTag, limit) as Array<{
                    id: number
                    title: string
                    narrative: string
                    facts: string
                    confidence: number
                    created_at_epoch: number
                }>

                const semanticResults = observations.map((obs, index) => ({
                    id: obs.id.toString(),
                    content: obs.narrative || obs.facts,
                    score: 1.0 - (index * 0.02), // Preserve semantic ranking
                    metadata: {
                        title: obs.title,
                        created_at: new Date(obs.created_at_epoch).toISOString()
                    }
                }))

                db.close()

                // HYBRID APPROACH: If semantic has fewer than limit results, supplement with keyword
                if (semanticResults.length >= limit) {
                    logger.info(`Semantic search returned ${semanticResults.length} results for "${query}"`)
                    return semanticResults
                }

                // Semantic found some results but not enough - we'll supplement with keyword below
                if (semanticResults.length > 0) {
                    logger.info(`Semantic search returned ${semanticResults.length}/${limit} results for "${query}", supplementing with keyword search`)
                    // Store semantic results to merge with keyword results below
                    semanticResultsPartial = semanticResults
                }
            }

            logger.debug(`Semantic search found insufficient results for namespace ${containerTag}, using keyword search`)

        } catch (e) {
            logger.warn(`Semantic search failed: ${e}, falling back to keyword search`)
        }

        // Fallback: keyword-based search within namespace
        // Extract meaningful keywords (remove stop words, keep 3+ char words)
        const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'can', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'between', 'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just', 'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those', 'am', 'its', 'it'])
        const keywords = query.toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length >= 3 && !stopWords.has(w))

        logger.debug(`Keyword search terms: ${keywords.join(', ')}`)

        const db = new Database(this.dbPath, { readonly: true })

        // Build dynamic OR conditions for each keyword
        const keywordConditions = keywords.length > 0
            ? keywords.map(() => '(narrative LIKE ? OR title LIKE ? OR facts LIKE ?)').join(' OR ')
            : '1=1' // Match all if no keywords extracted

        const keywordParams: string[] = []
        for (const kw of keywords) {
            keywordParams.push(`%${kw}%`, `%${kw}%`, `%${kw}%`)
        }

        // Calculate how many keyword results we need to fill the gap
        const semanticIds = new Set(semanticResultsPartial.map(r => r.id))
        const keywordLimit = limit - semanticResultsPartial.length

        const observations = db.query(`
            SELECT id, title, narrative, facts, confidence, created_at_epoch
            FROM observations
            WHERE namespace = ?
              AND (${keywordConditions})
            LIMIT ?
        `).all(
            containerTag,
            ...keywordParams,
            keywordLimit + semanticResultsPartial.length // Request extra to handle overlap
        ) as Array<{
            id: number
            title: string
            narrative: string
            facts: string
            confidence: number
            created_at_epoch: number
        }>

        // Convert to result format, filtering out duplicates from semantic results
        const keywordResults = observations
            .filter(obs => !semanticIds.has(obs.id.toString()))
            .slice(0, keywordLimit)
            .map((obs, index) => ({
                id: obs.id.toString(),
                content: obs.narrative || obs.facts,
                score: 0.5 - (index * 0.01), // Lower scores for keyword results
                metadata: {
                    title: obs.title,
                    created_at: new Date(obs.created_at_epoch).toISOString()
                }
            }))

        db.close()

        // HYBRID: Merge semantic (higher score) with keyword (lower score)
        const mergedResults = [...semanticResultsPartial, ...keywordResults].slice(0, limit)

        if (semanticResultsPartial.length > 0) {
            logger.info(`Hybrid search returned ${mergedResults.length} results for "${query}" (${semanticResultsPartial.length} semantic + ${keywordResults.length} keyword)`)
        } else {
            logger.info(`Keyword search returned ${mergedResults.length} results for "${query}"`)
        }
        return mergedResults
    }

    async clear(containerTag: string): Promise<void> {
        const db = new Database(this.dbPath)

        // Delete observations by namespace
        const result = db.run(
            `DELETE FROM observations WHERE namespace = ? OR project = 'memorybench'`,
            [containerTag]
        )

        logger.info(`Cleared ${result.changes} observations for container ${containerTag}`)

        this.containerTags.delete(containerTag)
        db.close()
    }
}

export default AnamnesisProvider
