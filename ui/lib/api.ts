const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"

export interface RunSummary {
  runId: string
  provider: string
  benchmark: string
  judge: string
  answeringModel: string
  createdAt: string
  updatedAt: string
  status:
    | "initializing"
    | "pending"
    | "running"
    | "stopping"
    | "completed"
    | "partial"
    | "failed"
    | "blocked"
  summary: {
    total: number
    ingested: number
    indexed: number
    searched: number
    answered: number
    evaluated: number
    indexingEpisodes?: {
      total: number
      completed: number
      failed: number
    }
  }
  accuracy: number | null
  readOnlyInspection?: boolean
}

export interface QuestionCheckpoint {
  questionId: string
  containerTag: string
  question: string
  groundTruth: string
  questionType: string
  phases: {
    ingest: { status: string; completedSessions: string[] }
    indexing: { status: string }
    search: { status: string; results?: any[] }
    answer: {
      status: string
      hypothesis?: string
      promptTokens?: number
      basePromptTokens?: number
      contextTokens?: number
    }
    evaluate: { status: string; score?: number; label?: string; explanation?: string }
  }
}

export interface RunDetail extends RunSummary {
  questions: Record<string, QuestionCheckpoint>
}

export interface BuildAwareStageState {
  status: "pending" | "running" | "completed" | "partial" | "failed" | "blocked"
  fingerprint?: string
  artifactPath?: string
  error?: string
  startedAt?: string
  completedAt?: string
  durationMs?: number
  cacheHit?: boolean
}

export interface BuildAwareAssetRef {
  assetId: string
  kind: "question-image" | "trajectory-screenshot"
  sha256: string
  mimeType: string
  byteLength: number
  relativePath: string
  width?: number
  height?: number
}

export interface BuildAwareRetrievalResult {
  rank: number
  score?: number
  kind: string
  text: string
  summary?: string
  chunks: string[]
  providerResultId?: string
  documentIds: string[]
  trajectoryId?: string
  stateIndex?: number
  screenshotRefs: BuildAwareAssetRef[]
  provenanceValid: boolean
}

export interface BuildAwareQueryArtifact {
  questionId: string
  buildId: string
  buildFingerprint: string
  queryFingerprint: string
  query: string
  config: {
    topK: number
    threshold: number
    searchMode: string
    rerank: boolean
    rewriteQuery: boolean
    includeSummaries: boolean
    includeChunks: boolean
    includeDocuments: boolean
    includeRelatedMemories: boolean
    metadataFilter: Record<string, unknown>
  }
  request: Record<string, unknown>
  rawArtifact: ArtifactProvenance
  normalizedArtifact: ArtifactProvenance
  normalizedResults: BuildAwareRetrievalResult[]
  remoteDurationMs: number
  wallDurationMs: number
  cacheHit: boolean
  createdAt: string
}

export interface BuildAwareReaderArtifact {
  questionId: string
  readerFingerprint: string
  model: string
  reasoningEffort?: string
  systemPrompt: string
  parts: Array<
    | { type: "text"; text: string; provenance?: Record<string, unknown> }
    | {
        type: "image"
        asset: BuildAwareAssetRef
        caption?: string
        provenance?: Record<string, unknown>
      }
  >
  sentAssetIds: string[]
  omittedItems: number
  responseText: string
  parsedAnswer: string
  rawAttempts?: unknown[]
  usage?: Record<string, number>
  durationMs: number
  cacheHit: boolean
  createdAt: string
}

export interface BuildAwareEvaluationArtifact {
  questionId: string
  evaluatorFingerprint: string
  evalFunction: string
  answer: string
  groundTruth: string
  score: 0 | 1
  label: "correct" | "incorrect"
  evaluatorModel?: string
  promptVersion: string
  implementationVersion: string
  request?: Record<string, unknown>
  rawResponse?: unknown
  rationale?: string
  error?: string
  durationMs: number
  createdAt: string
}

export interface ArtifactProvenance {
  relativePath: string
  sha256?: string
  byteLength?: number
}

