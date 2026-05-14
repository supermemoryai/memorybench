// Per-session LLM distillation step for the Memento provider.
//
// `extract_memory` in Memento is the *storage* side — it embeds, dedups,
// scrubs, and persists candidates. It does NOT run an LLM itself
// (Memento is local-first and LLM-agnostic per the project's
// architectural commitments). The decision of *what's worth
// remembering* belongs to the calling AI assistant.
//
// In production, the assistant looks at a conversation and produces
// distilled `{kind, content}` candidates before calling `extract_memory`.
// This provider mirrors that flow inside the bench: it calls an LLM
// with each session transcript, parses the result into candidates,
// and hands them to Memento.
//
// The LLM is configurable via `MEMENTO_DISTILL_MODEL` (default matches
// memorybench's answering-model alias for the run). Pinning the same
// alias for distill and answer keeps the cross-benchmark story simple.

import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createOpenAI } from "@ai-sdk/openai"
import { generateText } from "ai"
import { config } from "../../utils/config"
import { getModelConfig, DEFAULT_ANSWERING_MODEL } from "../../utils/models"
import type { UnifiedSession } from "../../types/unified"

// All five Memento memory kinds are eligible. `preference` and `decision`
// require a `topic: value\n\nprose` first line in `content` (the conflict
// detector parses that line); the LLM is instructed to follow that shape
// on a best-effort basis. This matches real-world usage: SKILL.md teaches
// the same format to assistants, and there is no server-side coercion
// rescuing a malformed candidate. Malformed candidates fail the whole
// extract_memory batch they belong to, which is the same cost a real
// assistant would face for the same mistake.
export type DistilledKind = "fact" | "preference" | "decision" | "todo" | "snippet"

export interface DistilledCandidate {
  kind: DistilledKind
  content: string
  summary?: string
}

const DISTILL_KINDS: readonly DistilledKind[] = [
  "fact",
  "preference",
  "decision",
  "todo",
  "snippet",
]

function getLLMClient(modelAlias: string) {
  const modelConfig = getModelConfig(modelAlias)
  switch (modelConfig.provider) {
    case "openai":
      return { client: createOpenAI({ apiKey: config.openaiApiKey }), modelConfig }
    case "anthropic":
      return { client: createAnthropic({ apiKey: config.anthropicApiKey }), modelConfig }
    case "google":
      return {
        client: createGoogleGenerativeAI({ apiKey: config.googleApiKey }),
        modelConfig,
      }
  }
}

