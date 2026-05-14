import type { ProviderPrompts } from "../../types/prompts"
import type { MementoSearchPage } from "./mcp-helpers"

type MementoResult = MementoSearchPage["results"][number]

function buildMementoContext(context: unknown[]): string {
  const results = context as MementoResult[]
  if (results.length === 0) {
    return "No memories matched this query in the per-question workspace scope."
  }
  return results
    .map((r, i) => {
      const content = r.memory.content ?? "[redacted]"
      const sessionDate = r.memory.tags
        .find((t) => t.startsWith("session-date:"))
        ?.slice("session-date:".length)
      const header =
        `=== Memory ${i + 1} (score=${r.score.toFixed(3)}` +
        (sessionDate ? `, session_date=${sessionDate}` : "") +
        ", kind=" +
        r.memory.kind.type +
        ") ==="
      return `${header}\n${content}`
    })
    .join("\n\n")
}

export function buildMementoAnswerPrompt(
  question: string,
  context: unknown[],
  questionDate?: string
): string {
  const retrievedContext = buildMementoContext(context)

  return `You are answering a question over a long, multi-session conversation. Memento — a local-first MCP memory layer — has retrieved the distilled memories most relevant to the question. Each memory is a self-contained assertion an AI assistant chose to remember from a single session of the original conversation.

Question: ${question}
Question Date: ${questionDate || "Not specified"}

Retrieved memories (highest-ranked first):
${retrievedContext}

**Understanding the context:**
- Each "Memory" block is one distilled assertion (a fact, preference, decision, todo, or snippet) extracted from one session of the conversation.
- \`score\` is the combined FTS + vector retrieval score (higher = more relevant).
- \`session_date\`, when present, is the date of the session the memory was distilled from. Relative time expressions inside a memory are typically already resolved against the session_date during distillation, but if you see one that isn't, resolve it now.
- \`kind\` describes the memory type the assistant chose at distillation time.

**How to answer:**
1. Scan the retrieved memories for assertions that directly answer the question.
2. Cross-reference memories when the question requires combining information from multiple sessions.
3. For time-based questions, prefer absolute dates already present in memories; only fall back to relative resolution if no absolute is given.
4. When the ground truth expects a specific format (e.g. "7 May 2023"), emit the absolute value.
5. If the retrieved memories do not contain enough information to answer, respond exactly "I don't know".

Reasoning:
[Your step-by-step reasoning here]

Answer:
[Your final answer here]`
}

export const MEMENTO_PROMPTS: ProviderPrompts = {
  answerPrompt: buildMementoAnswerPrompt,
}

export default MEMENTO_PROMPTS
