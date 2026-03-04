# Provider Template Reference

This document contains the code templates used to generate provider adapters for MemoryBench.

## Provider Interface

All providers must implement this interface from `src/types/provider.ts`:

```typescript
interface Provider {
  name: string
  prompts?: ProviderPrompts
  concurrency?: ConcurrencyConfig
  initialize(config: ProviderConfig): Promise<void>
  ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult>
  awaitIndexing(result: IngestResult, containerTag: string, onProgress?: IndexingProgressCallback): Promise<void>
  search(query: string, options: SearchOptions): Promise<unknown[]>
  clear(containerTag: string): Promise<void>
}
```

## Main Provider Template

Use this template when generating a provider adapter. Replace placeholders with actual values from code discovery.

### File: `memorybench/src/providers/{providerName}/index.ts`

```typescript
import type {
  Provider,
  ProviderConfig,
  IngestOptions,
  IngestResult,
  SearchOptions,
  IndexingProgressCallback,
} from "../../types/provider"
import type { UnifiedSession } from "../../types/unified"
import { logger } from "../../utils/logger"

// COPY/ADAPT USER'S IMPORTS AND TYPES HERE
// Example:
// import { UserMemoryClient } from "../../../../src/lib/memory"
// type UserMemoryConfig = { apiKey: string, baseUrl: string }

export class {ProviderName}Provider implements Provider {
  name = "{providerName}"

  concurrency = {
    default: 50,    // Adjust based on API limits
    ingest: 100,    // Parallel ingestion operations
    indexing: 200,  // Parallel indexing checks
  }

  private client: any = null  // Replace 'any' with actual client type

  async initialize(config: ProviderConfig): Promise<void> {
    // ADAPT: User's initialization code
    //
    // Example for SDK:
    // this.client = new UserMemoryClient({
    //   apiKey: config.apiKey,
    //   baseUrl: config.baseUrl || "http://localhost:3000"
    // })
    //
    // Example for REST API:
    // this.client = {
    //   apiKey: config.apiKey,
    //   baseUrl: config.baseUrl || "http://localhost:3000",
    //   fetch: (endpoint, options) => fetch(`${baseUrl}${endpoint}`, {
    //     ...options,
    //     headers: { ...options.headers, "Authorization": `Bearer ${apiKey}` }
    //   })
    // }

    logger.info(`Initialized {ProviderName} provider`)
  }

  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
    if (!this.client) throw new Error("Provider not initialized")

    const documentIds: string[] = []

    for (const session of sessions) {
      try {
        // TRANSFORM: UnifiedSession -> User's format
        const content = this.formatSessionForIngestion(session)

        // ADAPT: User's add/ingest code
        //
        // Example:
        // const response = await this.client.add({
        //   content,
        //   metadata: {
        //     sessionId: session.sessionId,
        //     containerTag: options.containerTag,
        //     date: session.metadata?.date
        //   }
        // })

        // documentIds.push(response.id)

        logger.debug(`Ingested session ${session.sessionId}`)

        // Optional: Rate limiting delay
        // await new Promise(r => setTimeout(r, 100))

      } catch (error) {
        logger.error(`Failed to ingest session ${session.sessionId}`, { error })
        throw error
      }
    }

    return { documentIds }
  }

  async awaitIndexing(
    result: IngestResult,
    containerTag: string,
    onProgress?: IndexingProgressCallback
  ): Promise<void> {
    if (!this.client) throw new Error("Provider not initialized")

    const total = result.documentIds.length
    if (total === 0) {
      onProgress?.({ completedIds: [], failedIds: [], total: 0 })
      return
    }

    // ADAPT BASED ON USER'S SYSTEM:

    // OPTION A: SYNCHRONOUS (data immediately searchable)
    onProgress?.({ completedIds: result.documentIds, failedIds: [], total })
    return

    // OPTION B: ASYNCHRONOUS (needs polling)
    // Uncomment and adapt this if user's system has async indexing:
    /*
    const pending = new Set(result.documentIds)
    const completedIds: string[] = []
    const failedIds: string[] = []
    let backoffMs = 1000

    onProgress?.({ completedIds: [], failedIds: [], total })

    while (pending.size > 0) {
      const pendingArray = Array.from(pending)

      // Check status of pending documents
      const results = await Promise.allSettled(
        pendingArray.map(async (docId) => {
          // ADAPT: User's status check method
          const status = await this.client.getStatus(docId)
          return { docId, status }
        })
      )

      for (const res of results) {
        if (res.status === "fulfilled") {
          const { docId, status } = res.value
          if (status === "ready" || status === "done" || status === "completed") {
            pending.delete(docId)
            completedIds.push(docId)
          } else if (status === "failed" || status === "error") {
            pending.delete(docId)
            failedIds.push(docId)
          }
        }
      }

      onProgress?.({ completedIds: [...completedIds], failedIds: [...failedIds], total })

      if (pending.size > 0) {
        await new Promise(r => setTimeout(r, backoffMs))
        backoffMs = Math.min(backoffMs * 1.2, 5000)  // Exponential backoff
      }
    }

    if (failedIds.length > 0) {
      logger.warn(`${failedIds.length} documents failed indexing`)
    }
    */
  }

  async search(query: string, options: SearchOptions): Promise<unknown[]> {
    if (!this.client) throw new Error("Provider not initialized")

    try {
      // ADAPT: User's search code
      //
      // Example:
      // const response = await this.client.search({
      //   query,
      //   containerTag: options.containerTag,
      //   limit: options.limit || 30,
      //   threshold: options.threshold || 0.3,
      // })
      //
      // return response.results || response.memories || response.data || []

      // Return results in whatever format they come
      // The orchestrator handles them via prompts
      return []

    } catch (error) {
      logger.error("Search failed", { error, query })
      throw error
    }
  }

  async clear(containerTag: string): Promise<void> {
    if (!this.client) throw new Error("Provider not initialized")

    // ADAPT: User's clear/delete code if available
    //
    // Example:
    // await this.client.deleteByTag(containerTag)
    //
    // If not available:
    logger.warn(`Clear not implemented for {ProviderName} - containerTag: ${containerTag}`)
  }

  private formatSessionForIngestion(session: UnifiedSession): string {
    // Convert session to string format for ingestion
    // See data-formats.md for UnifiedSession structure

    const sessionStr = JSON.stringify(session.messages)
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")

    const formattedDate = session.metadata?.formattedDate as string
    const isoDate = session.metadata?.date as string

    if (formattedDate) {
      return `Date: ${formattedDate}\n\nSession:\n${sessionStr}`
    }
    return `Session:\n${sessionStr}`
  }
}

export default {ProviderName}Provider
```