function buildDistillPrompt(session: UnifiedSession): string {
  const sessionDate = session.metadata?.date as string | undefined
  const formattedDate = session.metadata?.formattedDate as string | undefined
  const dateLine = sessionDate ? `Session date: ${sessionDate}` : ""
  const friendlyDate = formattedDate ? ` (${formattedDate})` : ""

  const transcript = session.messages
    .map((m) => {
      const ts = m.timestamp ? ` [${m.timestamp}]` : ""
      return `${m.role}${ts}: ${m.content}`
    })
    .join("\n")

  return `You are the memory-distillation step of an AI assistant. The assistant just finished a conversation; you must decide what is worth keeping in a durable, searchable memory layer (Memento).

You are **not** summarising the conversation for a reader. You are producing **retrieval candidates for unknown future queries**. The future query may ask about any specific date, named entity, proper noun, action, or object that appeared in the conversation — including ones that feel incidental at write time. The right mental frame is "index every concrete reference," not "capture the gist."

${dateLine}${friendlyDate}

Conversation transcript:
${transcript}

Produce a JSON array of memory candidates. Each candidate is a self-contained assertion the assistant should remember for future conversations.

**Rules, in priority order:**

1. **PRESERVE specific words.** Use the speakers' exact terms for proper nouns, named entities, identity qualifiers, places, organisations, and the specific object of any action. Do not paraphrase concrete details into broader categories — the future question will use the specific term, and a paraphrase makes the memory unfindable. Pattern (anti-pattern → correct):
   - "researched <X>" → preserve <X>. Do not collapse to "researched options".
   - "identifies as <qualifier> <noun>" → preserve the qualifier. Do not drop it to the bare noun.
   - "went to the <named place>" → name it. Do not collapse to "a place".

2. **Capture facts about every named participant, not only the user.** A conversation may involve more than one named person — a friend the user mentions, a colleague, a family member, or (in a multi-party transcript) another speaker. Facts each named person shares about themselves AND the user's specific observations about them are both worth indexing. Attribute each candidate to the right named person — never "the speakers" collectively, never just "the user" when the fact is about someone else.
   - "My friend Alex is moving to Berlin next month for a SAP job" → emit "Alex is moving to Berlin in <month>" AND "Alex has a new job at SAP" (attributed to Alex).
   - In a two-party transcript: if Caroline says "I researched adoption agencies" and Melanie says "I made a plate in pottery class on August 24", BOTH facts get captured — one attributed to Caroline, the other to Melanie. Do not bias toward the first speaker, the more talkative one, or the apparent "user" persona; index both sides.

3. **Emit a candidate for every dated event.** A "dated event" is any assertion that maps to a specific point in time: absolute ("May 7", "in 2022", "last December"), or relative to the session_date ("yesterday", "last Tuesday", "two weeks ago", "this morning"). Resolve relative dates against the session_date and emit the absolute date in the content. Do NOT generalise dated events into untimed habits ("the user participates in <thing>" loses the date and the answer to "when did it happen?" is now gone). When the same event has both a date-anchored framing and a thematic framing, emit BOTH as separate candidates.

4. **Capture precursor actions alongside outcomes.** When the conversation describes a sequence ("researched X then chose Y", "tried A and settled on B", "considered <options> and picked <one>"), emit a candidate for the precursor (the research, the try, the consideration) AND a candidate for the outcome. Future questions can target either step. Outcomes never erase precursors — "What did the user research?" and "What did the user choose?" have different answers and need different candidates.

5. **Don't squash enumerations.** If the speaker lists three things (hobbies, books, people, options), emit them as three candidates or as one candidate that names all three. Never collapse to a category label ("outdoor activities", "various books") — the future question will name one item from the list, and the category label won't match.

6. **Each candidate is self-contained.** Include the actor's name and any context the assertion needs to be understood in isolation, with no surrounding messages.

7. **Pick the right kind. For \`preference\` and \`decision\`, follow the topic-line rule.**
   - \`fact\` — a stable assertion about the world or the speakers (what they did, where they live, how they identify, what is true of them right now). Default for most assertions.
   - \`preference\` — a soft-but-durable preference that should bias future behaviour (a baking style they like, a tool they choose, a writing convention they hold, a likes/dislikes pattern). REQUIRED FORMAT: \`content\` MUST start with a single \`topic: value\` line followed by a blank line and prose. The conflict detector parses that first line; without it the entire extract_memory batch is rejected with INVALID_INPUT, dropping all candidates that travelled with the offender. Do this best-effort on every preference candidate:
\`\`\`
baking-style: lemon-themed
[blank line]
The speaker has had success with lemon bakes (e.g. the lemon cake at the last gathering) and reaches for lemon recipes when stuck for ideas.
\`\`\`
   - \`decision\` — a chosen path among alternatives, often with reasoning. Same \`topic: value\\n\\nprose\` format requirement as preference. Example: \`storage-engine: SQLite\\n\\nChosen for the local-first story; FTS5 built in, no daemon.\`
   - \`todo\` — an action the speaker explicitly intends to take in the future.
   - \`snippet\` — a reusable code fragment or quote worth preserving verbatim.
   When in doubt between \`fact\` and \`preference\`, prefer \`preference\` for forward-looking biases ("the speaker tends to / prefers / reaches for X") and \`fact\` for backward-looking events ("the speaker did Y on Z"). Both can co-exist for the same theme.

8. **Bias toward inclusion.** Better 20 precise candidates than 5 broad ones. The server dedups via embedding similarity, so two near-equivalent candidates collapse to one row — the cost of over-including is low; the cost of under-including is permanent (the fact is gone). Skip only pleasantries (greetings, "thanks", "lol", small talk).

9. **Output JSON only.** No markdown fences, no reasoning prose, no commentary.

Schema:
\`\`\`
[
  { "kind": "fact" | "todo" | "snippet",
    "content": "<self-contained assertion, 1-3 sentences>",
    "summary": "<optional short label, <= 60 chars>" }
]
\`\`\`

If nothing in the session is worth remembering, return \`[]\`.

**Before you emit, do one pass over the transcript and check:** does every (a) date or time-relative word, (b) proper noun / named entity, (c) action verb with a specific object map to at least one candidate? If a reference is missing, add the candidate now.

JSON:`
}