export interface BuildAwareArtifactLink {
  available: boolean
  href: string
  provenance: ArtifactProvenance | { source: "checkpoint" }
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
    query: BuildAwareStageState
    read: BuildAwareStageState
    evaluate: BuildAwareStageState
  }
  queryArtifact?: BuildAwareQueryArtifact
  readerArtifact?: BuildAwareReaderArtifact
  evaluationArtifact?: BuildAwareEvaluationArtifact
}

export interface BuildInspectionSummary {
  buildId: string
  buildFingerprint?: string
  questionCount: number
  questionIds: string[]
  questionLinkMismatches: string[]
  reused: boolean
  reuseCount: number
  priorBuildReuse?: boolean
  containerTag?: string
  domain?: string
  trajectoryCount?: number
  documentCount?: number
  checkpointLink: {
    status: "available" | "missing" | "rejected"
    scope?: "run" | "builds"
    relativePath?: string
    reason?: string
  }
  stateStore: {
    available: boolean
    buildFound?: boolean
    buildFingerprint?: string
    containerTag?: string
    provider?: string
    status?: string
    error?: string
    trajectories?: Record<string, number>
    documents?: Record<string, number>
    reason?: string
  }
}

export interface BuildAwareReport {
  protocol: "longmemeval-v2-official"
  provider: LongMemEvalV2ProviderName
  targetQuestionCount: number
  completedQuestionCount: number
  failedQuestionCount: number
  officiallyComparable?: boolean
  ineligibilityReasons?: string[]
  builds: Array<{
    buildId: string
    buildFingerprint: string
    containerTag: string
    domain: string
    trajectoryCount: number
    documentCount: number
    linkedQuestionIds: string[]
    reused: boolean
    status?: "ready" | "degraded"
    skippedTrajectoryCount?: number
    skippedDocumentCount?: number
  }>
  official: {
    overall: {
      overall_full_set: number
      overall_non_abstention_only: number | null
      overall_abstention_only: number | null
      count_all_questions: number
      count_non_abstention: number
      count_abstention: number
    }
    non_abstention_by_category: Record<
      string,
      {
        count: number
        pct_correct: number | null
        pct_answered_wrong: number | null
        pct_unknown: number | null
        count_failed_or_incomplete: number
      }
    >
    abstention_by_category: Record<string, unknown>
    combined_abstention_by_category: Record<string, unknown>
    abstention_overall: Record<string, unknown>
    execution: Record<string, number>
  }
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

export interface BuildAwareRunDetail {
  executionModel: "shared-memory-build-v1"
  runId: string
  configFingerprint: string
  status: "pending" | "running" | "completed" | "failed" | "blocked"
  currentStage: "plan" | "build" | "query" | "read" | "evaluate" | "report"
  config: {
    provider: LongMemEvalV2ProviderName
    benchmark: "longmemeval-v2"
    mode: "benchmark" | "one-trajectory-canary"
    datasetRevision: string
    tier: string
    domain: string
    questionIds?: string[]
    limit?: number
    perCategory?: number
    haystackLimit?: number
    retrieval: BuildAwareQueryArtifact["config"]
    reader: {
      model: string
      reasoningEffort: string
      evidenceTopK: number
      maxImages: number
      maxImageBytes: number
    }
    evaluator: {
      model: string
      reasoningEffort: string
    }
    execution: {
      buildConcurrency: number
      questionConcurrency: number
    }
    build: {
      trajectoryConcurrency: number
      maxInFlightRequests: number
      maxTrajectoryAttempts: number
      indexingTimeoutMs: number
      continueOnIndexingTimeout?: boolean
    }
  }
  datasetFingerprint?: string
  preflightGate?: {
    schemaVersion: 1
    reportFingerprint: string
    generatedAt: string
    baseUrl: string
    testedTopK: number
  }
  targetQuestionIds: string[]
  buildIds: string[]
  questions?: Record<string, BuildAwareQuestionCheckpoint>
  createdAt: string
  updatedAt: string
  error?: string
  questionBuildLinks: Record<string, string>
  storageRoots: {
    artifacts: "available" | "missing" | "rejected"
    builds: "available" | "missing" | "rejected"
  }
  summary: {
    total: number
    query: { completed: number; failed: number; cacheHits: number }
    read: { completed: number; failed: number; cacheHits: number }
    evaluate: { completed: number; failed: number; blocked: number }
  }
  inspection: {
    builds: BuildInspectionSummary[]
    reportAvailable: boolean
    metricNamespaces: {
      official: BuildAwareReport["official"] | null
      diagnostics: BuildAwareReport["diagnostics"] | null
    }
  }
}

export interface BuildAwareQuestionSummary {
  questionId: string
  questionType: string
  question: string
  buildId: string
  stages: {
    query: { status: BuildAwareStageState["status"] }
    read: { status: BuildAwareStageState["status"] }
    evaluate: { status: BuildAwareStageState["status"] }
  }
  evaluationArtifact?: {
    score: 0 | 1
    label: "correct" | "incorrect"
  }
}

export interface BuildAwareQuestionDetail extends BuildAwareQuestionCheckpoint {
  buildReuseCount: number
  buildLinkMatchesCheckpoint: boolean
  buildFingerprint?: string
  artifactLinks: Record<
    "query-raw" | "query-normalized" | "reader" | "evaluation",
    BuildAwareArtifactLink
  >
  metricNamespace: {
    evaluation: "longmemeval-v2-official"
    retrievalAndLatency: "memorybench-diagnostics"
  }
}

export interface BuildAwareArtifactResponse {
  kind: "query-raw" | "query-normalized" | "reader" | "evaluation"
  data: unknown
  provenance:
    | (ArtifactProvenance & { integrity: "verified" | "computed" })
    | { source: "checkpoint"; integrity: "embedded" }
}

export function isBuildAwareRunDetail(
  run: RunDetail | BuildAwareRunDetail
): run is BuildAwareRunDetail {
  return "executionModel" in run && run.executionModel === "shared-memory-build-v1"
}

export function isBuildAwareQuestionDetail(
  question: (QuestionCheckpoint & { searchResultsFile?: any }) | BuildAwareQuestionDetail
): question is BuildAwareQuestionDetail {
  return "stages" in question && "buildId" in question
}

export interface Provider {
  name: string
  displayName: string
  concurrency: ConcurrencyConfig | null
}

export interface Benchmark {
  name: string
  displayName: string
  description: string
}

export interface QuestionTypeInfo {
  id: string
  alias: string
  description: string
}

export type QuestionTypeRegistry = Record<string, QuestionTypeInfo>

export interface PaginatedResponse<T> {
  questions: T[]
  questionTypes?: string[]
  questionTypeRegistry?: QuestionTypeRegistry
  pagination: {
    page: number
    limit: number
    total: number
    totalPages: number
  }
}

// Fetch wrapper with error handling
async function fetchApi<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  })

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: "Request failed" }))
    throw new Error(error.error || "Request failed")
  }

  return res.json()
}