## Custom Prompts Template (Optional)

If the user's search results need special formatting, create custom prompts.

### File: `memorybench/src/providers/{providerName}/prompts.ts`

```typescript
import type { ProviderPrompts } from "../../types/prompts"

export const {PROVIDER_CONST_NAME}_PROMPTS: ProviderPrompts = {
  answerPrompt: (question: string, context: unknown[], questionDate?: string) => {
    // Format context based on user's search result structure

    const formattedContext = context.map((item: any, idx: number) => {
      // ADAPT: Transform user's result format to readable text
      //
      // Common patterns:
      // - item.content || item.text || item.memory
      // - item.metadata
      // - item.score || item.similarity

      const content = item.content || item.text || JSON.stringify(item)
      const metadata = item.metadata ? `\nMetadata: ${JSON.stringify(item.metadata)}` : ""
      const score = item.score ? `\nRelevance: ${item.score}` : ""

      return `[Memory ${idx + 1}]\n${content}${metadata}${score}`
    }).join('\n\n---\n\n')

    return `You are answering questions based on retrieved memories.

Question: ${question}
${questionDate ? `Question Date: ${questionDate}` : ''}

Retrieved Context:
${formattedContext}

Instructions:
- Answer based ONLY on the retrieved context above
- Be specific and cite relevant details from the memories
- If information is insufficient, acknowledge what's missing
- Maintain accuracy - don't infer beyond what's provided

Answer:`
  }
}
```

Then import and use in the provider:

```typescript
import { {PROVIDER_CONST_NAME}_PROMPTS } from "./prompts"

export class {ProviderName}Provider implements Provider {
  prompts = {PROVIDER_CONST_NAME}_PROMPTS
  // ... rest of implementation
}
```

## Registration Updates

