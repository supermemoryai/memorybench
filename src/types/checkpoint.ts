import type { ConcurrencyConfig } from "./concurrency"
import type { BenchmarkScope, DatasetIdentity } from "./benchmark"
import type {
  IngestionExecutionPolicy,
  ProtocolIdentity,
  QuestionEvaluation,
  RetrievalPlan,
} from "./protocol"
import type { AnsweringRuntimeIdentity } from "./model"
import type {
  ProviderRequestDiagnostic,
  ProviderResultDropDiagnostic,
  RetrievalMetrics,
  UnifiedSearchResult,
} from "./unified"

export const CHECKPOINT_SCHEMA_VERSION = 4

export type PhaseStatus = "pending" | "in_progress" | "completed" | "failed"

export type PhaseId = "ingest" | "indexing" | "search" | "answer" | "evaluate" | "report"

export const PHASE_ORDER: PhaseId[] = [
  "ingest",
  "indexing",
  "search",
  "answer",
  "evaluate",
  "report",
]

export function getPhasesFromPhase(fromPhase: PhaseId): PhaseId[] {
  const startIndex = PHASE_ORDER.indexOf(fromPhase)
  if (startIndex === -1) return PHASE_ORDER
  return PHASE_ORDER.slice(startIndex)
}

export interface ProviderUsage {
  requestCount?: number
  tokenUsageCompleteRequestCount?: number
  tokenUsagePartialRequestCount?: number
  tokenUsageUnknownRequestCount?: number
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  totalTokens?: number
}

export interface BuildAttemptMetrics {
  phase: "ingest" | "indexing"
  attempt: number
  startedAt: string
  completedAt?: string
  durationMs?: number
  status: "in_progress" | "completed" | "failed"
  usage?: ProviderUsage
  costUsd: number | null
  error?: string
}

export interface HaystackIdentity {
  schemaVersion: 2
  algorithm: "sha256"
  fingerprint: string
  orderedSessionIds: string[]
  sessionFingerprints: string[]
}

export interface SessionMetadata {
  sessionId: string
  documentDate?: string
  messageCount: number
}

export interface DeferredIngestSession {
  sequence: number
  sessionId: string
  customId: string
  documentIds: string[]
  taskIds: string[]
  stage: "submission" | "readiness"
  attempts: number
  firstFailedAt: string
  lastFailedAt: string
  lastError: string
}

export interface BuildCheckpoint {
  buildId: string
  ingestionGroupId: string
  memberQuestionIds: string[]
  containerTag: string
  haystack: HaystackIdentity
  buildFingerprint: string
  providerIngestionConfigFingerprint: string
  ingestionExecutionPolicy: IngestionExecutionPolicy
  /** Number of ordered sessions submitted in one provider request before a readiness barrier. */
  ingestBatchSize?: number
  sessions: SessionMetadata[]
  missingDocumentDateCount: number
  sourceRunId?: string
  reused: boolean
  reusedPhases?: {
    ingest: boolean
    indexing: boolean
  }
  ingest: {
    status: PhaseStatus
    completedSessionIds: string[]
    documentIds: string[]
    taskIds: string[]
    /** Sessions deferred during the first pass and retried in order at build end. */
    deferredSessions?: DeferredIngestSession[]
    startedAt?: string
    completedAt?: string
    durationMs?: number
    attempts: BuildAttemptMetrics[]
    error?: string
  }
  indexing: {
    status: PhaseStatus
    completedIds: string[]
    failedIds: string[]
    startedAt?: string
    completedAt?: string
    durationMs?: number
    attempts: BuildAttemptMetrics[]
    error?: string
  }
}

export interface SearchPhaseCheckpoint {
  status: PhaseStatus
  retrievalPlan?: RetrievalPlan
  resultFile?: string
  results?: UnifiedSearchResult[]
  requestedCount?: number
  rawReturnedCount?: number
  returnedCount?: number
  normalizedCount?: number
  droppedCount?: number
  droppedResults?: ProviderResultDropDiagnostic[]
  providerRequests?: ProviderRequestDiagnostic[]
  answerCutoff?: number
  answerEvidenceCount?: number
  startedAt?: string
  completedAt?: string
  durationMs?: number
  usage?: ProviderUsage
  costUsd?: number | null
  error?: string
}

