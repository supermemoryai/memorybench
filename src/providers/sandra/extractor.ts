/**
 * LLM-based session extractor. Calls Claude Haiku via the Vercel AI SDK
 * (already a memorybench dependency) to convert raw chat turns into the
 * {entities, facts} JSON that the Sandra graph writer consumes.
 *
 * Mirrors `sandra/benchmark/longmemeval/src/ingest_claude.py`:
 *   - one API call per session
 *   - parse JSON from the response, stripping markdown fences if present
 *   - one retry with a stricter instruction on JSONDecodeError
 *
 * Model default is `claude-haiku-4-5-20251001` to match the Python default.
 * Override via the `SANDRA_EXTRACTOR_MODEL` env var if needed.
 */

import { generateText, type LanguageModel } from "ai"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import type { UnifiedMessage } from "../../types/unified"
import { logger } from "../../utils/logger"
import { EXTRACT_SYSTEM_PROMPT } from "./prompts"
import type { SessionExtraction } from "./schema"

const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001"
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini"
const MAX_OUTPUT_TOKENS = 8000

export interface ExtractorConfig {
  apiKey: string // Anthropic key when present; falls through to OPENAI_API_KEY if empty.
  model?: string
}

export interface ExtractorStats {
  inputTokens: number
  outputTokens: number
  apiCalls: number
  parseFailures: number
}

/**
 * Dual-provider extractor that mirrors the fallback logic of the Python
 * benchmark's `llm_client.py`: prefer Anthropic (Claude Haiku) when an API
 * key is configured, otherwise fall back to OpenAI (gpt-4o-mini). The model
 * name can be overridden via the `SANDRA_EXTRACTOR_MODEL` env var.
 */
export class SessionExtractor {
  private readonly model: LanguageModel
  readonly modelName: string
  readonly providerName: "anthropic" | "openai"
  readonly stats: ExtractorStats = {
    inputTokens: 0,
    outputTokens: 0,
    apiCalls: 0,
    parseFailures: 0,
  }

  constructor(config: ExtractorConfig) {
    const override = config.model || process.env.SANDRA_EXTRACTOR_MODEL
    const anthropicKey = config.apiKey || process.env.ANTHROPIC_API_KEY || ""
    const openaiKey = process.env.OPENAI_API_KEY || ""

    if (anthropicKey) {
      const provider = createAnthropic({ apiKey: anthropicKey })
      this.modelName = override || DEFAULT_ANTHROPIC_MODEL
      this.model = provider(this.modelName)
      this.providerName = "anthropic"
    } else if (openaiKey) {
      const provider = createOpenAI({ apiKey: openaiKey })
      this.modelName = override || DEFAULT_OPENAI_MODEL
      this.model = provider(this.modelName)
      this.providerName = "openai"
    } else {
      throw new Error(
        "Sandra extractor needs an LLM key: set ANTHROPIC_API_KEY (Claude Haiku) or OPENAI_API_KEY (gpt-4o-mini)."
      )
    }
    logger.info(
      `Sandra extractor using ${this.providerName} / ${this.modelName}`
    )
  }

  async extract(
    messages: UnifiedMessage[],
    sessionTimestamp?: string
  ): Promise<SessionExtraction> {
    const prompt = this.buildSessionPrompt(messages, sessionTimestamp)
    const first = await this.callModel(EXTRACT_SYSTEM_PROMPT, prompt)

    const parsed = tryParseJson(first)
    if (parsed) return sanitize(parsed)

    this.stats.parseFailures += 1
    logger.debug("Extractor got non-JSON response; retrying once")

    const second = await this.callModel(
      EXTRACT_SYSTEM_PROMPT +
        "\nCRITICAL: Output valid JSON only. No prose, no markdown fences.",
      prompt + "\n\nPrevious output was not valid JSON. Re-emit valid JSON only."
    )
    const retried = tryParseJson(second)
    if (retried) return sanitize(retried)

    logger.warn("Extractor failed twice; returning empty extraction")
    return { entities: [], facts: [] }
  }

  private buildSessionPrompt(messages: UnifiedMessage[], ts?: string): string {
    const header = ts ? `Session timestamp: ${ts}\n\n` : ""
    const lines = messages.map((m, i) => `[turn ${i} ${m.role}]\n${m.content}`)
    return header + lines.join("\n\n")
  }

  private async callModel(system: string, prompt: string): Promise<string> {
    const result = await generateText({
      model: this.model,
      system,
      prompt,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    })
    this.stats.apiCalls += 1
    const usage = result.usage
    if (usage) {
      this.stats.inputTokens += usage.inputTokens ?? 0
      this.stats.outputTokens += usage.outputTokens ?? 0
    }
    return (result.text ?? "").trim()
  }
}

function tryParseJson(text: string): SessionExtraction | null {
  let body = text.trim()
  if (body.startsWith("```")) {
    // strip leading fence incl. optional language tag
    body = body.replace(/^```[a-zA-Z]*\n?/, "")
    if (body.endsWith("```")) body = body.slice(0, -3)
    body = body.trim()
  }
  if (!body.startsWith("{")) {
    // some models prefix a single explanatory line; grab the first {...} block
    const match = body.match(/\{[\s\S]*\}/)
    if (!match) return null
    body = match[0]
  }
  try {
    const obj = JSON.parse(body)
    if (!obj || typeof obj !== "object") return null
    const entities = Array.isArray(obj.entities) ? obj.entities : []
    const facts = Array.isArray(obj.facts) ? obj.facts : []
    return { entities, facts }
  } catch {
    return null
  }
}

function sanitize(raw: SessionExtraction): SessionExtraction {
  const entities = raw.entities
    .filter((e) => e && typeof e.name === "string" && e.name.trim() !== "")
    .map((e) => ({
      name: String(e.name).trim(),
      kind: (e.kind && String(e.kind)) || "other",
      notes: e.notes ? String(e.notes).slice(0, 240) : "",
    }))

  const facts = raw.facts
    .filter(
      (f) =>
        f &&
        typeof f.predicate === "string" &&
        f.predicate.trim() !== "" &&
        typeof f.statement === "string" &&
        f.statement.trim() !== ""
    )
    .map((f) => {
      const typedRefs: Record<string, number> = {}
      const rawTyped = (f as { typed_refs?: unknown }).typed_refs
      if (rawTyped && typeof rawTyped === "object") {
        for (const [k, v] of Object.entries(rawTyped as Record<string, unknown>)) {
          const num = Number(v)
          if (!Number.isNaN(num) && Number.isFinite(num) && k.trim() !== "") {
            typedRefs[k.trim()] = num
          }
        }
      }
      let turnIdx = 0
      const rawTurn = (f as { turn_idx?: unknown }).turn_idx
      if (typeof rawTurn === "number") turnIdx = Math.floor(rawTurn)
      else if (typeof rawTurn === "string") {
        const n = parseInt(rawTurn, 10)
        if (!Number.isNaN(n)) turnIdx = n
      }
      return {
        predicate: String(f.predicate).trim(),
        statement: String(f.statement),
        subject: (f.subject && String(f.subject)) || "user",
        source: ((f.source && String(f.source)) || "user") as
          | "user"
          | "assistant"
          | "synthesis",
        object: (f.object && String(f.object)) || "",
        value: (f.value && String(f.value)) || "",
        event_date: (f.event_date && String(f.event_date)) || "",
        turn_idx: turnIdx,
        typed_refs: typedRefs,
      }
    })

  return { entities, facts }
}
