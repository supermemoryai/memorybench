const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"

export interface RunSummary {
  runId: string
  provider: string
  benchmark: string
  judge: string
  answeringModel: string
  createdAt: string
  updatedAt: string
  status: "initializing" | "pending" | "running" | "stopping" | "completed" | "partial" | "failed"
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
    answer: { status: string; hypothesis?: string }
    evaluate: { status: string; score?: number; label?: string; explanation?: string }
  }
}

export interface RunDetail extends RunSummary {
  questions: Record<string, QuestionCheckpoint>
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

export async function getRun(runId: string): Promise<RunDetail> {
  return fetchApi(`/api/runs/${encodeURIComponent(runId)}`)
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

export async function getQuestion(
  runId: string,
  questionId: string
): Promise<QuestionCheckpoint & { searchResultsFile?: any }> {
  return fetchApi(
    `/api/runs/${encodeURIComponent(runId)}/questions/${encodeURIComponent(questionId)}`
  )
}

export async function deleteRun(runId: string): Promise<void> {
  await fetchApi(`/api/runs/${encodeURIComponent(runId)}`, { method: "DELETE" })
}

export async function stopRun(runId: string): Promise<{ message: string }> {
  return fetchApi(`/api/runs/${encodeURIComponent(runId)}/stop`, { method: "POST" })
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
  retrieval?: {
    hitAtK: number
    precisionAtK: number
    recallAtK: number
    f1AtK: number
    mrr: number
    ndcg: number
    k: number
  }
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
