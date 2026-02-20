import type { ProviderPrompts } from "../../types/prompts"

/**
 * RagZoom search results contain a single synthesized answer from the
 * agentic search agent, not an array of chunks. We wrap it as context.
 */
interface RagZoomSearchResult {
  answer: string
  document_id: string
  question: string
}

function buildRagZoomContext(context: unknown[]): string {
  const results = context as RagZoomSearchResult[]

  if (results.length === 0) {
    return "No relevant information was retrieved."
  }

  // RagZoom search returns a single synthesized answer per query
  return results
    .map((result, i) => {
      return `[Memory Search Result ${i + 1}]\n${result.answer}`
    })
    .join("\n\n---\n\n")
}

export function buildRagZoomAnswerPrompt(
  question: string,
  context: unknown[],
  questionDate?: string
): string {
  const retrievedContext = buildRagZoomContext(context)

  return `You are a question-answering system. Based on the retrieved memory context below, answer the question.

Question: ${question}
Question Date: ${questionDate || "Not specified"}

Retrieved Memory Context (from RagZoom agentic search):
${retrievedContext}

**Understanding the Context:**
The context comes from RagZoom's agentic search, which iteratively zooms into a hierarchical
summary tree of conversation history. The search agent has already done multi-step retrieval
and reasoning to produce a synthesized answer. The context above is the search agent's output.

**How to Answer:**
1. Read the search result carefully — it is a targeted answer from the memory system
2. Use the information provided to answer the question directly
3. If the search result addresses the question, relay the relevant information
4. If the search result says it could not find the information, respond with "I don't know"
5. For temporal questions, use any date references in the search result

Instructions:
- Base your answer ONLY on the provided context
- Provide a clear, concise answer
- Do not make up information not present in the context
- If the context does not contain enough information, respond with "I don't know"

Reasoning:
[Your step-by-step reasoning process here]

Answer:
[Your final answer here]`
}

export const RAGZOOM_PROMPTS: ProviderPrompts = {
  answerPrompt: buildRagZoomAnswerPrompt,
}

export default RAGZOOM_PROMPTS
