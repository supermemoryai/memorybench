import type { UnifiedSession } from "./unified"
import type { ProviderPrompts } from "./prompts"

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
    limit?: number
    threshold?: number
}

export interface IngestResult {
    documentIds: string[]
    taskIds?: string[]
}

export interface Provider {
    name: string
    prompts?: ProviderPrompts
    initialize(config: ProviderConfig): Promise<void>
    ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult>
    awaitIndexing(result: IngestResult, containerTag: string): Promise<void>
    search(query: string, options: SearchOptions): Promise<unknown[]>
    clear(containerTag: string): Promise<void>
}

export type ProviderName = "supermemory" | "mem0" | "zep" | "localbm25"