// Runs
export async function getRuns(): Promise<RunSummary[]> {
  return fetchApi("/api/runs")
}

export async function getRun(runId: string): Promise<RunDetail | BuildAwareRunDetail> {
  return fetchApi(`/api/runs/${encodeURIComponent(runId)}?compact=true`)
}

export async function getRunReport(runId: string): Promise<any> {
  return fetchApi(`/api/runs/${encodeURIComponent(runId)}/report`)
}

export async function getRunQuestions(
  runId: string,
  params?: { page?: number; limit?: number; status?: string; type?: string }
): Promise<PaginatedResponse<QuestionCheckpoint>> {
  const searchParams = new URLSearchParams()
  if (params?.page) searchParams.set("page", params.page.toString())
  if (params?.limit) searchParams.set("limit", params.limit.toString())
  if (params?.status) searchParams.set("status", params.status)
  if (params?.type) searchParams.set("type", params.type)

  const query = searchParams.toString()
  return fetchApi(`/api/runs/${encodeURIComponent(runId)}/questions${query ? `?${query}` : ""}`)
}

export async function getBuildAwareRunQuestions(
  runId: string,
  params?: { page?: number; limit?: number; status?: string; type?: string }
): Promise<PaginatedResponse<BuildAwareQuestionSummary>> {
  const searchParams = new URLSearchParams()
  if (params?.page) searchParams.set("page", params.page.toString())
  if (params?.limit) searchParams.set("limit", params.limit.toString())
  if (params?.status) searchParams.set("status", params.status)
  if (params?.type) searchParams.set("type", params.type)
  const query = searchParams.toString()
  return fetchApi(`/api/runs/${encodeURIComponent(runId)}/questions${query ? `?${query}` : ""}`)
}

