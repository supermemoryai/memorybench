import { z } from "zod"
import type { AuxiliaryRetrievalEvaluationPolicy, EvaluationRuntime } from "../../types/protocol"
import type { RetrievalMetrics, UnifiedSearchResult } from "../../types/unified"

interface RelevanceResult {
  id: string
  relevant: 0 | 1
}

function formatResultForRelevance(result: UnifiedSearchResult, id: string): string {
  return [
    `=== ${id} ===`,
    `PROVIDER: ${result.provider}`,
    `RESULT_TYPE: ${result.resultType}`,
    `RANK: ${result.rank}`,
    ...(result.score === undefined ? [] : [`SCORE: ${result.score}`]),
    ...(result.sessionId ? [`SESSION_ID: ${result.sessionId}`] : []),
    ...(result.documentDate ? [`DOCUMENT_DATE: ${result.documentDate}`] : []),
    "TEXT:",
    result.text,
  ].join("\n")
}

async function evaluateAllChunks(
  runtime: EvaluationRuntime,
  question: string,
  groundTruth: string,
  searchResults: UnifiedSearchResult[]
): Promise<RelevanceResult[]> {
  if (searchResults.length === 0) return []

  const expectedIds = searchResults.map((_, index) => `result_${index + 1}`)
  const responseSchema = z
    .object({
      results: z
        .array(
          z
            .object({
              id: z.string().min(1),
              relevant: z.union([z.literal(0), z.literal(1)]),
            })
            .strict()
        )
        .length(searchResults.length),
    })
    .strict()
    .superRefine((output, context) => {
      for (let index = 0; index < expectedIds.length; index++) {
        if (output.results[index]?.id !== expectedIds[index]) {
          context.addIssue({
            code: "custom",
            path: ["results", index, "id"],
            message: `Retrieval relevance output ID mismatch: expected ${expectedIds[index]}, got ${output.results[index]?.id ?? "<missing>"}`,
          })
        }
      }
    })
  const formattedResults = searchResults
    .map((result, index) => formatResultForRelevance(result, expectedIds[index]!))
    .join("\n\n")

  const prompt = `Evaluate each normalized search result for relevance to the question.

QUESTION:
${question}

EXPECTED ANSWER:
${groundTruth}

NORMALIZED SEARCH RESULTS:
${formattedResults}

A result is relevant when its TEXT contains information that helps answer the question or supports the expected answer. Return one result for every supplied ID, in the same order.`

  const output = await runtime.generateStructured({
    system:
      "You are a retrieval relevance evaluator. Judge only the normalized result text supplied by the harness and follow the response schema exactly.",
    prompt,
    schema: responseSchema,
    schemaName: "legacy_retrieval_relevance",
    temperature: 0,
    maxOutputTokens: Math.max(256, searchResults.length * 32),
    maxAttempts: 3,
    timeoutMs: 120_000,
  })

  for (let index = 0; index < expectedIds.length; index++) {
    if (output.results[index]?.id !== expectedIds[index]) {
      throw new Error(
        `Retrieval relevance output ID mismatch at index ${index}: expected ${expectedIds[index]}, got ${output.results[index]?.id ?? "<missing>"}`
      )
    }
  }
  return output.results
}

function calculateNDCG(relevanceScores: number[], idealRelevant: number): number {
  const dcg = relevanceScores.reduce((sum, rel, i) => {
    return sum + rel / Math.log2(i + 2)
  }, 0)

  const idealScores = Array(relevanceScores.length).fill(0)
  for (let i = 0; i < Math.min(idealRelevant, idealScores.length); i++) {
    idealScores[i] = 1
  }
  const idcg = idealScores.reduce((sum, rel, i) => {
    return sum + rel / Math.log2(i + 2)
  }, 0)

  return idcg > 0 ? dcg / idcg : 0
}

export async function calculateRetrievalMetrics(
  runtime: EvaluationRuntime,
  question: string,
  groundTruth: string,
  searchResults: UnifiedSearchResult[],
  k: number = 10
): Promise<RetrievalMetrics> {
  const resultsToEval = searchResults.slice(0, k)

  if (resultsToEval.length === 0) {
    return {
      hitAtK: 0,
      precisionAtK: 0,
      recallAtK: 0,
      f1AtK: 0,
      mrr: 0,
      ndcg: 0,
      k: 0,
      relevantRetrieved: 0,
      totalRelevant: 1,
    }
  }

  const relevanceResults = await evaluateAllChunks(runtime, question, groundTruth, resultsToEval)
  const relevanceScores = relevanceResults.map((result) => result.relevant)

  const relevantRetrieved = relevanceScores.filter((relevance) => relevance === 1).length
  const totalRelevant = Math.max(1, relevantRetrieved)
  const hitAtK = relevantRetrieved > 0 ? 1 : 0
  const precisionAtK = relevantRetrieved / resultsToEval.length
  const recallAtK = relevantRetrieved > 0 ? 1 : 0
  const f1AtK =
    precisionAtK + recallAtK > 0 ? (2 * precisionAtK * recallAtK) / (precisionAtK + recallAtK) : 0
  const firstRelevantIndex = relevanceScores.findIndex((relevance) => relevance === 1)
  const mrr = firstRelevantIndex >= 0 ? 1 / (firstRelevantIndex + 1) : 0
  const ndcg = calculateNDCG(relevanceScores, totalRelevant)

  return {
    hitAtK,
    precisionAtK,
    recallAtK,
    f1AtK,
    mrr,
    ndcg,
    k: resultsToEval.length,
    relevantRetrieved,
    totalRelevant,
  }
}

export async function calculateProtocolRetrievalMetrics(
  policy: AuxiliaryRetrievalEvaluationPolicy,
  runtime: EvaluationRuntime,
  question: string,
  groundTruth: string,
  searchResults: UnifiedSearchResult[],
  k: number
): Promise<RetrievalMetrics | undefined> {
  switch (policy) {
    case "disabled":
      return undefined
    case "legacy-llm-relevance-v1":
      return calculateRetrievalMetrics(runtime, question, groundTruth, searchResults, k)
    default: {
      const unsupported: never = policy
      throw new Error(`Unsupported auxiliary retrieval evaluation policy: ${unsupported}`)
    }
  }
}
