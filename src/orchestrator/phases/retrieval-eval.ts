import type { RetrievalMetrics } from "../../types/unified"
import type { LanguageModel } from "ai"
import { generateText } from "ai"
import { logger } from "../../utils/logger"

interface RelevanceResult {
  id: string
  relevant: 0 | 1
}

async function evaluateAllChunks(
  model: LanguageModel,
  question: string,
  groundTruth: string,
  searchResults: unknown[]
): Promise<RelevanceResult[] | null> {
  if (searchResults.length === 0) return []

  const formattedResults = searchResults
    .map((result, index) => {
      const id = `result_${index + 1}`
      const content = JSON.stringify(result, null, 2)
      return `=== ${id} ===\n${content}`
    })
    .join("\n\n")

  const prompt = `You are evaluating search results for relevance to a question.

QUESTION:
${question}

EXPECTED ANSWER:
${groundTruth}

SEARCH RESULTS:
${formattedResults}

TASK:
For each search result, determine if it contains information relevant to answering the question.
A result is relevant if it contains content that helps answer the question or supports the expected answer.

Return a JSON array with your evaluation for each result:
[
  {"id": "result_1", "relevant": 1},
  {"id": "result_2", "relevant": 0},
  ...
]

Where:
- "id" is the result identifier (result_1, result_2, etc.)
- "relevant" is 1 if relevant, 0 if not relevant

Return ONLY the JSON array, no other text.`

  // A judge that times out, rate-limits, or answers unparseably tells us nothing about
  // relevance. Returning all-zeros made that indistinguishable from "the provider retrieved
  // nothing useful" and quietly dragged the provider's retrieval numbers down, so failures
  // now return null and the question is left out of the aggregate instead.
  try {
    const response = await generateText({
      model,
      messages: [{ role: "user", content: prompt }],
    })

    const jsonMatch = response.text.match(/\[[\s\S]*\]/)
    if (!jsonMatch) {
      logger.warn("Relevance judge returned no JSON array; skipping retrieval metrics")
      return null
    }

    return JSON.parse(jsonMatch[0]) as RelevanceResult[]
  } catch (e) {
    logger.warn(`Relevance judge failed; skipping retrieval metrics: ${e}`)
    return null
  }
}

/**
 * Retrieval metrics for one question, or `undefined` when the relevance judge could not be
 * consulted — the caller leaves those questions out of the aggregate rather than recording
 * a zero it cannot justify.
 *
 * Only metrics that are well defined without a ground-truth relevance count are produced.
 * Recall@K, F1@K and NDCG need to know how many relevant memories exist in the corpus; that
 * number is not available here, and substituting the retrieved count (as this used to) makes
 * recall identical to Hit@K and NDCG blind to anything the provider missed.
 */
export async function calculateRetrievalMetrics(
  model: LanguageModel,
  question: string,
  groundTruth: string,
  searchResults: unknown[],
  k: number = 10
): Promise<RetrievalMetrics | undefined> {
  const resultsToEval = searchResults.slice(0, k)

  if (resultsToEval.length === 0) {
    // Retrieved nothing, so nothing was relevant. This is a real measurement, not a failure.
    return { hitAtK: 0, precisionAtK: 0, mrr: 0, k: 0, relevantRetrieved: 0 }
  }

  const relevanceResults = await evaluateAllChunks(model, question, groundTruth, resultsToEval)
  if (relevanceResults === null) return undefined

  const relevanceScores = resultsToEval.map((_, i) => {
    const result = relevanceResults.find((r) => r.id === `result_${i + 1}`)
    return result?.relevant === 1 ? 1 : 0
  })

  const relevantRetrieved = relevanceScores.filter((r) => r === 1).length
  const firstRelevantIndex = relevanceScores.findIndex((r) => r === 1)

  return {
    hitAtK: relevantRetrieved > 0 ? 1 : 0,
    precisionAtK: relevantRetrieved / resultsToEval.length,
    mrr: firstRelevantIndex >= 0 ? 1 / (firstRelevantIndex + 1) : 0,
    k: resultsToEval.length,
    relevantRetrieved,
  }
}