export async function getQuestion(
  runId: string,
  questionId: string
): Promise<(QuestionCheckpoint & { searchResultsFile?: any }) | BuildAwareQuestionDetail> {
  return fetchApi(
    `/api/runs/${encodeURIComponent(runId)}/questions/${encodeURIComponent(questionId)}`
  )
}

export async function getBuildAwareArtifact(
  runId: string,
  questionId: string,
  kind: BuildAwareArtifactResponse["kind"]
): Promise<BuildAwareArtifactResponse> {
  return fetchApi(
    `/api/runs/${encodeURIComponent(runId)}/questions/${encodeURIComponent(
      questionId
    )}/artifacts/${kind}`
  )
}

export function getBuildAwareAssetUrl(runId: string, questionId: string, assetId: string): string {
  return `${API_BASE}/api/runs/${encodeURIComponent(runId)}/questions/${encodeURIComponent(
    questionId
  )}/assets/${encodeURIComponent(assetId)}`
}

export async function deleteRun(runId: string): Promise<void> {
  await fetchApi(`/api/runs/${encodeURIComponent(runId)}`, { method: "DELETE" })
}

export async function stopRun(runId: string): Promise<{ message: string }> {
  return fetchApi(`/api/runs/${encodeURIComponent(runId)}/stop`, { method: "POST" })
}

export type LongMemEvalV2Tier = "small" | "medium"
export type LongMemEvalV2Domain = "web" | "enterprise" | "all"
export type LongMemEvalV2Mode = "benchmark" | "one-trajectory-canary"
export type LongMemEvalV2RunThrough = "plan" | "build" | "query" | "evaluate" | "run"
export type LongMemEvalV2ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
export type LongMemEvalV2ProviderName = "supermemory" | "filesystem" | "rag" | "mem0" | "zep"

export interface StartLongMemEvalV2RunParams {
  runId: string
  provider: LongMemEvalV2ProviderName
  datasetPath: string
  tier: LongMemEvalV2Tier
  allowMedium: boolean
  domain: LongMemEvalV2Domain
  questionIds?: string[]
  haystackLimit?: number
  mode: LongMemEvalV2Mode
  topK: number
  evidenceTopK: number
  readerModel: string
  evaluatorModel: string
  reasoningEffort: LongMemEvalV2ReasoningEffort
  evaluatorReasoningEffort: LongMemEvalV2ReasoningEffort
  buildConcurrency: number
  questionConcurrency: number
  trajectoryConcurrency: number
  maxInFlightRequests: number
  indexingTimeoutMs: number
  maxTrajectoryAttempts: number
  strictIngestion: boolean
  runThrough: LongMemEvalV2RunThrough
  allowFullRun: boolean
  forceBuild?: boolean
  freshQuery?: boolean
}

export interface ResumeLongMemEvalV2RunParams {
  runThrough?: BuildAwareRunDetail["currentStage"] | "run"
  forceBuild?: boolean
  freshQuery?: boolean
  allowFullRun?: boolean
}

export interface LongMemEvalV2RunControlResponse {
  message: string
  runId: string
  statusUrl?: string
  runUrl?: string
}

export interface LongMemEvalV2RunStatusResponse {
  runId: string
  active: boolean
  stopping: boolean
  checkpoint: {
    status: BuildAwareRunDetail["status"] | "partial"
    currentStage: BuildAwareRunDetail["currentStage"]
    updatedAt: string
    error?: string
  } | null
  control?: {
    schemaVersion: 1
    runId: string
    events: Array<{
      action: string
      at: string
      through?: BuildAwareRunDetail["currentStage"] | "run"
      message?: string
      provider?: LongMemEvalV2ProviderName
      forceBuild?: boolean
      freshQuery?: boolean
    }>
  }
}

