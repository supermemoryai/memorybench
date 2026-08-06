import type {
  CanonicalIngestionDocument,
  ProviderRequestDiagnostic,
  ProviderResultDropDiagnostic,
  UnifiedSearchResult,
} from "./unified"
import type { ProviderPrompts } from "./prompts"
import type { ConcurrencyConfig } from "./concurrency"

export interface ProviderConfig {
  apiKey: string
  baseUrl?: string
  [key: string]: unknown
}

export interface IngestOptions {
  containerTag: string
  metadata?: Record<string, unknown>
  /** Request immediate provider processing when the benchmark requires a causal barrier. */
  processingMode?: "instant"
}

export interface SearchOptions {
  containerTag: string
  limit: number
  threshold?: number
  searchMode?: string
  filters?: Record<string, unknown>
}

export interface IngestResult {
  documentIds: string[]
  taskIds?: string[]
  /** Per-input outcomes for providers that can partially accept a batch. */
  items?: IngestItemResult[]
}

export interface IngestItemResult {
  customId: string
  documentIds: string[]
  taskIds?: string[]
  error?: string
}

export interface IndexingProgress {
  completedIds: string[]
  failedIds: string[]
  total: number
}

export interface ProviderSearchDiagnostics {
  requestedLimit: number
  providerRequests: ProviderRequestDiagnostic[]
  rawReturnedCount: number
  normalizedCount: number
  droppedCount: number
  droppedResults: ProviderResultDropDiagnostic[]
}

export interface ProviderSearchResponse {
  results: UnifiedSearchResult[]
  diagnostics: ProviderSearchDiagnostics
}

export type ProviderSearchRequestStructure =
  | { kind: "single" }
  | { kind: "split"; budget: "shared-total" }

export type IndexingProgressCallback = (progress: IndexingProgress) => void

export interface AwaitIndexingOptions {
  /** Operational polling deadline. This does not change the built container identity. */
  timeoutMs?: number
}

export interface Provider {
  name: string
  adapterVersion: string
  searchRequestStructure: ProviderSearchRequestStructure
  prompts?: ProviderPrompts
  concurrency?: ConcurrencyConfig
  /**
   * Fingerprint every non-secret provider setting that can change the built
   * memory container. The orchestrator records this in the build identity
   * before initializing the provider so resume cannot cross configuration
   * drift silently.
   */
  getIngestionConfigFingerprint(config: ProviderConfig): string
  initialize(config: ProviderConfig): Promise<void>
  ingest(documents: CanonicalIngestionDocument[], options: IngestOptions): Promise<IngestResult>
  awaitIndexing(
    result: IngestResult,
    containerTag: string,
    onProgress?: IndexingProgressCallback,
    options?: AwaitIndexingOptions
  ): Promise<void>
  search(query: string, options: SearchOptions): Promise<ProviderSearchResponse>
  clear(containerTag: string): Promise<void>
}

export type ProviderName = "supermemory" | "mem0" | "zep" | "filesystem" | "rag"
