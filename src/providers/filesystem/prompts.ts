import type { ProviderPrompts } from "../../types/prompts"
import type { UnifiedSearchResult } from "../../types/unified"

function buildFilesystemContext(context: unknown[]): string {
  const results = context as UnifiedSearchResult[]

  if (results.length === 0) {
    return "No relevant memory files were found."
  }

  return results
    .map((result, i) => {
      const date = result.documentDate ? ` [${result.documentDate}]` : ""
      return `=== Memory File ${i + 1}${date} ===\n${result.text}`
    })
    .join("\n\n---\n\n")
}

export function buildFilesystemAnswerPrompt(
  question: string,
  context: unknown[],
  questionDate?: string
): string {
  const retrievedContext = buildFilesystemContext(context)

  return `You are a question-answering system. You have access to structured memory files containing extracted facts, events, preferences, and relationships. Based on the retrieved memories below, answer the question.

Question: ${question}
Question Date: ${questionDate || "Not specified"}

Retrieved Memory Files:
${retrievedContext}

**Understanding the Context:**
The context above contains structured memory extractions from conversations (similar to Claude Code's MEMORY.md files). Each memory file contains categorized information: key facts, preferences, events with dates, relationships, and decisions.

**How to Answer:**
1. Scan the memory files for facts, events, and preferences relevant to the question
2. Pay attention to dates in the Events sections for temporal reasoning
3. Cross-reference facts across multiple memory files if needed
4. For time-based questions, calculate relative dates using the event dates and the question date
5. Use the structured categories (Key Facts, Preferences, Events, Relationships) to locate information quickly

Instructions:
- Base your answer ONLY on the provided memory files
- The memories contain curated, extracted facts -- look for direct matches to the question
- If the memories contain enough information, provide a clear, concise answer
- If the memories do not contain enough information, respond with "I don't know"
- Pay attention to temporal context for time-based questions

Reasoning:
[Your step-by-step reasoning process here]

Answer:
[Your final answer here]`
}

export const FILESYSTEM_PROMPTS: ProviderPrompts = {
  answerPrompt: buildFilesystemAnswerPrompt,
}

export default FILESYSTEM_PROMPTS
