import Database from "bun:sqlite"
import { spawn } from "child_process"
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
 * AnamnesisProvider - MemoryBench provider for claude-mem memory systems.
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
     * Extract observations from a conversation using Claude CLI.
     * Uses print mode (-p) which is completely stateless - no hooks, no memory injection.
     * Matches production claude-mem XML format with facts array.
     */
    private async extractObservations(conversationText: string, sessionDate?: string): Promise<ExtractedObservation[]> {
        try {
            const prompt = EXTRACTION_PROMPT + conversationText

            // Call Claude CLI in print mode with JSON output
            // -p flag = print mode (stateless, no hooks, no memory)
            // --max-budget-usd caps spend per extraction call
            // Use Haiku for faster extraction
            const result = await new Promise<string>((resolve, reject) => {
                const timeoutMs = 300000  // 5 minute timeout
                const claude = spawn('claude', [
                    '-p', prompt,
                    '--output-format', 'json',
                    '--model', 'haiku',  // Fast model for extraction
                    '--max-budget-usd', '1.00',  // Allow $1 per extraction (generous)
                ], {
                    cwd: process.cwd(),
                })

                // Manual timeout handler (spawn timeout doesn't kill process reliably)
                const timeout = setTimeout(() => {
                    claude.kill()
                    reject(new Error(`Claude CLI timed out after ${timeoutMs}ms`))
                }, timeoutMs)

                let stdout = ''
                let stderr = ''

                claude.stdout.on('data', (data) => { stdout += data })
                claude.stderr.on('data', (data) => { stderr += data })

                claude.on('close', (code) => {
                    clearTimeout(timeout)
                    if (code === 0) resolve(stdout)
                    else reject(new Error(`Claude CLI exited with code ${code}: ${stderr}`))
                })

                claude.on('error', (err) => {
                    clearTimeout(timeout)
                    reject(err)
                })
            })

            // Parse Claude's JSON response
            const response = JSON.parse(result)
            const text = response.result?.trim() || ''

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

        // Prepare session data with conversation text
        const sessionData = sessions.map(session => {
            const formattedDate = session.metadata?.formattedDate as string | undefined
            const datePrefix = formattedDate
                ? `[Conversation Date: ${formattedDate}]\n\n`
                : ''
            const conversationText = datePrefix + session.messages
                .map(m => `[${m.speaker || m.role}]: ${m.content}`)
                .join("\n\n")
            return { session, formattedDate, conversationText }
        })

        // PARALLEL EXTRACTION: Run all extractions concurrently (with limit)
        type ExtractionResult = { sessionId: string; observations: ExtractedObservation[]; formattedDate?: string }
        const extractionResults: ExtractionResult[] = []

        if (this.extractionMode) {
            const CONCURRENCY = 5  // Limit parallel CLI processes
            logger.info(`Extracting ${sessionData.length} sessions in parallel (concurrency: ${CONCURRENCY})...`)

            // Process in batches for controlled parallelism
            for (let i = 0; i < sessionData.length; i += CONCURRENCY) {
                const batch = sessionData.slice(i, i + CONCURRENCY)
                const batchPromises = batch.map(async ({ session, formattedDate, conversationText }) => {
                    const observations = await this.extractObservations(conversationText, formattedDate)
                    return { sessionId: session.sessionId, observations, formattedDate }
                })

                const batchResults = await Promise.all(batchPromises)
                extractionResults.push(...batchResults)

                const completed = Math.min(i + CONCURRENCY, sessionData.length)
                logger.debug(`Extraction progress: ${completed}/${sessionData.length} sessions`)
            }
        }

        // Process each session (DB inserts are sequential for safety)
        for (let idx = 0; idx < sessionData.length; idx++) {
            const { session, formattedDate, conversationText } = sessionData[idx]

            // EXTRACTION MODE: Use pre-extracted observations
            if (this.extractionMode) {
                const extracted = extractionResults.find(r => r.sessionId === session.sessionId)
                const extractedObs = extracted?.observations || []

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
                    logger.debug(`Stored ${extractedObs.length} extracted observations from session ${session.sessionId}`)
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
        // SQLite inserts are synchronous, but ChromaDB needs embeddings for semantic search.
        // We call embed.py directly using the same Python env as chroma-mcp (matching ChromaDB version).

        if (result.documentIds.length === 0) {
            logger.debug(`No documents to index for ${containerTag}`)
            return
        }

        const allIds = result.documentIds.map(id => parseInt(id, 10))

        // Batch into chunks of 200 — embed.py handles sub-batching internally
        const BATCH_SIZE = 200
        const BATCH_TIMEOUT = 300000 // 5 minutes per batch
        let totalEmbedded = 0

        // Find the chroma-mcp Python environment (matches ChromaDB version)
        // CHROMA_PYTHON should point to the Python with matching ChromaDB version as chroma-mcp.
        // Falls back to system python3 — works if ChromaDB versions match.
        const chromaPython = process.env.CHROMA_PYTHON || "python3"
        const embedScript = new URL("embed.py", import.meta.url).pathname

        logger.info(`Embedding ${allIds.length} observations via ChromaDB direct...`)

        for (let i = 0; i < allIds.length; i += BATCH_SIZE) {
            const batchIds = allIds.slice(i, i + BATCH_SIZE)
            const batchNum = Math.floor(i / BATCH_SIZE) + 1
            const totalBatches = Math.ceil(allIds.length / BATCH_SIZE)

            try {
                logger.info(`Embedding batch ${batchNum}/${totalBatches} (${batchIds.length} docs)...`)

                const result = await new Promise<string>((resolve, reject) => {
                    const proc = spawn(chromaPython, [
                        embedScript,
                        batchIds.join(","),
                    ], {
                        env: {
                            ...process.env,
                            ANAMNESIS_DB: this.dbPath,
                            CHROMA_PATH: process.env.CHROMA_PATH || `${process.env.HOME}/.claude-mem/vector-db`,
                        },
                    })

                    const timeout = setTimeout(() => {
                        proc.kill()
                        reject(new Error(`Embed script timed out after ${BATCH_TIMEOUT}ms`))
                    }, BATCH_TIMEOUT)

                    let stdout = ""
                    let stderr = ""
                    proc.stdout.on("data", (d) => { stdout += d })
                    proc.stderr.on("data", (d) => { stderr += d })
                    proc.on("close", (code) => {
                        clearTimeout(timeout)
                        if (code === 0) resolve(stdout)
                        else reject(new Error(`embed.py exited ${code}: ${stderr}`))
                    })
                    proc.on("error", (err) => {
                        clearTimeout(timeout)
                        reject(err)
                    })
                })

                const data = JSON.parse(result) as { embedded: number; skipped: number; errors: number }
                totalEmbedded += data.embedded
                logger.info(`Batch ${batchNum} complete: ${data.embedded} embedded, ${data.skipped} skipped, ${data.errors} errors`)

            } catch (e) {
                logger.warn(`Batch ${batchNum} embedding failed: ${e}, continuing...`)
            }
        }

        logger.info(`Embedding complete: ${totalEmbedded}/${allIds.length} documents for ${containerTag}`)
    }

    async search(query: string, options: SearchOptions): Promise<unknown[]> {
        // Hybrid search: ChromaDB semantic (via search.py) + SQLite keyword fallback.
        // search.py uses the same Python env as chroma-mcp to avoid version mismatches.

        const limit = options.limit || 10
        const containerTag = options.containerTag

        // Find the chroma-mcp Python environment
        // CHROMA_PYTHON should point to the Python with matching ChromaDB version as chroma-mcp.
        // Falls back to system python3 — works if ChromaDB versions match.
        const chromaPython = process.env.CHROMA_PYTHON || "python3"
        const searchScript = new URL("search.py", import.meta.url).pathname

        // --- SEMANTIC SEARCH via ChromaDB ---
        let semanticResults: Array<{id: string, content: string, score: number, metadata: {title: string, created_at: string}}> = []

        try {
            const result = await new Promise<string>((resolve, reject) => {
                const proc = spawn(chromaPython, [
                    searchScript,
                    query,
                    containerTag,
                    limit.toString(),
                ], {
                    env: {
                        ...process.env,
                        ANAMNESIS_DB: this.dbPath,
                        CHROMA_PATH: process.env.CHROMA_PATH || `${process.env.HOME}/.claude-mem/vector-db`,
                    },
                })

                const timeout = setTimeout(() => {
                    proc.kill()
                    reject(new Error("search.py timed out"))
                }, 30000)

                let stdout = ""
                let stderr = ""
                proc.stdout.on("data", (d) => { stdout += d })
                proc.stderr.on("data", (d) => { stderr += d })
                proc.on("close", (code) => {
                    clearTimeout(timeout)
                    if (code === 0) resolve(stdout)
                    else reject(new Error(`search.py exited ${code}: ${stderr}`))
                })
                proc.on("error", (err) => {
                    clearTimeout(timeout)
                    reject(err)
                })
            })

            semanticResults = JSON.parse(result)
            if (semanticResults.length >= limit) {
                logger.info(`Semantic search returned ${semanticResults.length} results for "${query}"`)
                return semanticResults
            }
            if (semanticResults.length > 0) {
                logger.info(`Semantic search returned ${semanticResults.length}/${limit} for "${query}", supplementing with keyword`)
            }
        } catch (e) {
            logger.warn(`Semantic search failed: ${e}, falling back to keyword search`)
        }

        // --- KEYWORD SEARCH via SQLite ---
        const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'can', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'between', 'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just', 'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those', 'am', 'its', 'it'])
        const keywords = query.toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length >= 3 && !stopWords.has(w))

        const db = new Database(this.dbPath, { readonly: true })

        const keywordConditions = keywords.length > 0
            ? keywords.map(() => '(narrative LIKE ? OR title LIKE ? OR facts LIKE ?)').join(' OR ')
            : '1=1'

        const keywordParams: string[] = []
        for (const kw of keywords) {
            keywordParams.push(`%${kw}%`, `%${kw}%`, `%${kw}%`)
        }

        const semanticIds = new Set(semanticResults.map(r => r.id))
        const keywordLimit = limit - semanticResults.length

        const observations = db.query(`
            SELECT id, title, narrative, facts, confidence, created_at_epoch
            FROM observations
            WHERE namespace = ?
              AND (${keywordConditions})
            LIMIT ?
        `).all(
            containerTag,
            ...keywordParams,
            keywordLimit + semanticResults.length
        ) as Array<{
            id: number
            title: string
            narrative: string
            facts: string
            confidence: number
            created_at_epoch: number
        }>

        const keywordResults = observations
            .filter(obs => !semanticIds.has(obs.id.toString()))
            .slice(0, keywordLimit)
            .map((obs, index) => ({
                id: obs.id.toString(),
                content: obs.narrative || obs.facts,
                score: 0.5 - (index * 0.01),
                metadata: {
                    title: obs.title,
                    created_at: new Date(obs.created_at_epoch).toISOString()
                }
            }))

        db.close()

        const mergedResults = [...semanticResults, ...keywordResults].slice(0, limit)

        if (semanticResults.length > 0 && keywordResults.length > 0) {
            logger.info(`Hybrid search returned ${mergedResults.length} results for "${query}" (${semanticResults.length} semantic + ${keywordResults.length} keyword)`)
        } else if (semanticResults.length > 0) {
            logger.info(`Semantic search returned ${mergedResults.length} results for "${query}"`)
        } else {
            logger.info(`Keyword search returned ${mergedResults.length} results for "${query}"`)
        }
        return mergedResults
    }

    async clear(containerTag: string): Promise<void> {
        const db = new Database(this.dbPath)

        // Get IDs before deleting (needed for ChromaDB cleanup)
        const ids = db.query(
            `SELECT id FROM observations WHERE namespace = ? OR project = 'memorybench'`
        ).all(containerTag) as Array<{ id: number }>

        // Delete from SQLite
        const result = db.run(
            `DELETE FROM observations WHERE namespace = ? OR project = 'memorybench'`,
            [containerTag]
        )
        db.close()

        // Delete from ChromaDB
        if (ids.length > 0) {
            const chromaPython = process.env.CHROMA_PYTHON || "python3"
            try {
                const chromaIds = ids.map(r => r.id.toString())
                const proc = spawn(chromaPython, ["-c", `
import chromadb, json, os, sys
client = chromadb.PersistentClient(path=os.environ.get("CHROMA_PATH", os.path.expanduser("~/.claude-mem/vector-db")))
col = client.get_collection("cm__claude-mem")
ids = json.loads(sys.argv[1])
# ChromaDB delete has batch limits, chunk if needed
for i in range(0, len(ids), 500):
    try:
        col.delete(ids=ids[i:i+500])
    except:
        pass
print(json.dumps({"deleted": len(ids)}))
`, JSON.stringify(chromaIds)], {
                    env: {
                        ...process.env,
                        CHROMA_PATH: process.env.CHROMA_PATH || `${process.env.HOME}/.claude-mem/vector-db`,
                    },
                })
                // Fire and forget — don't block on cleanup
                proc.on("error", () => {})
            } catch (e) {
                logger.warn(`ChromaDB cleanup failed: ${e}`)
            }
        }

        logger.info(`Cleared ${result.changes} observations for container ${containerTag}`)
        this.containerTags.delete(containerTag)
    }
}

export default AnamnesisProvider
