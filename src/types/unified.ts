export interface QuestionTypeInfo {
  id: string
  alias: string
  description: string
}

export type QuestionTypeRegistry = Record<string, QuestionTypeInfo>

export interface UnifiedMessage {
  role: "user" | "assistant"
  content: string
  timestamp?: string
  speaker?: string
}

export interface UnifiedSession {
  sessionId: string
  messages: UnifiedMessage[]
  metadata?: Record<string, unknown>
}

export interface UnifiedQuestion {
  questionId: string
  question: string
  questionType: string
  groundTruth: string
  haystackSessionIds: string[]
  metadata?: Record<string, unknown>
}

export type SearchResult = unknown

/**
 * Retrieval quality over the results a provider returned for one question.
 *
 * Deliberately limited to metrics that are well defined without knowing how many relevant
 * memories exist in the corpus. Recall@K, F1@K and NDCG were previously reported here, but
 * with no ground-truth denominator they were computed against the retrieved set itself: recall
 * reduced to exactly hitAtK, F1 to a re-encoding of precision, and NDCG's ideal ranking was
 * built from what the provider happened to find, so it could never register a miss. See the
 * issue trail on #67 before adding them back — they need per-question relevance labels first.
 */
export interface RetrievalMetrics {
  hitAtK: number
  precisionAtK: number
  mrr: number
  k: number
  relevantRetrieved: number
}

export interface RetrievalAggregates {
  hitAtK: number
  precisionAtK: number
  mrr: number
  k: number
}

export interface EvaluationResult {
  questionId: string
  questionType: string
  question: string
  score: number
  label: "correct" | "incorrect"
  explanation: string
  hypothesis: string
  groundTruth: string
  searchResults: SearchResult[]
  searchDurationMs: number
  answerDurationMs: number
  totalDurationMs: number
  retrievalMetrics?: RetrievalMetrics
}

export interface LatencyStats {
  min: number
  max: number
  mean: number
  median: number
  p95: number
  p99: number
  stdDev: number
  count: number
}

export interface QuestionTypeStats {
  total: number
  correct: number
  accuracy: number
  latency: {
    search: LatencyStats
    answer: LatencyStats
    total: LatencyStats
  }
  retrieval?: RetrievalAggregates
}

export interface TokenMetrics {
  totalTokens: number
  basePromptTokens: number
  contextTokens: number
  avgTokensPerQuestion: number
  avgBasePromptTokens: number
  avgContextTokens: number
}

export interface BenchmarkResult {
  provider: string
  benchmark: string
  runId: string
  dataSourceRunId: string
  judge: string
  answeringModel: string
  timestamp: string
  summary: {
    totalQuestions: number
    correctCount: number
    accuracy: number
  }
  latency: {
    ingest: LatencyStats
    indexing: LatencyStats
    search: LatencyStats
    answer: LatencyStats
    evaluate: LatencyStats
    total: LatencyStats
  }
  tokens?: TokenMetrics
  memscore?: string
  memscoreComponents?: { quality: number; latencyMs: number; contextTokens: number }
  retrieval?: RetrievalAggregates
  byQuestionType: Record<string, QuestionTypeStats>
  questionTypeRegistry?: QuestionTypeRegistry
  evaluations: EvaluationResult[]
}
