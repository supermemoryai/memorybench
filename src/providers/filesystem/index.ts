import { mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { createOpenAI } from "@ai-sdk/openai"
import type {
  Provider,
  ProviderConfig,
  IngestOptions,
  IngestResult,
  SearchOptions,
  IndexingProgressCallback,
  ProviderSearchResponse,
} from "../../types/provider"
import type {
  CanonicalIngestionDocument,
  ProviderResultDropDiagnostic,
  UnifiedSearchResult,
} from "../../types/unified"
import { logger } from "../../utils/logger"
import { extractMemories, getMemoryExtractionConfigFingerprint } from "../../prompts/extraction"
import { stableSha256 } from "../../utils/stable"
import { FILESYSTEM_PROMPTS } from "./prompts"
import {
  assertResultBudget,
  canonicalDocumentToSession,
  rankResults,
  recordResultDrop,
  requireSearchLimit,
  resolveDocumentDate,
  createProviderSearchResponse,
} from "../normalization"

const BASE_DIR = join(process.cwd(), "data", "providers", "filesystem")

interface FilesystemSearchCandidate {
  id: string
  sessionId: string
  content: string
  score: number
  documentDate?: string
}

export function renderFilesystemMemoryFile(
  sessionId: string,
  documentDate: string | undefined,
  extractedMemories: string
): string {
  const header = documentDate
    ? `# Memory: ${sessionId}\n**Date:** ${documentDate}\n\n`
    : `# Memory: ${sessionId}\n\n`
  return header + extractedMemories
}

export function normalizeFilesystemSearchResults(
  rawResults: FilesystemSearchCandidate[],
  limit: number,
  droppedResults: ProviderResultDropDiagnostic[] = []
): UnifiedSearchResult[] {
  requireSearchLimit(limit, "filesystem")
  assertResultBudget(rawResults.length, limit, "filesystem")
  const normalized: Omit<UnifiedSearchResult, "rank">[] = []
  for (const [index, result] of rawResults.entries()) {
    if (!result.content.trim()) {
      recordResultDrop(droppedResults, index, "empty-text")
      continue
    }
    normalized.push({
      id: result.id,
      text: result.content,
      score: result.score,
      sessionId: result.sessionId,
      ...(result.documentDate ? { documentDate: result.documentDate } : {}),
      provider: "filesystem",
      resultType: "document",
    })
  }
  return rankResults(normalized)
}

/**
 * Simple tokenizer: lowercase, split on non-alphanumeric, filter short tokens.
 * Deliberately kept simple to represent the filesystem-based approach.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1)
}

/**
 * Score a document against query terms using simple term matching.
 * Returns a score between 0 and 1 representing the fraction of query terms found,
 * with a small frequency bonus for repeated matches.
 */
function scoreDocument(
  queryTerms: string[],
  docText: string
): { score: number; matchCount: number } {
  if (queryTerms.length === 0) return { score: 0, matchCount: 0 }

  const docLower = docText.toLowerCase()
  let matchCount = 0
  let totalFrequency = 0

  for (const term of queryTerms) {
    if (docLower.includes(term)) {
      matchCount++
      // Count occurrences for frequency bonus
      let idx = 0
      let count = 0
      while ((idx = docLower.indexOf(term, idx)) !== -1) {
        count++
        idx += term.length
      }
      totalFrequency += count
    }
  }

  const termCoverage = matchCount / queryTerms.length
  const frequencyBonus = Math.min(totalFrequency / 100, 0.1)

  return {
    score: Math.min(termCoverage + frequencyBonus, 1.0),
    matchCount,
  }
}

/**
 * Filesystem Memory Provider
 *
 * Implements the Claude Code MEMORY.md approach to memory:
 * - Extracts structured memories from conversations via LLM (like Claude's auto-memory)
 * - Stores extracted memories as plain Markdown files on the filesystem
 * - Search is simple text matching across memory files
 * - The LLM reasons over curated, structured memory content (not raw transcripts)
 *
 * This represents the MEMORY.md approach: use an LLM to extract key facts, preferences,
 * events, and relationships from conversations, then store them as searchable markdown.
 */
export class FilesystemProvider implements Provider {
  name = "filesystem"
  adapterVersion = "2.0.0"
  searchRequestStructure = { kind: "single" } as const
  prompts = FILESYSTEM_PROMPTS
  concurrency = {
    default: 50,
    ingest: 10,
  }

  private openai: ReturnType<typeof createOpenAI> | null = null

  getIngestionConfigFingerprint(_config: ProviderConfig): string {
    return stableSha256({
      schemaVersion: 1,
      provider: this.name,
      adapterVersion: this.adapterVersion,
      extractionConfigFingerprint: getMemoryExtractionConfigFingerprint(),
      storage: "memory-markdown-plus-json-sidecar-v1",
      documentId: "sanitized-customId",
    })
  }

  async initialize(config: ProviderConfig): Promise<void> {
    if (!config.apiKey || config.apiKey === "none") {
      throw new Error("Filesystem provider requires OPENAI_API_KEY for memory extraction")
    }
    this.openai = createOpenAI({ apiKey: config.apiKey })
    await mkdir(BASE_DIR, { recursive: true })
    logger.info("Initialized Filesystem memory provider (MEMORY.md-style with LLM extraction)")
  }

  async ingest(
    documents: CanonicalIngestionDocument[],
    options: IngestOptions
  ): Promise<IngestResult> {
    if (!this.openai) throw new Error("Provider not initialized")

    const containerDir = join(BASE_DIR, sanitizePath(options.containerTag))
    const memoriesDir = join(containerDir, "memories")
    await mkdir(memoriesDir, { recursive: true })

    const documentIds: string[] = []

    for (const document of documents) {
      const session = canonicalDocumentToSession(document)
      const extractedMemories = await extractMemories(this.openai, session)

      // Build a memory file with date header + extracted content
      const date = document.metadata.documentDate
      const content = renderFilesystemMemoryFile(
        document.metadata.sessionId,
        date,
        extractedMemories
      )

      const safeId = sanitizePath(document.customId)
      const filePath = join(memoriesDir, `${safeId}.md`)
      await writeFile(filePath, content, "utf-8")
      await writeFile(
        join(memoriesDir, `${safeId}.json`),
        JSON.stringify({
          sessionId: document.metadata.sessionId,
          ...(date ? { documentDate: date } : {}),
        }),
        "utf-8"
      )
      documentIds.push(safeId)
      logger.debug(`Extracted and stored memories for session ${document.metadata.sessionId}`)
    }

    return { documentIds }
  }

  async awaitIndexing(
    result: IngestResult,
    _containerTag: string,
    onProgress?: IndexingProgressCallback
  ): Promise<void> {
    // Filesystem indexing is instant - no async processing needed
    onProgress?.({
      completedIds: result.documentIds,
      failedIds: [],
      total: result.documentIds.length,
    })
  }

  async search(query: string, options: SearchOptions): Promise<ProviderSearchResponse> {
    const limit = requireSearchLimit(options.limit, this.name)
    const respond = (raw: FilesystemSearchCandidate[]) => {
      const droppedResults: ProviderResultDropDiagnostic[] = []
      return createProviderSearchResponse({
        results: normalizeFilesystemSearchResults(raw, limit, droppedResults),
        requestedLimit: limit,
        rawReturnedCount: raw.length,
        droppedResults,
        providerRequests: [
          {
            operation: "filesystem.scan",
            limit,
            parameters: { scoring: "term-coverage-frequency-v1" },
          },
        ],
      })
    }
    const containerDir = join(BASE_DIR, sanitizePath(options.containerTag))
    const memoriesDir = join(containerDir, "memories")

    let files: string[]
    try {
      files = await readdir(memoriesDir)
    } catch {
      logger.warn(`No memories directory found for ${options.containerTag}`)
      return respond([])
    }

    const mdFiles = files.filter((f) => f.endsWith(".md"))
    if (mdFiles.length === 0) return respond([])

    const queryTerms = tokenize(query)

    const scored: Array<{
      id: string
      sessionId: string
      content: string
      score: number
      matchCount: number
      documentDate?: string
    }> = []

    for (const file of mdFiles) {
      const content = await readFile(join(memoriesDir, file), "utf-8")
      const { score, matchCount } = scoreDocument(queryTerms, content)
      const safeId = file.replace(".md", "")
      let sessionId = safeId
      let documentDate: string | undefined
      try {
        const metadata = JSON.parse(
          await readFile(join(memoriesDir, `${safeId}.json`), "utf-8")
        ) as { sessionId?: unknown; documentDate?: unknown }
        if (typeof metadata.sessionId === "string" && metadata.sessionId) {
          sessionId = metadata.sessionId
        }
        documentDate = resolveDocumentDate(metadata)
      } catch {
        const sessionMatch = content.match(/^# Memory: (.+)$/m)
        const dateMatch = content.match(/^\*\*Date:\*\* (.+)$/m)
        if (sessionMatch?.[1]) sessionId = sessionMatch[1]
        const legacyDate = dateMatch?.[1]?.trim()
        if (
          legacyDate &&
          !["unknown", "unknown date", "not specified"].includes(legacyDate.toLowerCase())
        ) {
          documentDate = legacyDate
        }
      }
      scored.push({
        id: safeId,
        sessionId,
        content,
        score,
        matchCount,
        ...(documentDate ? { documentDate } : {}),
      })
    }

    // Sort by score (desc), then by matchCount (desc) as tiebreaker
    scored.sort((a, b) => b.score - a.score || b.matchCount - a.matchCount)

    // Return top results; include score=0 results only if we have fewer than limit scored results
    const scoredResults = scored.filter((r) => r.score > 0)
    if (scoredResults.length >= limit) {
      return respond(scoredResults.slice(0, limit))
    }

    // Fill remaining slots with unscored results (chronological order fallback)
    const unscoredResults = scored.filter((r) => r.score === 0)
    return respond([...scoredResults, ...unscoredResults].slice(0, limit))
  }

  async clear(containerTag: string): Promise<void> {
    const containerDir = join(BASE_DIR, sanitizePath(containerTag))
    try {
      await rm(containerDir, { recursive: true, force: true })
      logger.info(`Cleared filesystem data for: ${containerTag}`)
    } catch (e) {
      logger.warn(`Failed to clear filesystem data: ${e}`)
    }
  }
}

/** Sanitize a string for safe use as a filesystem path component */
function sanitizePath(input: string): string {
  return input.replace(/[^a-zA-Z0-9_.-]/g, "_")
}

export default FilesystemProvider
