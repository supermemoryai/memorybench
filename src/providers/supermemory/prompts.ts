import type { ProviderPrompts } from "../../types/prompts"
import type { UnifiedSearchResult } from "../../types/unified"

function buildSupermemoryContext(context: unknown[]): string {
  const results = context as UnifiedSearchResult[]
  if (results.length === 0) return "No relevant evidence was retrieved."

  return results
    .map((result, index) => {
      const date = result.documentDate ? `[${result.documentDate}] ` : ""
      return `${index + 1}. ${date}${result.text}`
    })
    .join("\n")
}

export function buildSupermemoryAnswerPrompt(
  question: string,
  context: unknown[],
  questionDate?: string
): string {
  return `You are a question-answering system. Based only on the retrieved evidence below, answer the question.

Question: ${question}
Question Date: ${questionDate || "Not specified"}

Retrieved Evidence:
${buildSupermemoryContext(context)}

Instructions:
- Read all evidence before answering.
- Use document dates to resolve temporal relationships and prefer newer evidence when facts conflict.
- If the evidence is insufficient, respond with "I don't know".
- Give a clear, concise answer without exposing internal result metadata.

Answer:`
}

export const SUPERMEMORY_PROMPTS: ProviderPrompts = {
  answerPrompt: buildSupermemoryAnswerPrompt,
}

export default SUPERMEMORY_PROMPTS
