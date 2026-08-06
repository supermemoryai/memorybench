import { sha256Text } from "../utils/stable"

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

const MONTH_TO_NUMBER: Record<string, string> = Object.fromEntries(
  MONTH_NAMES.map((name, i) => [name.toLowerCase(), String(i + 1).padStart(2, "0")])
)

/**
 * Parse BEAM's per-batch time_anchor strings into ISO YYYY-MM-DD. BEAM stores
 * these as "Month-DD-YYYY" (e.g. "March-01-2024"); some batches have a null
 * anchor, in which case we return undefined and the memory line is rendered
 * without a date prefix (matching mem0's "if no created_at" branch).
 */
export function parseBeamTimeAnchor(anchor: unknown): string | undefined {
  if (typeof anchor !== "string") return undefined
  const m = anchor.match(/^(\w+)-(\d{1,2})-(\d{4})$/)
  if (!m) return undefined
  const [, monthName, dayStr, year] = m
  const month = MONTH_TO_NUMBER[monthName.toLowerCase()]
  if (!month) return undefined
  return `${year}-${month}-${dayStr.padStart(2, "0")}`
}

/**
 * Human-readable form of a BEAM ISO date, used as `formattedDate` on session
 * metadata so the Supermemory provider includes a natural-language date prefix
 * in the ingested content (mirrors the LocoMo / LongMemEval pattern).
 */
export function formatBeamDate(iso: string): string {
  const [year, month, day] = iso.split("-")
  const monthName = MONTH_NAMES[parseInt(month, 10) - 1]
  if (!monthName) return iso
  return `${monthName} ${parseInt(day, 10)}, ${year}`
}

interface BeamMemoryLike {
  memory?: string
  content?: string
  metadata?: { sessionId?: string }
}

export type BeamAnswerFormat = "default" | "event-ordering-lines"

/**
 * The pinned BEAM scorer treats every non-empty answer line as one predicted
 * event. This format-only rule makes that scorer input explicit without adding
 * a second semantic extraction step.
 */
export const BEAM_EVENT_ORDERING_ANSWER_FORMAT_VERSION = "authors-newline-scorer-compatible-v1"

/**
 * BEAM answer prompt. The protocol applies its configured answer cutoff before
 * calling this formatter; this function only orders and renders normalized
 * evidence and never sees provider-specific raw JSON.
 */
export function buildBeamAnswerPrompt(
  question: string,
  memories: unknown[],
  sessionDateMap: Map<string, string>,
  answerFormat: BeamAnswerFormat = "default"
): string {
  const memoriesText = formatBeamMemories(memories as BeamMemoryLike[], sessionDateMap)
  const eventOrderingRule =
    answerFormat === "event-ordering-lines"
      ? "\n10. For this event-ordering question, output exactly one event per line in chronological order. Do not use bullets, numbering, headings, or explanations."
      : ""
  return `You are an AI assistant with access to stored memories from prior conversations with a user.
Use these memories to answer the following question as accurately and completely as possible.

IMPORTANT RULES:
1. Scan ALL provided memories before answering — do not stop after the first relevant one.
2. If multiple memories contain relevant information, combine and cross-reference them.
3. If the memories contain contradictory information, prefer the more recent one.
4. If the memories don't contain enough information to answer, say exactly: "I don't have enough information to answer this question."
5. For temporal questions: pay attention to dates and relative time references.
6. For ordering questions: present events in chronological order.
7. For preference questions: use the most recently stated preference.
8. Be specific and direct — include exact names, dates, numbers, and details from the memories.
9. Do NOT invent or assume information that isn't in the memories.${eventOrderingRule}

QUESTION: ${question}

RETRIEVED MEMORIES:
${memoriesText}

ANSWER:`
}

function formatBeamMemories(
  memories: BeamMemoryLike[],
  sessionDateMap: Map<string, string>
): string {
  if (memories.length === 0) return "(No memories available)"

  // Resolve text + date per memory.
  const items = memories.map((m) => {
    const text = typeof m?.memory === "string" ? m.memory : m.content
    if (typeof text !== "string" || !text.trim()) {
      throw new Error("BEAM prompt received evidence without normalized text")
    }
    const sessionId = typeof m?.metadata?.sessionId === "string" ? m.metadata.sessionId : ""
    const date = sessionId ? sessionDateMap.get(sessionId) : undefined
    return { text, sessionId, date }
  })

  // mem0 sorts by created_at ascending (oldest first). When date is missing
  // we fall back to sessionId order, which is itself chronological for BEAM
  // since sessionIds encode batch + turn ordinals.
  items.sort((a, b) => {
    const aKey = a.date || ""
    const bKey = b.date || ""
    if (aKey !== bKey) return aKey.localeCompare(bKey)
    return a.sessionId.localeCompare(b.sessionId, undefined, { numeric: true })
  })

  return items
    .map((item, i) => {
      const prefix = item.date ? `[${item.date}] ` : ""
      return `${i + 1}. ${prefix}${item.text}`
    })
    .join("\n")
}

/** Changes whenever either the public prompt builder or its evidence/date renderer changes. */
export const BEAM_ANSWER_FORMATTER_IMPLEMENTATION_HASH = sha256Text(
  [buildBeamAnswerPrompt.toString(), formatBeamMemories.toString()].join("\n\n")
)
