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

export interface RetrievalMetrics {
  hitAtK: number
  precisionAtK: number
  recallAtK: number
  f1AtK: number
  mrr: number
  ndcg: number
  k: number
  relevantRetrieved: number
  totalRelevant: number
}

export interface RetrievalAggregates {
  hitAtK: number
  precisionAtK: number
  recallAtK: number
  f1AtK: number
  mrr: number
  ndcg: number
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
  retrieval?: RetrievalAggregates
  byQuestionType: Record<string, QuestionTypeStats>
  questionTypeRegistry?: QuestionTypeRegistry
  evaluations: EvaluationResult[]
}
