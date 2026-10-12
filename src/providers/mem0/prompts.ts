import type { ProviderPrompts } from "../../types/prompts"

interface Mem0Memory {
  memory?: string
  metadata?: Record<string, unknown>
}

/** Mem0's own harness renders each memory as "<timestamp>: <memory>" */
export function formatMem0Context(context: unknown[]): string {
  return context
    .map((r) => {
      const mem = r as Mem0Memory
      const ts = mem.metadata?.timestamp || mem.metadata?.date
      return `${ts ? `${ts}: ` : ""}${mem.memory || JSON.stringify(r)}`
    })
    .join("\n")
}

export function buildMem0AnswerPrompt(question: string, context: unknown[]): string {
  const memoriesStr = context
    .map((r, i) => {
      const mem = r as Mem0Memory
      const metadata = mem.metadata
      const timestampInfo =
        metadata?.date || metadata?.timestamp
          ? ` [Timestamp: ${metadata.date || metadata.timestamp}]`
          : ""
      return `[${i + 1}]${timestampInfo} ${mem.memory || JSON.stringify(r)}`
    })
    .join("\n\n")

  return `You are an intelligent memory assistant tasked with retrieving accurate information from conversation memories.

Key instructions:
- Analyze the memories with their timestamps carefully
- Prioritize the most recent memory when contradictions exist
- Convert relative time references (e.g., "last year", "last week") to specific dates based on timestamps
- Look for direct evidence in the memories
- Don't confuse character names with actual users

Approach:
1. Examine memories related to the question
2. Analyze timestamps and content carefully
3. Look for explicit dates, times, locations, or events
4. Calculate relative time references (show your work if needed)
5. Formulate a precise, concise answer
6. Verify the answer addresses the question directly
7. Ensure specificity - avoid vague time references in your answer

Memories:
${memoriesStr}

Question: ${question}

Answer concisely and directly.`
}

/**
 * Mem0 provider prompts configuration.
 */
export const MEM0_PROMPTS: ProviderPrompts = {
  answerPrompt: buildMem0AnswerPrompt,
  formatContext: formatMem0Context,
}

export default MEM0_PROMPTS