export interface AnswerAttemptMetrics {
  attempt: number
  startedAt: string
  completedAt?: string
  durationMs?: number
  status: "in_progress" | "completed" | "failed"
  finishReason?: string
  reasoningTokens?: number
  usage?: ProviderUsage
  error?: string
}

export interface AnswerPhaseCheckpoint {
  status: PhaseStatus
  hypothesis?: string
  /** True only when a benchmark explicitly accepts terminal all-empty model output. */
  terminalEmptyAccepted?: boolean
  promptTokens?: number
  basePromptTokens?: number
  contextTokens?: number
  evidenceCount?: number
  startedAt?: string
  completedAt?: string
  durationMs?: number
  /** Durable outer attempts, including empty-output and transport retries. */
  attempts?: AnswerAttemptMetrics[]
  usage?: ProviderUsage
  costUsd?: number | null
  error?: string
}

export interface EvaluatePhaseCheckpoint {
  status: PhaseStatus
  /** Benchmark-owned durable state for multi-call evaluators. */
  protocolProgress?: Record<string, unknown>
  evaluation?: QuestionEvaluation
  /** Compatibility mirrors for existing UI/readers. */
  label?: "correct" | "incorrect"
  score?: number
  explanation?: string
  retrievalMetrics?: RetrievalMetrics
  details?: Record<string, unknown>
  startedAt?: string
  completedAt?: string
  durationMs?: number
  usage?: ProviderUsage
  costUsd?: number | null
  error?: string
}

export interface QuestionCheckpoint {
  questionId: string
  buildId: string
  question: string
  groundTruth: string
  questionType: string
  questionDate?: string
  phases: {
    search: SearchPhaseCheckpoint
    answer: AnswerPhaseCheckpoint
    evaluate: EvaluatePhaseCheckpoint
  }
}

export type RunStatus = "initializing" | "running" | "completed" | "failed"

export type SelectionMode = "full" | "sample" | "limit"
export type SampleType = "consecutive" | "random"

export interface SamplingConfig {
  mode: SelectionMode
  sampleType?: SampleType
  perCategory?: number
  limit?: number
}

export interface BuildPhaseAttempt {
  startedAt: string
  completedAt?: string
  durationMs?: number
  status: "in_progress" | "completed" | "failed"
}

export interface RunCheckpoint {
  schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION
  runId: string
  dataSourceRunId: string
  status: RunStatus
  provider: string
  providerAdapterVersion: string
  providerPromptFingerprint: string
  benchmark: string
  benchmarkScope: BenchmarkScope
  datasetIdentity?: DatasetIdentity
  benchmarkInputFingerprint: string
  selectedQuestionIdsDigest: string
  protocolIdentity: ProtocolIdentity
  judge: string
  answeringModel: string
  answeringRuntimeIdentity: AnsweringRuntimeIdentity
  createdAt: string
  updatedAt: string
  dataPath?: string
  datasetRevision?: string
  retrievalTopK: number
  /** Explicit non-default benchmark evaluation profile, when selected. */
  evaluationProfile?: string
  /** Maximum retrieved results exposed to the answering model. */
  answerCutoff?: number
  limit?: number
  sampling?: SamplingConfig
  targetQuestionIds?: string[]
  concurrency?: ConcurrencyConfig
  /** Defaults to 1 for checkpoints created before ordered batch ingestion. */
  ingestBatchSize?: number
  /** Operational per-readiness-call deadline; defaults to five minutes. */
  ingestReadinessTimeoutMs?: number
  buildPhaseAttempts: BuildPhaseAttempt[]
  builds: Record<string, BuildCheckpoint>
  questions: Record<string, QuestionCheckpoint>
}