export interface LongMemEvalV2OptionsResponse {
  defaults: {
    provider: "supermemory"
    datasetPath: string | null
    tier: "small"
    domain: "all"
    mode: "benchmark"
    topK: 20
    evidenceTopK: 20
    reasoningEffort: "high"
    readerModel: "gpt-5"
    evaluatorModel: "gpt-5"
    buildConcurrency: 2
    questionConcurrency: 5
    trajectoryConcurrency: 4
    maxInFlightRequests: 20
    maxTrajectoryAttempts: 4
    indexingTimeoutMs: 1_800_000
    strictIngestion: false
    runThrough: "plan"
  }
  haystacks: {
    small: {
      all: 2
      web: 1
      enterprise: 1
      trajectoriesPerBuild: 100
    }
    medium: {
      all: 447
      web: 236
      enterprise: 211
    }
  }
  datasets: Array<{
    path: string
    source: "env" | "repo" | "sibling"
    exists: boolean
    pinnedMarker: boolean
    coreFiles: boolean
    screenshots: boolean
    prepared: boolean
  }>
  credentials: {
    supermemoryConfigured: boolean
    openAIConfigured: boolean
    mem0Configured: boolean
    zepConfigured: boolean
  }
  providers: Array<{
    name: LongMemEvalV2ProviderName
    displayName: string
    adapterAvailable: boolean
    configured: boolean
    requiresPreflight: boolean
    searchMode: "hybrid" | "memories"
    rerank: boolean
    note: string
    capabilities: {
      plan: true
      build: boolean
      query: boolean
      read: boolean
      evaluate: boolean
      report: boolean
    }
  }>
  preflight: {
    status: "passing" | "missing" | "invalid" | "expired"
    baseUrl: string
    generatedAt?: string
    expiresAt?: string
    testedTopK?: number
    blockers?: string[]
  }
  preflightActivity:
    | { status: "idle" }
    | { status: "running"; startedAt: string; topK: number }
    | { status: "passed"; startedAt: string; completedAt: string; topK: number }
    | {
        status: "failed"
        startedAt: string
        completedAt: string
        topK: number
        error: string
      }
  capabilities: {
    plan: true
    build: boolean
    query: boolean
    read: boolean
    evaluate: boolean
    report: boolean
  }
}

export async function startLongMemEvalV2Run(
  params: StartLongMemEvalV2RunParams
): Promise<LongMemEvalV2RunControlResponse> {
  return fetchApi("/api/runs-v2/start", {
    method: "POST",
    body: JSON.stringify(params),
  })
}

export async function startLongMemEvalV2Preflight(
  topK: number
): Promise<{ message: string; statusUrl: string }> {
  return fetchApi("/api/runs-v2/preflight", {
    method: "POST",
    body: JSON.stringify({ topK }),
  })
}

export async function resumeLongMemEvalV2Run(
  runId: string,
  params: ResumeLongMemEvalV2RunParams = {}
): Promise<LongMemEvalV2RunControlResponse> {
  return fetchApi(`/api/runs-v2/${encodeURIComponent(runId)}/resume`, {
    method: "POST",
    body: JSON.stringify(params),
  })
}

export async function stopLongMemEvalV2Run(
  runId: string
): Promise<LongMemEvalV2RunControlResponse> {
  return fetchApi(`/api/runs-v2/${encodeURIComponent(runId)}/stop`, { method: "POST" })
}

export async function getLongMemEvalV2RunStatus(
  runId: string
): Promise<LongMemEvalV2RunStatusResponse> {
  return fetchApi(`/api/runs-v2/${encodeURIComponent(runId)}/status`)
}

export async function getLongMemEvalV2Options(): Promise<LongMemEvalV2OptionsResponse> {
  return fetchApi("/api/runs-v2/options")
}

