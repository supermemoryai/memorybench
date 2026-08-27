import type { UnifiedSession } from "./unified"
import type { ProviderPrompts } from "./prompts"
import type { ConcurrencyConfig } from "./concurrency"
import type { ProviderCapabilities } from "./migration"
import type {
  MemoryBuildPlan,
  NormalizedRetrievalResult,
  PhysicalDocument,
  RetrievalConfig,
} from "./migration"

export interface ProviderConfig {
  apiKey: string
  baseUrl?: string
  [key: string]: unknown
}

export interface IngestOptions {
  containerTag: string
  metadata?: Record<string, unknown>
  signal?: AbortSignal
}

export interface SearchOptions {
  containerTag: string
  limit?: number
  threshold?: number
  signal?: AbortSignal
}

export interface IngestResult {
  documentIds: string[]
  taskIds?: string[]
}

export interface IndexingProgress {
  completedIds: string[]
  failedIds: string[]
  total: number
}

export type IndexingProgressCallback = (progress: IndexingProgress) => void

export interface Provider {
  name: string
  capabilities: ProviderCapabilities
  prompts?: ProviderPrompts
  concurrency?: ConcurrencyConfig
  initialize(config: ProviderConfig): Promise<void>
  ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult>
  awaitIndexing(
    result: IngestResult,
    containerTag: string,
    onProgress?: IndexingProgressCallback
  ): Promise<void>
  search(query: string, options: SearchOptions): Promise<unknown[]>
  clear(containerTag: string): Promise<void>
}

/**
 * Optional exact-session bridge used by build-aware adapters around legacy
 * MemoryBench providers. Providers implementing this contract can prove that a
 * deterministic session exists after a process restart and can remove only the
 * requested sessions without disturbing the rest of a shared build.
 */
export interface BuildAwareSessionBridge {
  inspectSessions(
    containerTag: string,
    sessionIds: string[]
  ): Promise<
    Array<{
      sessionId: string
      status: "ready" | "absent"
      metadata?: Record<string, unknown>
    }>
  >
  deleteSessions(containerTag: string, sessionIds: string[]): Promise<void>
}

export type ProviderName = "supermemory" | "mem0" | "zep" | "filesystem" | "rag"

export type RemoteDocumentStatus = "absent" | "pending" | "ready" | "failed" | "unknown"

export interface RemoteDocumentState {
  customId: string
  remoteId?: string
  status: RemoteDocumentStatus
  raw?: unknown
  error?: string
}

export interface BuildBatchRequest {
  build: MemoryBuildPlan
  trajectoryId: string
  documents: PhysicalDocument[]
}

export interface BuildSearchRequest {
  build: MemoryBuildPlan
  questionId: string
  query: string
  config: RetrievalConfig
}

export interface BuildSearchResponse {
  request: Record<string, unknown>
  rawResponse: unknown
  normalizedResults: NormalizedRetrievalResult[]
  remoteDurationMs: number
}

export interface BuildProvider {
  name: string
  capabilities: ProviderCapabilities
  submitDocumentBatch(request: BuildBatchRequest): Promise<RemoteDocumentState[]>
  reconcileDocuments(build: MemoryBuildPlan, customIds: string[]): Promise<RemoteDocumentState[]>
  searchBuild(request: BuildSearchRequest): Promise<BuildSearchResponse>
  verifyBuildHealth(build: MemoryBuildPlan): Promise<RemoteDocumentState[]>
  deleteDocuments(build: MemoryBuildPlan, customIds: string[]): Promise<void>
  clearBuild(build: MemoryBuildPlan): Promise<void>
}
