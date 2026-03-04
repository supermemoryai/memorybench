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
} from "../../types/provider"
import type { UnifiedSession } from "../../types/unified"
import { logger } from "../../utils/logger"
import { extractMemories } from "../../prompts/extraction"
import { FILESYSTEM_PROMPTS } from "./prompts"

const BASE_DIR = join(process.cwd(), "data", "providers", "filesystem")

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
function scoreDocument(queryTerms: string[], docText: string): { score: number; matchCount: number } {
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
  prompts = FILESYSTEM_PROMPTS
  concurrency = {
    default: 50,
    ingest: 10,
  }

  private openai: ReturnType<typeof createOpenAI> | null = null

  async initialize(config: ProviderConfig): Promise<void> {
    if (!config.apiKey || config.apiKey === "none") {
      throw new Error("Filesystem provider requires OPENAI_API_KEY for memory extraction")
    }
    this.openai = createOpenAI({ apiKey: config.apiKey })
    await mkdir(BASE_DIR, { recursive: true })
    logger.info("Initialized Filesystem memory provider (MEMORY.md-style with LLM extraction)")
  }

  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
    if (!this.openai) throw new Error("Provider not initialized")

    const containerDir = join(BASE_DIR, sanitizePath(options.containerTag))
    const memoriesDir = join(containerDir, "memories")
    await mkdir(memoriesDir, { recursive: true })

    const documentIds: string[] = []

    for (const session of sessions) {
      const extractedMemories = await extractMemories(this.openai, session)

      // Build a memory file with date header + extracted content
      const date =
        (session.metadata?.formattedDate as string) ||
        (session.metadata?.date as string) ||
        "Unknown date"
      const header = `# Memory: ${session.sessionId}\n**Date:** ${date}\n\n`
      const content = header + extractedMemories

      const safeId = sanitizePath(session.sessionId)
      const filePath = join(memoriesDir, `${safeId}.md`)
      await writeFile(filePath, content, "utf-8")
      documentIds.push(safeId)
      logger.debug(`Extracted and stored memories for session ${session.sessionId}`)
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

  async search(query: string, options: SearchOptions): Promise<unknown[]> {
    const containerDir = join(BASE_DIR, sanitizePath(options.containerTag))
    const memoriesDir = join(containerDir, "memories")

    let files: string[]
    try {
      files = await readdir(memoriesDir)
    } catch {
      logger.warn(`No memories directory found for ${options.containerTag}`)
      return []
    }

    const mdFiles = files.filter((f) => f.endsWith(".md"))
    if (mdFiles.length === 0) return []

    const queryTerms = tokenize(query)

    const scored: Array<{
      sessionId: string
      content: string
      score: number
      matchCount: number
    }> = []

    for (const file of mdFiles) {
      const content = await readFile(join(memoriesDir, file), "utf-8")
      const { score, matchCount } = scoreDocument(queryTerms, content)
      scored.push({
        sessionId: file.replace(".md", ""),
        content,
        score,
        matchCount,
      })
    }

    // Sort by score (desc), then by matchCount (desc) as tiebreaker
    scored.sort((a, b) => b.score - a.score || b.matchCount - a.matchCount)

    const limit = options.limit || 10

    // Return top results; include score=0 results only if we have fewer than limit scored results
    const scoredResults = scored.filter((r) => r.score > 0)
    if (scoredResults.length >= limit) {
      return scoredResults.slice(0, limit)
    }

    // Fill remaining slots with unscored results (chronological order fallback)
    const unscoredResults = scored.filter((r) => r.score === 0)
    return [...scoredResults, ...unscoredResults].slice(0, limit)
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