export type PhaseId = "ingest" | "indexing" | "search" | "answer" | "evaluate" | "report"

export const PHASE_ORDER: PhaseId[] = [
  "ingest",
  "indexing",
  "search",
  "answer",
  "evaluate",
  "report",
]

export type SelectionMode = "full" | "sample" | "limit"
export type SampleType = "consecutive" | "random"

export interface SamplingConfig {
  mode: SelectionMode
  sampleType?: SampleType
  perCategory?: number
  limit?: number
}

export interface ConcurrencyConfig {
  default?: number
  ingest?: number
  indexing?: number
  search?: number
  answer?: number
  evaluate?: number
}

export async function startRun(params: {
  provider: string
  benchmark: string
  runId: string
  judgeModel: string
  answeringModel?: string
  limit?: number
  sampling?: SamplingConfig
  concurrency?: ConcurrencyConfig
  force?: boolean
  fromPhase?: PhaseId
  sourceRunId?: string
}): Promise<{ message: string; runId: string }> {
  return fetchApi("/api/runs/start", {
    method: "POST",
    body: JSON.stringify(params),
  })
}

export async function getCompletedRuns(): Promise<RunSummary[]> {
  const runs = await getRuns()
  return runs.filter((r) => r.status === "completed")
}

// Providers & Benchmarks
export async function getProviders(): Promise<{ providers: Provider[] }> {
  return fetchApi("/api/providers")
}

export async function getBenchmarks(): Promise<{ benchmarks: Benchmark[] }> {
  return fetchApi("/api/benchmarks")
}

export async function getBenchmarkQuestions(
  benchmark: string,
  params?: { page?: number; limit?: number; type?: string }
): Promise<
  PaginatedResponse<{
    questionId: string
    question: string
    questionType: string
    groundTruth: string
  }>
> {
  const searchParams = new URLSearchParams()
  if (params?.page) searchParams.set("page", params.page.toString())
  if (params?.limit) searchParams.set("limit", params.limit.toString())
  if (params?.type) searchParams.set("type", params.type)

  const query = searchParams.toString()
  return fetchApi(`/api/benchmarks/${benchmark}/questions${query ? `?${query}` : ""}`)
}

export async function getModels(): Promise<{
  models: { openai: any[]; anthropic: any[]; google: any[] }
}> {
  return fetchApi("/api/models")
}

// Latency stats structure
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

export interface LatencyByPhase {
  ingest: LatencyStats
  indexing: LatencyStats
  search: LatencyStats
  answer: LatencyStats
  evaluate: LatencyStats
  total: LatencyStats
}

// Evaluation result for individual questions
export interface EvaluationResult {
  questionId: string
  questionType: string
  question?: string
  groundTruth: string
  hypothesis: string
  score: number
  label: string
  explanation: string
  searchResults?: any[]
  searchDurationMs?: number
  answerDurationMs?: number
  totalDurationMs?: number
}

export interface RetrievalQualityStats {
  hitAtK: number
  precisionAtK: number
  recallAtK: number
  f1AtK: number
  mrr: number
  ndcg: number
  k: number
}

// Leaderboard
export interface LeaderboardEntry {
  id: number
  runId: string
  provider: string
  benchmark: string
  version: string
  accuracy: number
  totalQuestions: number
  correctCount: number
  byQuestionType: Record<string, { total: number; correct: number; accuracy: number }>
  questionTypeRegistry: QuestionTypeRegistry | null
  latencyStats: LatencyByPhase | null
  retrieval: RetrievalQualityStats | null
  evaluations: EvaluationResult[]
  providerCode: string
  promptsUsed: Record<string, string> | null
  judgeModel: string
  answeringModel: string
  addedAt: string
  notes: string | null
}

export async function getLeaderboard(): Promise<{ entries: LeaderboardEntry[] }> {
  return fetchApi("/api/leaderboard")
}

export async function getLeaderboardEntry(id: number): Promise<LeaderboardEntry> {
  return fetchApi(`/api/leaderboard/${id}`)
}

