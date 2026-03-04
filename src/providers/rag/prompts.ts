import type { ProviderPrompts } from "../../types/prompts"

interface RAGSearchResult {
  content: string
  score: number
  vectorScore: number
  bm25Score: number
  sessionId: string
  chunkIndex: number
  date?: string
  metadata?: Record<string, unknown>
}

function buildRAGContext(context: unknown[]): string {
  const results = context as RAGSearchResult[]

  if (results.length === 0) {
    return "No relevant memory chunks were retrieved."
  }

  return results
    .map((result, i) => {
      const scoreParts = [
        `hybrid: ${result.score.toFixed(3)}`,
        `semantic: ${result.vectorScore.toFixed(3)}`,
        `keyword: ${result.bm25Score.toFixed(3)}`,
      ].join(", ")

      const date = result.date || (result.metadata?.date as string) || undefined
      const dateStr = date ? ` | Date: ${date}` : ""

      return `[Chunk ${i + 1}] (session: ${result.sessionId}, scores: ${scoreParts}${dateStr})
${result.content}`
    })
    .join("\n\n---\n\n")
}

export function buildRAGAnswerPrompt(
  question: string,
  context: unknown[],
  questionDate?: string
): string {
  const retrievedContext = buildRAGContext(context)

  return `You are a question-answering system. Based on the retrieved memory chunks below, answer the question.

Question: ${question}
Question Date: ${questionDate || "Not specified"}

Retrieved Memory Chunks (ranked by hybrid BM25 + vector relevance):
${retrievedContext}

**Understanding the Context:**
The context contains memory chunks retrieved via hybrid search (BM25 keyword matching + vector semantic similarity). Each chunk is a passage from an extracted memory file containing curated facts, events, preferences, and relationships -- NOT raw conversation text.

- **Higher hybrid scores** indicate stronger relevance
- **Semantic score** measures meaning-level similarity to your question
- **Keyword score** measures direct term overlap with your question
- **Date** indicates when the original conversation took place
- Chunks from the same session are from the same memory extraction

**How to Answer:**
1. Start with the highest-scored chunks as they are most likely relevant
2. Look for specific facts, names, dates, preferences, and relationships in the structured memory content
3. Cross-reference information across chunks from the same or different sessions
4. For temporal questions, use the chunk dates and any date references within the memory text
5. Synthesize information from multiple chunks if needed

Instructions:
- Base your answer ONLY on the provided chunks
- The chunks contain curated, extracted memories -- look for direct matches to the question
- If the chunks contain enough information, provide a clear, concise answer
- If the chunks do not contain enough information, respond with "I don't know"
- Pay attention to temporal context for time-based questions

Reasoning:
[Your step-by-step reasoning process here]

Answer:
[Your final answer here]`
}

export const RAG_PROMPTS: ProviderPrompts = {
  answerPrompt: buildRAGAnswerPrompt,
}

export default RAG_PROMPTS
