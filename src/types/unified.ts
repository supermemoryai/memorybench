import type { AnsweringRuntimeIdentity } from "./model"
import type { ProviderName } from "./provider"

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

export interface CanonicalIngestionDocument {
  customId: string
  content: string
  metadata: {
    sessionId: string
    documentDate?: string
    [key: string]: unknown
  }
  /** Provider-neutral source messages for adapters that ingest chat messages. */
  messages?: UnifiedMessage[]
}

export interface UnifiedQuestion {
  questionId: string
  question: string
  questionType: string
  groundTruth: string
  haystackSessionIds: string[]
  metadata?: Record<string, unknown>
}

export const UNIFIED_SEARCH_RESULT_TYPES = [
  "memory",
  "chunk",
  "graph-edge",
  "graph-node",
  "document",
] as const

export type UnifiedSearchResultType = (typeof UNIFIED_SEARCH_RESULT_TYPES)[number]

export interface UnifiedSearchResult {
  id: string
  rank: number
  text: string
  score?: number
  sessionId?: string
  documentDate?: string
  provider: ProviderName
  resultType: UnifiedSearchResultType
  /** Optional pointer to a separately stored raw artifact; never prompt content. */
  rawArtifactRef?: string
}

export interface ProviderRequestDiagnostic {
  operation: string
  limit: number
  parameters?: Record<string, unknown>
}

export interface ProviderResultDropDiagnostic {
  index: number
  reason:
    | "malformed-result"
    | "missing-id"
    | "empty-text"
    | "unsupported-result-type"
    | "below-threshold"
}

export type SearchResult = UnifiedSearchResult

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
  primaryScore: number
  passed: boolean
  label: "correct" | "incorrect"
  explanation: string
  metrics?: Record<string, number>
  hypothesis: string
  groundTruth: string
  searchResults: SearchResult[]
  searchDurationMs: number
  answerDurationMs: number
  totalDurationMs: number
  retrievalMetrics?: RetrievalMetrics
  details?: Record<string, unknown>
}

export interface UsageMetrics {
  requestCount?: number
  tokenUsageCompleteRequestCount?: number
  tokenUsagePartialRequestCount?: number
  tokenUsageUnknownRequestCount?: number
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  totalTokens?: number
}

export interface BuildAttemptReport {
  phase: "ingest" | "indexing"
  attempt: number
  startedAt: string
  completedAt?: string
  durationMs?: number
  status: "in_progress" | "completed" | "failed"
  usage?: UsageMetrics
  costUsd: number | null
  error?: string
}

export interface BuildMetrics {
  buildId: string
  containerTag: string
  providerIngestionConfigFingerprint: string
  sourceRunId?: string
  reused: boolean
  reusedPhases?: {
    ingest: boolean
    indexing: boolean
  }
  ingestLatencyMs: number
  indexingLatencyMs: number
  buildWallClockMs: number
  buildWorkMs: number
  attemptCount: number
  attempts: BuildAttemptReport[]
  usage?: UsageMetrics
  costUsd: number | null
  sessionCount: number
  documentCount: number
  taskCount: number
  completedIndexingCount: number
  failedIndexingCount: number
}

export interface QuestionMetrics {
  questionId: string
  buildId: string
  searchLatencyMs: number
  answerLatencyMs: number
  onlineQueryLatencyMs: number
  evaluationLatencyMs: number
  queryUsage?: UsageMetrics
  evaluationUsage?: UsageMetrics
  queryCostUsd: number | null
  evaluationCostUsd: number | null
  configuredTopK: number
  providerRequestLimit: number
  rawReturnedCount: number
  returnedCount: number
  normalizedCount: number
  droppedCount: number
  answerCutoff: number
  answerEvidenceCount: number
  contextTokens: number
  searchMode?: string
  threshold?: number
  providerRequests: ProviderRequestDiagnostic[]
  droppedResults: ProviderResultDropDiagnostic[]
  /** Completed questions sharing this build-work allocation. */
  buildAllocationQuestionCount: number
  allocatedBuildWorkMs?: number
  amortizedOnlinePlusBuildWorkMs?: number
}

export interface CostCoverageMetrics {
  /** Null unless every relevant question has a known cost. */
  totalCostUsd: number | null
  knownCostCount: number
  totalCostCount: number
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
  providerPromptFingerprint: string
  benchmark: string
  runId: string
  dataSourceRunId: string
  judge: string
  answeringModel: string
  answeringRuntimeIdentity: AnsweringRuntimeIdentity
  timestamp: string
  selectedQuestionIdsDigest: string
  retrievalTopK: number
  benchmarkScope: {
    displayName: string
    includedTiers: string[]
    coverage: "full" | "subset"
  }
  datasetIdentity?: Record<string, unknown>
  benchmarkInputFingerprint: string
  protocolIdentity: Record<string, unknown>
  quality: {
    primaryMetric?: { key: string; value: number; higherIsBetter: boolean }
    metrics: Record<string, number>
    bySlice?: Record<string, Record<string, number>>
  }
  summary: {
    totalQuestions: number
    correctCount: number
    accuracy: number
    averageScore: number
  }
  builds: {
    uniqueBuildCount: number
    sumContainerBuildWorkMs: number
    buildPhaseWallClockMs: number
    totalBuildCostUsd: number | null
    knownCostBuildCount: number
    totalCostBuildCount: number
    items: BuildMetrics[]
  }
  costs: {
    query: CostCoverageMetrics
    evaluation: CostCoverageMetrics
  }
  questionMetrics: QuestionMetrics[]
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
