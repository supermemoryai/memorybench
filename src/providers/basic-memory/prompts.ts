import type { ProviderPrompts } from "../../types/prompts"

interface BasicMemoryResult {
  title?: string
  permalink?: string
  content?: string
  matched_chunk?: string
  score?: number
  metadata?: {
    sessionId?: string
    date?: string
    [key: string]: unknown
  }
}

function buildBasicMemoryContext(context: unknown[]): string {
  const results = context as BasicMemoryResult[]

  if (results.length === 0) {
    return "No relevant notes were found in the knowledge base."
  }

  return results
    .map((result, i) => {
      const title = result.title || result.permalink || `note-${i + 1}`
      const date = result.metadata?.date
      const relevance =
        typeof result.score === "number" ? ` (relevance: ${result.score.toFixed(2)})` : ""
      const dateLine = date ? `Date: ${date}\n` : ""
      // matched_chunk is the search-engine hit; content is the full note body.
      const body = result.content || result.matched_chunk || ""
      return `=== Note ${i + 1}: ${title}${relevance} ===\n${dateLine}${body}`
    })
    .join("\n\n---\n\n")
}

export function buildBasicMemoryAnswerPrompt(
  question: string,
  context: unknown[],
  questionDate?: string
): string {
  const retrievedContext = buildBasicMemoryContext(context)

  return `You are a question-answering system. You have access to a Basic Memory knowledge base: a graph of Markdown notes built from conversation sessions. Based on the retrieved notes below, answer the question.

Question: ${question}
Question Date: ${questionDate || "Not specified"}

Retrieved Notes:
${retrievedContext}

**Understanding the Context:**
Each note above was created from a conversation session and stored as Markdown in Basic Memory. Notes may include a session date and the verbatim conversation transcript between speakers.

**How to Answer:**
1. Scan the notes for facts, events, preferences, and relationships relevant to the question.
2. Pay attention to the session Date for temporal reasoning.
3. For time-based questions, calculate relative dates ("last week", "yesterday") using the session date, then relate them to the question date.
4. Cross-reference information across multiple notes if needed.

Instructions:
- Base your answer ONLY on the provided notes.
- If the notes contain enough information, provide a clear, concise answer.
- If the notes do not contain enough information, respond with "I don't know".
- Pay attention to temporal context for time-based questions.

Reasoning:
[Your step-by-step reasoning process here]

Answer:
[Your final answer here]`
}

export const BASIC_MEMORY_PROMPTS: ProviderPrompts = {
  answerPrompt: buildBasicMemoryAnswerPrompt,
}

export default BASIC_MEMORY_PROMPTS
