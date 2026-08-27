import type {
  EvaluationArtifact,
  QueryArtifact,
  ReaderArtifact,
  RetrievalConfig,
} from "./migration"
import type { LongMemEvalV2OfficialAggregate } from "../benchmarks/longmemeval-v2/evaluation"
import type { ProviderName } from "./provider"

export type BuildAwareStage = "plan" | "build" | "query" | "read" | "evaluate" | "report"
export type BuildAwareStageStatus = "pending" | "running" | "completed" | "failed" | "blocked"

export interface StageState {
  status: BuildAwareStageStatus
  fingerprint?: string
  artifactPath?: string
  error?: string
  startedAt?: string
  completedAt?: string
  durationMs?: number
  cacheHit?: boolean
}

export interface BuildAwareQuestionCheckpoint {
  questionId: string
  questionType: string
  question: string
  groundTruth: string
  evalFunction: string
  buildId: string
  questionImageHash?: string
  stages: {
    query: StageState
    read: StageState
    evaluate: StageState
  }
  queryArtifact?: QueryArtifact
  readerArtifact?: ReaderArtifact
  evaluationArtifact?: EvaluationArtifact
}

export interface BuildAwareRunConfig {
  provider: ProviderName
  benchmark: "longmemeval-v2"
  mode: "benchmark" | "one-trajectory-canary"
  datasetPath: string
  datasetRevision: string
  tier: "small" | "medium"
  domain: "web" | "enterprise" | "all"
  questionIds?: string[]
  limit?: number
  perCategory?: number
  /** Keep the first N exact builds in pinned question order. */
  haystackLimit?: number
  seed: string
  retrieval: RetrievalConfig
  reader: {
    model: string
    reasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
    maxCompletionTokens: number
    maxContextTokens: number
    evidenceTopK: number
    maxImages: number
    maxImageBytes: number
    malformedResponseAttempts: number
  }
  evaluator: {
    model: string
    reasoningEffort: string
    maxCompletionTokens: number
  }
  build: {
    serviceBaseUrl: string
    dreaming: "instant"
    rootFilterMode: "self"
    maxDocumentChars: number
    trajectoryConcurrency: number
    maxInFlightRequests: number
    maxTrajectoryAttempts: number
    indexingTimeoutMs: number
    pollIntervalMs: number
    preflightMaxAgeMs: number
    continueOnIndexingTimeout?: boolean
  }
  execution: {
    buildConcurrency: number
    questionConcurrency: number
  }
}

export interface BuildAwareRunCheckpoint {
  schemaVersion: 1
  executionModel: "shared-memory-build-v1"
  runId: string
  configFingerprint: string
  status: BuildAwareStageStatus
  currentStage: BuildAwareStage
  config: BuildAwareRunConfig
  datasetManifestPath?: string
  datasetFingerprint?: string
  artifactRoot?: string
  buildRoot?: string
  preflightGate?: {
    schemaVersion: 1
    reportFingerprint: string
    generatedAt: string
    baseUrl: string
    testedTopK: number
  }
  targetQuestionIds: string[]
  buildIds: string[]
  buildLinks: Record<string, string>
  questions: Record<string, BuildAwareQuestionCheckpoint>
  createdAt: string
  updatedAt: string
  error?: string
}

export interface BuildAwareReport {
  schemaVersion: 1
  protocol: "longmemeval-v2-official"
  runId: string
  benchmark: "longmemeval-v2"
  provider: ProviderName
  converter: "Structured Accessibility Converter"
  targetQuestionCount: number
  completedQuestionCount: number
  failedQuestionCount: number
  officiallyComparable: boolean
  ineligibilityReasons: string[]
  buildIds: string[]
  builds: Array<{
    buildId: string
    buildFingerprint: string
    containerTag: string
    domain: string
    trajectoryCount: number
    documentCount: number
    linkedQuestionIds: string[]
    reused: boolean
    status: "ready" | "degraded"
    skippedTrajectoryCount: number
    skippedDocumentCount: number
  }>
  official: LongMemEvalV2OfficialAggregate
  diagnostics: {
    queryCacheHits: number
    readerCacheHits: number
    remoteSearchLatencyMs: number[]
    queryWallLatencyMs: number[]
    contextImagesSent: number
    failedQuestions: Array<{ questionId: string; stage: string; error: string }>
  }
  createdAt: string
}