function parseDistillResponse(text: string): DistilledCandidate[] {
  // Strip markdown fences the model might emit despite instructions.
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim()
  // Some models prefix with "JSON:" or similar. Take the slice starting at
  // the first `[` and ending at the matching last `]`.
  const start = trimmed.indexOf("[")
  const end = trimmed.lastIndexOf("]")
  if (start < 0 || end < start) return []
  const raw = trimmed.slice(start, end + 1)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const candidates: DistilledCandidate[] = []
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue
    const obj = item as Record<string, unknown>
    const rawKind = typeof obj.kind === "string" ? obj.kind.toLowerCase() : null
    const content = typeof obj.content === "string" ? obj.content.trim() : null
    if (!rawKind || !content) continue
    if (content.length === 0) continue
    // The five valid kinds are accepted as-is. An unrecognised kind
    // (e.g. the LLM hallucinated "memory" or "thought") coerces to
    // `fact` — the safe free-form catch-all. preference/decision
    // candidates with a missing topic-line are NOT coerced here; they
    // pass through and let Memento's INVALID_INPUT response surface
    // the prompt-following failure as honestly as a real assistant
    // would face it.
    const kind: DistilledKind = DISTILL_KINDS.includes(rawKind as DistilledKind)
      ? (rawKind as DistilledKind)
      : "fact"
    const summary =
      typeof obj.summary === "string" && obj.summary.trim().length > 0
        ? obj.summary.trim().slice(0, 60)
        : undefined
    candidates.push({ kind, content, ...(summary ? { summary } : {}) })
  }
  return candidates
}

export interface DistillResult {
  candidates: DistilledCandidate[]
  rawResponseChars: number
  modelAlias: string
  promptTokens?: number
  responseTokens?: number
}

export async function distillSession(session: UnifiedSession): Promise<DistillResult> {
  const modelAlias = process.env.MEMENTO_DISTILL_MODEL ?? DEFAULT_ANSWERING_MODEL
  const { client, modelConfig } = getLLMClient(modelAlias)
  const prompt = buildDistillPrompt(session)

  // Build params in the same shape memorybench's answer phase uses.
  const params: Record<string, unknown> = {
    model: (client as unknown as (id: string) => unknown)(modelConfig.id),
    prompt,
  }
  // Force temperature=0 for distillation regardless of the model's
  // default. memorybench pins Gemini-3 at temp=1 for answer-generation
  // (because lower allegedly causes "issues" with reasoning) but
  // distillation needs determinism — the same conversation should
  // always produce the same candidate set, or the bench is measuring
  // sampling variance instead of system capability. Override via
  // MEMENTO_DISTILL_TEMPERATURE if the default-zero turns out to
  // break a specific model in practice.
  if (modelConfig.supportsTemperature) {
    const envTemp = process.env.MEMENTO_DISTILL_TEMPERATURE
    const tempOverride = envTemp !== undefined ? Number(envTemp) : 0
    if (!Number.isFinite(tempOverride) || tempOverride < 0 || tempOverride > 2) {
      throw new Error(`MEMENTO_DISTILL_TEMPERATURE must be a number in [0, 2] (got: ${envTemp})`)
    }
    params.temperature = tempOverride
  }
  // Use the right maxTokens parameter name for the model family.
  params[modelConfig.maxTokensParam] = 4000

  const { text, usage } = await generateText(params as Parameters<typeof generateText>[0])
  const candidates = parseDistillResponse(text)
  return {
    candidates,
    rawResponseChars: text.length,
    modelAlias,
    promptTokens: usage?.inputTokens,
    responseTokens: usage?.outputTokens,
  }
}