### 1. Update `memorybench/src/types/provider.ts`

Add provider name to the union type:

```typescript
export type ProviderName =
  | "supermemory"
  | "mem0"
  | "zep"
  | "filesystem"
  | "rag"
  | "{providerName}"  // ADD THIS
```

### 2. Update `memorybench/src/providers/index.ts`

Import and register:

```typescript
import { {ProviderName}Provider } from "./{providerName}"

const providers: Record<ProviderName, new () => Provider> = {
  supermemory: SupermemoryProvider,
  mem0: Mem0Provider,
  zep: ZepProvider,
  filesystem: FilesystemProvider,
  rag: RAGProvider,
  {providerName}: {ProviderName}Provider,  // ADD THIS
}

export {
  SupermemoryProvider,
  Mem0Provider,
  ZepProvider,
  FilesystemProvider,
  RAGProvider,
  {ProviderName}Provider  // ADD THIS
}
```

### 3. Update `memorybench/src/utils/config.ts`

Add to `getProviderConfig` function:

```typescript
export function getProviderConfig(provider: ProviderName): ProviderConfig {
  switch (provider) {
    // ... existing cases ...

    case "{providerName}":
      return {
        apiKey: process.env.{PROVIDER_ENV_PREFIX}_API_KEY || "",
        baseUrl: process.env.{PROVIDER_ENV_PREFIX}_BASE_URL,
        // Add any other config fields needed
      }

    default:
      throw new Error(`Unknown provider: ${provider}`)
  }
}
```

### 4. Update `memorybench/.env.example`

Document environment variables:

```bash
# {ProviderName} Provider Configuration
{PROVIDER_ENV_PREFIX}_API_KEY=your_api_key_here
{PROVIDER_ENV_PREFIX}_BASE_URL=http://localhost:3000  # Optional: default URL
# Add any other environment variables needed
```

## Concurrency Configuration

Adjust based on the user's API rate limits:

```typescript
concurrency = {
  default: 10,    // Conservative for limited APIs
  ingest: 20,     // Can usually handle more writes
  indexing: 50,   // Status checks are usually lightweight
}
```

Or for robust APIs:

```typescript
concurrency = {
  default: 50,
  ingest: 100,
  indexing: 200,
}
```

## Example: Supermemory Provider

For reference, here's a real implementation:

```typescript
export class SupermemoryProvider implements Provider {
  name = "supermemory"
  prompts = SUPERMEMORY_PROMPTS
  concurrency = {
    default: 50,
    ingest: 100,
    indexing: 200,
  }
  private client: Supermemory | null = null

  async initialize(config: ProviderConfig): Promise<void> {
    this.client = new Supermemory({
      apiKey: config.apiKey,
      baseURL: "http://localhost:8787"
    })
    logger.info(`Initialized Supermemory provider`)
  }

  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
    if (!this.client) throw new Error("Provider not initialized")
    const documentIds: string[] = []

    for (const session of sessions) {
      const sessionStr = JSON.stringify(session.messages)
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")

      const content = session.metadata?.formattedDate
        ? `Date: ${session.metadata.formattedDate}\n\nSession:\n${sessionStr}`
        : `Session:\n${sessionStr}`

      const response = await this.client.add({
        content,
        containerTag: options.containerTag,
        metadata: { sessionId: session.sessionId },
      })

      documentIds.push(response.id)
      await new Promise(r => setTimeout(r, 100))
    }

    return { documentIds }
  }

  async search(query: string, options: SearchOptions): Promise<unknown[]> {
    if (!this.client) throw new Error("Provider not initialized")

    const response = await this.client.search.memories({
      q: query,
      containerTag: options.containerTag,
      limit: 30,
      threshold: options.threshold || 0.3,
    })

    return response.results || []
  }
}
```

## Key Adaptation Points

When generating a provider, focus on adapting these areas:

1. **Client initialization** - SDK vs REST API vs direct DB access
2. **Data format transformation** - UnifiedSession → User's format
3. **Async handling** - Sync vs async indexing
4. **Result format** - What search returns, may need custom prompts
5. **Error handling** - Rate limits, network errors, validation
6. **Configuration** - API keys, URLs, custom parameters

See existing providers in `memorybench/src/providers/` for more examples.
