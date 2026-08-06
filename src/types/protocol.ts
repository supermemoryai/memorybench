import type { z } from "zod"
import type { JudgeInput, JudgeResult } from "./judge"
import type { ProviderPrompts } from "./prompts"
import type {
  CanonicalIngestionDocument,
  UnifiedQuestion,
  UnifiedSearchResult,
  UnifiedSession,
} from "./unified"

export interface ProtocolIdentity {
  id: string
  version: string
  configFingerprint: string
  implementationFingerprint: string
  /**
   * Fingerprint of only the protocol policy and implementation that produce
   * canonical ingestion documents. Build reuse must depend on this value, not
   * retrieval, answer, evaluator, or aggregation identity.
   */
  ingestionPolicyHash: string
  retrievalPolicyHash: string
  answerPromptHash: string
  evaluatorHash: string
  aggregationHash: string
  /** Auditable pinned profile data whose hashes are recorded above. */
  details?: Record<string, unknown>
}

export interface RetrievalPlan {
  query: string
  requestedTopK: number
  answerCutoff: number
  threshold?: number
  searchMode?: string
  filters?: Record<string, unknown>
}

export type ModelTransport = "provider-default" | "openai-chat-completions"
export type TerminalEmptyOutputPolicy = "fail" | "accept-and-evaluate"

export interface ModelRequest {
  system?: string
  prompt: string
  maxOutputTokens?: number
  temperature?: number
  /** Explicit transport when a reference runner does not use the provider default. */
  transport?: ModelTransport
  /** Protocol-owned outer attempts, including retries of empty model output. */
  maxAttempts?: number
  /** SDK-level retries inside each outer attempt. */
  innerMaxRetries?: number
  /** Deadline for each outer attempt. */
  timeoutMs?: number
  /** Linear backoff base: attempt N waits N * retryBackoffMs before N+1. */
  retryBackoffMs?: number
  /** Benchmark-owned behavior after outer attempts exhaust without non-empty text. */
  terminalEmptyOutputPolicy?: TerminalEmptyOutputPolicy
}

export interface AnswerPlan {
  request: ModelRequest
  baseRequest: ModelRequest
  answerEvidenceCount: number
}

export interface QuestionEvaluation {
  questionId: string
  questionType: string
  primaryScore: number
  passed: boolean
  label?: string
  explanation: string
  metrics?: Record<string, number>
  details?: Record<string, unknown>
}

export interface BenchmarkQualityReport {
  /** Absent when a combined scope has multiple official metrics and no official scalar score. */
  primaryMetric?: {
    key: string
    value: number
    higherIsBetter: boolean
  }
  metrics: Record<string, number>
  bySlice?: Record<string, Record<string, number>>
}

export interface StructuredModelRequest<T> extends ModelRequest {
  schema: z.ZodType<T>
  schemaName: string
  maxAttempts?: number
  timeoutMs?: number
}

export interface EvaluationRuntime {
  evaluateLegacy(input: JudgeInput): Promise<JudgeResult>
  generateStructured<T>(request: StructuredModelRequest<T>): Promise<T>
  getUsage?(): ModelUsage | undefined
}

export interface ModelUsage {
  /** Number of model requests attempted, including failed paid attempts. */
  requestCount?: number
  tokenUsageCompleteRequestCount?: number
  tokenUsagePartialRequestCount?: number
  tokenUsageUnknownRequestCount?: number
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  totalTokens?: number
}

/**
 * Optional LLM relevance diagnostics are not part of every benchmark's
 * protocol. The benchmark must explicitly own whether they run.
 */
export type AuxiliaryRetrievalEvaluationPolicy = "disabled" | "legacy-llm-relevance-v1"

/**
 * Benchmark-owned build semantics. A causal benchmark can require each
 * document to be fully ready before the next ordered document is submitted;
 * independent builds may still execute concurrently.
 */
export interface IngestionExecutionPolicy {
  readinessBarrier: "after-build" | "after-each-document"
  processingMode: "provider-default" | "instant"
}

export interface BenchmarkProtocol {
  identity: ProtocolIdentity
  auxiliaryRetrievalEvaluation: AuxiliaryRetrievalEvaluationPolicy
  ingestionExecutionPolicy: IngestionExecutionPolicy
  requiredJudge?: {
    provider: string
    modelId: string
    modelAlias: string
  }

  validateQuestion(question: UnifiedQuestion): void

  createIngestionPlan(input: {
    question: UnifiedQuestion
    sessions: UnifiedSession[]
  }): CanonicalIngestionDocument[]

  createRetrievalPlan(input: { question: UnifiedQuestion }): RetrievalPlan

  createAnswerPlan(input: {
    question: UnifiedQuestion
    sessions: UnifiedSession[]
    results: UnifiedSearchResult[]
    retrieval: RetrievalPlan
    questionDate?: string
    providerPrompts?: ProviderPrompts
  }): AnswerPlan

  evaluateQuestion(
    input: {
      question: UnifiedQuestion
      hypothesis: string
      results: UnifiedSearchResult[]
      retrieval: RetrievalPlan
      providerPrompts?: ProviderPrompts
      protocolProgress?: Record<string, unknown>
      onProtocolProgress?: (progress: Record<string, unknown>) => Promise<void>
    },
    runtime: EvaluationRuntime
  ): Promise<QuestionEvaluation>

  aggregateQuality(input: {
    questions: UnifiedQuestion[]
    evaluations: QuestionEvaluation[]
  }): BenchmarkQualityReport
}
