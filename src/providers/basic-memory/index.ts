import { spawn } from "node:child_process"
import { mkdir, rm } from "node:fs/promises"
import { accessSync, constants } from "node:fs"
import { delimiter, isAbsolute, join } from "node:path"
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
import { BASIC_MEMORY_PROMPTS } from "./prompts"

/**
 * Root directory for this provider's isolated Basic Memory installation.
 * We deliberately point BASIC_MEMORY_CONFIG_DIR / BASIC_MEMORY_HOME here so the
 * benchmark never reads or writes the user's real BM config or projects.
 */
const BASE_DIR = join(process.cwd(), "data", "providers", "basic-memory")
const CONFIG_DIR = join(BASE_DIR, "config")
const PROJECTS_DIR = join(BASE_DIR, "projects")

/** Max time to wait for BM to report a settled sync state, in ms. */
const INDEX_SETTLE_TIMEOUT_MS = 120_000
/** Poll interval while waiting for indexing to settle, in ms. */
const INDEX_POLL_MS = 1_000

/** Sanitize a containerTag into a valid Basic Memory project name. */
export function projectName(containerTag: string): string {
  return containerTag.replace(/[^a-zA-Z0-9_-]/g, "-")
}

/**
 * Resolve a CLI name to an absolute executable path by searching $PATH.
 * Returns the input unchanged if it is already an absolute path, or null if no
 * executable is found. Needed because Bun's spawn does not do PATH lookup.
 */
function resolveBinary(bin: string): string | null {
  if (isAbsolute(bin)) {
    return isExecutable(bin) ? bin : null
  }
  const dirs = (process.env.PATH || "").split(delimiter).filter(Boolean)
  for (const dir of dirs) {
    const candidate = join(dir, bin)
    if (isExecutable(candidate)) return candidate
  }
  return null
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

interface BmSearchResult {
  title?: string
  permalink?: string
  content?: string
  matched_chunk?: string
  score?: number
  metadata?: Record<string, unknown>
}

/**
 * Basic Memory Provider
 *
 * Drives a LOCAL Basic Memory install (the `bm` CLI, which exposes MCP tools via
 * `bm tool ... --local` with JSON output). Each containerTag is mapped to a
 * dedicated, throwaway BM project so benchmark runs stay isolated from one
 * another and from the user's real knowledge base.
 *
 * - Ingest: each conversation session is written as a Markdown note via
 *   `bm tool write-note`. BM extracts entities/observations/relations and indexes
 *   the note (full-text + optional semantic embeddings) on write.
 * - Indexing: writes are synchronous, but we poll `bm status` until the project
 *   reports no pending file/db changes, so search runs against a settled index.
 * - Search: `bm tool search-notes` returns ranked notes as JSON.
 * - Clear: the project (config entry + on-disk data) is removed entirely.
 *
 * Requires the `bm` (basic-memory) CLI to be installed and on PATH. Install with:
 *   uv tool install basic-memory   (or: uvx basic-memory ...)
 */
export class BasicMemoryProvider implements Provider {
  name = "basic-memory"
  prompts = BASIC_MEMORY_PROMPTS
  // BM writes go through a single local SQLite DB per project. Different
  // containerTags use different projects, so cross-question concurrency is safe,
  // but we keep ingest modest to avoid hammering the local sync loop.
  concurrency = {
    default: 10,
    ingest: 4,
  }

  private bmBin = "bm"

  async initialize(config: ProviderConfig): Promise<void> {
    // Allow overriding the CLI entrypoint (e.g. "basic-memory") via config/baseUrl.
    const requested =
      typeof config.baseUrl === "string" && config.baseUrl.trim() ? config.baseUrl.trim() : "bm"

    // Bun's child_process.spawn does not perform PATH lookup, so resolve the
    // CLI to an absolute path here (supports "bm", "basic-memory", or a full path).
    const resolved = resolveBinary(requested)
    if (!resolved) {
      throw new Error(
        `Basic Memory CLI ("${requested}") not found on PATH. ` +
          `Install it with "uv tool install basic-memory", or set BASIC_MEMORY_CLI ` +
          `to the absolute path of the bm executable.`
      )
    }
    this.bmBin = resolved

    await mkdir(CONFIG_DIR, { recursive: true })
    await mkdir(PROJECTS_DIR, { recursive: true })

    // Fail fast with a helpful message if the CLI is missing/unrunnable.
    try {
      await this.runBm(["--version"])
    } catch (e) {
      throw new Error(
        `Basic Memory CLI ("${this.bmBin}") found but not runnable. ` +
          `Install it with "uv tool install basic-memory". Original error: ${e}`
      )
    }
    logger.info("Initialized Basic Memory provider (local bm CLI)")
  }

  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
    const project = projectName(options.containerTag)
    await this.ensureProject(project)

    const documentIds: string[] = []

    // Write sessions sequentially: they share a single project DB, and BM's local
    // sync loop is happiest with serialized writes within a project.
    for (const session of sessions) {
      const content = formatSessionNote(session)
      const result = await this.runBmJson<{ permalink?: string }>(
        [
          "tool",
          "write-note",
          "--title",
          `Session ${session.sessionId}`,
          "--folder",
          "sessions",
          "--project",
          project,
          "--local",
        ],
        content
      )
      const id = result?.permalink || session.sessionId
      documentIds.push(id)
      logger.debug(`Ingested session ${session.sessionId} -> ${id}`)
    }

    return { documentIds }
  }

  async awaitIndexing(
    result: IngestResult,
    containerTag: string,
    onProgress?: IndexingProgressCallback
  ): Promise<void> {
    const project = projectName(containerTag)
    const total = result.documentIds.length

    onProgress?.({ completedIds: [], failedIds: [], total })

    // BM indexes FTS on write; poll `bm status` until the project reports a
    // settled (no-changes) sync state so search hits the finished index.
    const deadline = Date.now() + INDEX_SETTLE_TIMEOUT_MS
    while (Date.now() < deadline) {
      let settled = false
      try {
        const status = await this.runBm(["status", "--project", project, "--local"])
        settled = /no changes/i.test(status)
      } catch (e) {
        logger.warn(`status check failed for ${project}: ${e}`)
      }
      if (settled) break
      await sleep(INDEX_POLL_MS)
    }

    // Vector embeddings are built incrementally and may lag the FTS index, so
    // force a full embeddings rebuild for this project. This is what makes
    // hybrid/semantic search return results for natural-language questions.
    // (`reindex` uses `-p` and has no `--local` flag.)
    try {
      await this.runBm(["reindex", "-p", project, "--full", "--embeddings"])
    } catch (e) {
      logger.warn(`embeddings reindex failed for ${project}: ${e}`)
    }

    onProgress?.({
      completedIds: result.documentIds,
      failedIds: [],
      total,
    })
  }

  async search(query: string, options: SearchOptions): Promise<unknown[]> {
    const project = projectName(options.containerTag)
    const limit = options.limit || 10

    let parsed: { results?: BmSearchResult[] }
    try {
      // Hybrid mode combines BM's full-text (FTS) and semantic (vector) search,
      // which is required to match natural-language questions where the exact
      // keywords don't all appear in the note.
      parsed = await this.runBmJson<{ results?: BmSearchResult[] }>([
        "tool",
        "search-notes",
        query,
        "--project",
        project,
        "--local",
        "--hybrid",
        "--page-size",
        String(limit),
      ])
    } catch (e) {
      logger.warn(`Search failed for ${project}: ${e}`)
      return []
    }

    return parsed?.results || []
  }

  async clear(containerTag: string): Promise<void> {
    const project = projectName(containerTag)
    try {
      await this.runBm(["project", "remove", project, "--local"])
    } catch (e) {
      logger.warn(`Failed to remove project ${project}: ${e}`)
    }
    try {
      await rm(join(PROJECTS_DIR, project), { recursive: true, force: true })
    } catch (e) {
      logger.warn(`Failed to remove project dir for ${project}: ${e}`)
    }
    logger.info(`Cleared Basic Memory data for: ${containerTag}`)
  }

  /** Create the throwaway BM project for this containerTag if it doesn't exist. */
  private async ensureProject(project: string): Promise<void> {
    const projectPath = join(PROJECTS_DIR, project)
    await mkdir(projectPath, { recursive: true })
    try {
      await this.runBm(["project", "add", project, projectPath, "--local"])
    } catch (e) {
      // "already exists" is fine; surface anything else.
      if (!/already exists/i.test(String(e))) {
        logger.warn(`project add for ${project} returned: ${e}`)
      }
    }
  }

  /** Run a `bm` command, returning stdout. Throws on non-zero exit. */
  private runBm(args: string[], stdin?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bmBin, args, {
        env: {
          ...process.env,
          BASIC_MEMORY_CONFIG_DIR: CONFIG_DIR,
          BASIC_MEMORY_HOME: PROJECTS_DIR,
        },
      })

      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (d) => (stdout += d.toString()))
      child.stderr.on("data", (d) => (stderr += d.toString()))
      child.on("error", reject)
      child.on("close", (code) => {
        if (code === 0) resolve(stdout)
        else reject(new Error(`bm ${args[0]} exited ${code}: ${stderr || stdout}`))
      })

      if (stdin !== undefined) {
        child.stdin.write(stdin)
      }
      child.stdin.end()
    })
  }

  /** Run a `bm` command and parse the last JSON object/array from stdout. */
  private async runBmJson<T>(args: string[], stdin?: string): Promise<T> {
    const out = await this.runBm(args, stdin)
    return parseJsonOutput<T>(out)
  }
}