export async function addToLeaderboard(
  runId: string,
  options?: { notes?: string; version?: string }
): Promise<{ message: string; entry: LeaderboardEntry }> {
  return fetchApi("/api/leaderboard", {
    method: "POST",
    body: JSON.stringify({ runId, notes: options?.notes, version: options?.version }),
  })
}

export async function removeFromLeaderboard(id: number): Promise<void> {
  await fetchApi(`/api/leaderboard/${id}`, { method: "DELETE" })
}

// Downloads
export interface ActiveDownload {
  benchmark: string
  displayName: string
  runId: string
}

export interface DownloadsResponse {
  hasActive: boolean
  downloads: ActiveDownload[]
}

export async function getActiveDownloads(): Promise<DownloadsResponse> {
  return fetchApi("/api/downloads")
}

// Compares
export type CompareStatus = "pending" | "running" | "stopping" | "completed" | "failed" | "partial"

export interface CompareRunInfo {
  provider: string
  runId: string
  status: string
  accuracy: number | null
  error?: string
  progress?: {
    total: number
    ingested: number
    indexed: number
    searched: number
    answered: number
    indexingEpisodes?: {
      total: number
      completed: number
      failed: number
    }
    evaluated: number
  }
}

export interface CompareRunProgress {
  provider: string
  runId: string
  progress: {
    total: number
    ingested: number
    indexed: number
    searched: number
    answered: number
    evaluated: number
  }
  status: string
}

export interface CompareSummary {
  compareId: string
  providers: string[]
  benchmark: string
  judge: string
  answeringModel: string
  status: CompareStatus
  createdAt: string
  updatedAt: string
  accuracy: number | null
  runProgress?: CompareRunProgress[]
}

export interface CompareDetail extends CompareSummary {
  sampling?: SamplingConfig
  targetQuestionIds?: string[]
  runs: CompareRunInfo[]
}

export interface BenchmarkResult {
  runId: string
  provider: string
  benchmark: string
  version?: string
  // Fields can be at root level or nested in summary
  accuracy?: number
  totalQuestions?: number
  correctCount?: number
  summary?: {
    totalQuestions: number
    correctCount: number
    accuracy: number
  }
  byQuestionType: Record<string, { total: number; correct: number; accuracy: number }>
  questionTypeRegistry: QuestionTypeRegistry | null
  latency?: LatencyByPhase
  latencyStats?: LatencyByPhase | null
  retrieval?: RetrievalQualityStats
  evaluations?: EvaluationResult[]
  providerCode?: string
  promptsUsed?: Record<string, string> | null
  judgeModel?: string
  answeringModel?: string
}

export interface CompareReport {
  compareId: string
  benchmark: string
  judge: string
  answeringModel: string
  reports: Array<{
    provider: string
    report: BenchmarkResult
  }>
}

export async function getCompares(): Promise<CompareSummary[]> {
  return fetchApi("/api/compare")
}

export async function getCompare(compareId: string): Promise<CompareDetail> {
  return fetchApi(`/api/compare/${encodeURIComponent(compareId)}`)
}

export async function getCompareReport(compareId: string): Promise<CompareReport> {
  return fetchApi(`/api/compare/${encodeURIComponent(compareId)}/report`)
}

export async function startCompare(params: {
  providers: string[]
  benchmark: string
  compareId: string
  judgeModel: string
  answeringModel?: string
  sampling?: SamplingConfig
}): Promise<{ message: string; compareId: string }> {
  return fetchApi("/api/compare/start", {
    method: "POST",
    body: JSON.stringify(params),
  })
}

export async function stopCompare(compareId: string): Promise<{ message: string }> {
  return fetchApi(`/api/compare/${encodeURIComponent(compareId)}/stop`, { method: "POST" })
}

export async function resumeCompare(compareId: string): Promise<{ message: string }> {
  return fetchApi(`/api/compare/${encodeURIComponent(compareId)}/resume`, { method: "POST" })
}

export async function deleteCompare(compareId: string): Promise<void> {
  await fetchApi(`/api/compare/${encodeURIComponent(compareId)}`, { method: "DELETE" })
}
