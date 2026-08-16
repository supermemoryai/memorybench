import type { UnifiedSession } from "./unified"
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
}

export interface SearchOptions {
  containerTag: string
  /**
   * Hard cap on the number of results `search` may return, not a hint.
   *
   * Every retrieved result is fed to the answering model as context, so a provider that
   * returns more than it was asked for gets more context than the providers it is being
   * compared against — an accuracy and token advantage unrelated to retrieval quality.
   * If a provider searches several scopes, split this budget between them rather than
   * requesting `limit` of each.
   */
  limit?: number
  threshold?: number
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

export type ProviderName = "supermemory" | "mem0" | "zep" | "filesystem" | "rag"