/** Render a unified session as a Markdown note body. */
export function formatSessionNote(session: UnifiedSession): string {
  const date =
    (session.metadata?.formattedDate as string) ||
    (session.metadata?.date as string) ||
    "Unknown date"

  const transcript = session.messages
    .map((m) => {
      const speaker = m.speaker || m.role
      const ts = m.timestamp ? ` [${m.timestamp}]` : ""
      return `**${speaker}**${ts}: ${m.content}`
    })
    .join("\n\n")

  return `**Date:** ${date}\n\n## Conversation\n\n${transcript}\n`
}

/**
 * Parse JSON from `bm tool` stdout. The CLI may emit non-JSON noise (e.g. model
 * download progress) before the JSON payload, so we extract the JSON span.
 */
export function parseJsonOutput<T>(out: string): T {
  const trimmed = out.trim()
  try {
    return JSON.parse(trimmed) as T
  } catch {
    // Find the first { or [ and parse from there to the matching end.
    const start = trimmed.search(/[{[]/)
    if (start === -1) {
      throw new Error(`No JSON found in bm output: ${trimmed.slice(0, 200)}`)
    }
    const open = trimmed[start]
    const close = open === "{" ? "}" : "]"
    const end = trimmed.lastIndexOf(close)
    if (end <= start) {
      throw new Error(`Malformed JSON in bm output: ${trimmed.slice(0, 200)}`)
    }
    return JSON.parse(trimmed.slice(start, end + 1)) as T
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export default BasicMemoryProvider
