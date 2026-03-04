# Debugging and Troubleshooting Reference

Common issues when integrating a custom provider into MemoryBench and how to resolve them.

## Quick Diagnostics

If the benchmark fails, run these checks:

```bash
cd memorybench

# 1. Check environment variables
cat .env.local | grep YOUR_PROVIDER

# 2. Test single question
bun run src/index.ts test -p yourprovider -b locomo -q question_1

# 3. Check run status
bun run src/index.ts status -r your-run-id

# 4. View failures
bun run src/index.ts show-failures -r your-run-id
```

## Common Errors

### Error: "Provider not initialized"

**Symptoms:**
```
Error: Provider not initialized
  at YourProvider.ingest
```

**Causes:**
1. `initialize()` never called
2. `initialize()` threw an error
3. Client not assigned to `this.client`

**Solutions:**

Check initialization:
```typescript
async initialize(config: ProviderConfig): Promise<void> {
  // ADD LOGGING
  logger.info("Initializing provider with config", {
    hasApiKey: !!config.apiKey,
    baseUrl: config.baseUrl
  })

  try {
    this.client = new YourClient({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl || "http://localhost:3000"
    })

    // VERIFY CLIENT WORKS
    await this.client.ping() // or similar health check

    logger.info("Provider initialized successfully")
  } catch (error) {
    logger.error("Failed to initialize provider", { error })
    throw error
  }
}
```

Check environment variables:
```bash
# In .env.local
YOUR_PROVIDER_API_KEY=your-actual-key-here
YOUR_PROVIDER_BASE_URL=http://localhost:3000
```

---

### Error: "API key missing or invalid"

**Symptoms:**
```
Error: API key is required
Error: 401 Unauthorized
```

**Causes:**
1. Environment variable not set
2. Wrong variable name
3. Key not loaded from `.env.local`

**Solutions:**

Verify environment loading:
```typescript
async initialize(config: ProviderConfig): Promise<void> {
  // CHECK WHAT WE RECEIVED
  console.log("Config received:", {
    apiKey: config.apiKey ? "***" + config.apiKey.slice(-4) : "MISSING",
    baseUrl: config.baseUrl
  })

  if (!config.apiKey) {
    throw new Error("API key is missing. Check YOUR_PROVIDER_API_KEY in .env.local")
  }

  this.client = new YourClient({ apiKey: config.apiKey })
}
```

Check config.ts:
```typescript
// In src/utils/config.ts
case "yourprovider":
  return {
    apiKey: process.env.YOUR_PROVIDER_API_KEY || "",  // ← Correct variable name?
    baseUrl: process.env.YOUR_PROVIDER_BASE_URL,
  }
```

---

### Error: Ingestion fails silently

**Symptoms:**
- Ingestion phase completes
- Search returns no results
- No obvious errors

**Causes:**
1. Documents ingested but not indexed
2. ContainerTag mismatch
3. Data format rejected by API

**Solutions:**

Add detailed logging:
```typescript
async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
  logger.info(`Starting ingestion of ${sessions.length} sessions`)
  const documentIds: string[] = []

  for (const session of sessions) {
    const content = this.formatSession(session)

    logger.debug("Ingesting session", {
      sessionId: session.sessionId,
      contentLength: content.length,
      containerTag: options.containerTag,
      preview: content.substring(0, 100)
    })

    try {
      const response = await this.client.add({
        content,
        containerTag: options.containerTag,
        metadata: { sessionId: session.sessionId }
      })

      documentIds.push(response.id)
      logger.debug(`Ingested ${session.sessionId} -> ${response.id}`)

    } catch (error) {
      logger.error(`Failed to ingest ${session.sessionId}`, { error })
      throw error
    }
  }

  logger.info(`Ingested ${documentIds.length} sessions successfully`)
  return { documentIds }
}
```

Verify documents in your system:
```typescript
// After ingestion, check if documents exist
const doc = await this.client.getDocument(documentIds[0])
logger.info("Sample document:", { doc })
```

---

### Error: Search returns empty results

**Symptoms:**
```
Search results: []
Answer: "I don't have enough information..."
```

**Causes:**
1. Indexing not complete
2. ContainerTag filtering too strict
3. Search threshold too high
4. Query format incorrect

**Solutions:**

Check indexing status:
```typescript
async awaitIndexing(result: IngestResult, containerTag: string, onProgress) {
  logger.info("Waiting for indexing", {
    documentCount: result.documentIds.length,
    containerTag
  })

  // If async indexing, poll status
  for (const docId of result.documentIds) {
    const status = await this.client.getStatus(docId)
    logger.debug(`Document ${docId} status: ${status}`)
  }

  // Report completion
  onProgress?.({
    completedIds: result.documentIds,
    failedIds: [],
    total: result.documentIds.length
  })
}
```

Debug search:
```typescript
async search(query: string, options: SearchOptions): Promise<unknown[]> {
  logger.info("Searching", {
    query,
    containerTag: options.containerTag,
    limit: options.limit,
    threshold: options.threshold
  })

  const results = await this.client.search({
    query,
    containerTag: options.containerTag,
    limit: options.limit || 30,
    threshold: options.threshold || 0.3
  })

  logger.info("Search results", {
    count: results.length,
    samples: results.slice(0, 2).map(r => ({
      id: r.id,
      score: r.score,
      preview: r.content?.substring(0, 50)
    }))
  })

  return results
}
```

Test without containerTag:
```typescript
// Temporarily remove filtering to see if data exists
const allResults = await this.client.search({ query, limit: 30 })
logger.info("Total results without filter:", allResults.length)
```

---

### Error: Answers are incorrect

**Symptoms:**
- Search returns results
- LLM generates answers
- Judge scores them as incorrect

**Causes:**
1. Irrelevant search results
2. Poor result formatting
3. LLM not understanding context format
4. Retrieval threshold too high/low

**Solutions:**

Inspect search results:
```bash
cd memorybench
bun run src/index.ts test -p yourprovider -b locomo -q question_1
```

Look at what was retrieved vs what was needed.

Add custom prompts:
```typescript
// prompts.ts
export const YOUR_PROMPTS: ProviderPrompts = {
  answerPrompt: (question: string, context: unknown[], questionDate?: string) => {
    // Format context better for LLM understanding
    const formattedContext = context.map((item: any, idx) => {
      return `[Context ${idx + 1}]
Date: ${item.metadata?.date || 'Unknown'}
Content: ${item.content || JSON.stringify(item)}
Relevance: ${item.score || 'N/A'}`
    }).join('\n\n---\n\n')

    return `You are answering based on retrieved context.

Question: ${question}
${questionDate ? `Question Date: ${questionDate}` : ''}

Retrieved Context:
${formattedContext}

Instructions:
- Use ONLY the context above
- Be specific and accurate
- If context is insufficient, say so clearly
- Pay attention to dates and temporal information

Answer:`
  }
}
```

Adjust search threshold:
```typescript
async search(query: string, options: SearchOptions) {
  return await this.client.search({
    query,
    limit: 30,
    threshold: 0.2  // ← Lower = more results (less strict)
  })
}
```

---

### Error: Timeout during indexing

**Symptoms:**
```
Error: Timeout waiting for indexing to complete
```

**Causes:**
1. Indexing actually takes very long
2. Status check logic incorrect
3. Documents stuck in processing

**Solutions:**

Check if indexing is really needed:
```typescript
async awaitIndexing(result: IngestResult, containerTag: string, onProgress) {
  // If your system has synchronous indexing, just return immediately
  const total = result.documentIds.length
  onProgress?.({ completedIds: result.documentIds, failedIds: [], total })
  return
}
```

Add timeout handling:
```typescript
async awaitIndexing(result: IngestResult, containerTag: string, onProgress) {
  const MAX_WAIT_TIME = 5 * 60 * 1000  // 5 minutes
  const startTime = Date.now()

  const pending = new Set(result.documentIds)
  const completed: string[] = []
  const failed: string[] = []

  while (pending.size > 0) {
    // Check timeout
    if (Date.now() - startTime > MAX_WAIT_TIME) {
      logger.warn("Indexing timeout, marking remaining as failed", {
        remaining: pending.size
      })
      failed.push(...Array.from(pending))
      break
    }

    // Check statuses...
    await new Promise(r => setTimeout(r, 1000))
  }

  onProgress?.({
    completedIds: completed,
    failedIds: failed,
    total: result.documentIds.length
  })
}
```

---

### Error: Rate limit exceeded

**Symptoms:**
```
Error: 429 Too Many Requests
Error: Rate limit exceeded
```

**Causes:**
1. Too many concurrent requests
2. API has strict rate limits
3. Concurrency config too aggressive

**Solutions:**

Reduce concurrency:
```typescript
export class YourProvider implements Provider {
  concurrency = {
    default: 5,     // ← Lower numbers
    ingest: 10,
    indexing: 20,
  }
}
```

Add delays:
```typescript
async ingest(sessions: UnifiedSession[], options: IngestOptions) {
  const documentIds: string[] = []

  for (const session of sessions) {
    const response = await this.client.add(...)
    documentIds.push(response.id)

    // ADD DELAY between requests
    await new Promise(r => setTimeout(r, 200))  // 200ms delay
  }

  return { documentIds }
}
```

Add retry logic:
```typescript
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn()
    } catch (error: any) {
      if (error?.status === 429 && i < maxRetries - 1) {
        const delay = Math.pow(2, i) * 1000  // Exponential backoff
        logger.warn(`Rate limited, retrying in ${delay}ms...`)
        await new Promise(r => setTimeout(r, delay))
      } else {
        throw error
      }
    }
  }
  throw new Error("Max retries exceeded")
}

// Use it:
const response = await withRetry(() => this.client.add(...))
```

---

## Debugging Workflow

### Step 1: Validate Provider Structure

```bash
cd memorybench

# Check provider is registered
bun run src/index.ts help providers
# Should show your provider in the list
```

### Step 2: Test Initialization

```typescript
// Add to initialize()
async initialize(config: ProviderConfig): Promise<void> {
  logger.info("=== INITIALIZATION DEBUG ===")
  logger.info("Config:", config)

  this.client = new YourClient(config)

  logger.info("Client created:", { hasClient: !!this.client })
  logger.info("=== INITIALIZATION COMPLETE ===")
}
```

Run single test:
```bash
bun run src/index.ts test -p yourprovider -b locomo -q question_1
```

### Step 3: Test Ingestion

Add logging to `ingest()` as shown above, then:

```bash
# Run with limit to test ingestion only
bun run src/index.ts run -p yourprovider -b locomo -l 1 --force
```

Check if data appears in your system.

### Step 4: Test Search

Add logging to `search()` as shown above, then:

```bash
# Test search phase
bun run src/index.ts search -r your-run-id
```

Verify results are returned and contain expected data.

### Step 5: Test End-to-End

```bash
# Small run with full logging
bun run src/index.ts run -p yourprovider -b locomo -l 5 --force
```

Watch the output carefully for errors.

---

## Common Patterns and Solutions

### Pattern: "Works locally, fails in benchmark"

**Issue:** Your API works when tested directly but fails during benchmark.

**Cause:** Environment differences, timing issues, or state management.

**Solution:**
1. Use same API keys/config in both places
2. Test with same data format (UnifiedSession)
3. Check for race conditions in async code
4. Verify containerTag handling

### Pattern: "First few questions work, then fails"

**Issue:** Initial questions pass, later ones fail or hang.

**Cause:** Resource exhaustion, connection pooling, memory leaks.

**Solution:**
1. Add connection reuse/pooling
2. Close resources after each operation
3. Monitor memory usage during benchmark
4. Check for hanging promises

### Pattern: "Different results each time"

**Issue:** Same benchmark produces different scores on each run.

**Cause:** Non-deterministic search results, timing-dependent behavior.

**Solution:**
1. Ensure stable sorting of search results
2. Use consistent threshold values
3. Check if results are based on server state
4. Verify data is fully indexed before searching

---

## Logging Best Practices

Add structured logging throughout:

```typescript
import { logger } from "../../utils/logger"

// INFO: Major events
logger.info("Starting ingestion", { sessionCount: sessions.length })

// DEBUG: Detailed data
logger.debug("Session transformed", {
  sessionId,
  originalSize: original.length,
  transformedSize: transformed.length
})

// WARN: Concerning but not fatal
logger.warn("Using default threshold", { threshold: 0.3 })

// ERROR: Failures
logger.error("Failed to search", { error, query })
```

View logs during execution:
```bash
# Logs appear in stdout during runs
bun run src/index.ts run -p yourprovider -b locomo -l 5
```

---

## Getting Help

If you're still stuck:

1. **Check existing providers** - Look at `src/providers/supermemory`, `src/providers/mem0`, etc. for working examples

2. **Run comparison** - Compare your provider against a working one:
   ```bash
   bun run src/index.ts compare -p yourprovider,filesystem -b locomo -l 5
   ```

3. **Share failure details**:
   - Error messages
   - Provider code (sanitize API keys)
   - Sample of your data format
   - Steps to reproduce

4. **Open an issue**: https://github.com/supermemoryai/memorybench/issues

---

## Performance Optimization

Once working, optimize for speed:

### Increase Concurrency

```typescript
concurrency = {
  default: 100,
  ingest: 200,
  indexing: 500,
}
```

Test with `bun run src/index.ts run -p yourprovider -b locomo -l 20` and monitor for errors.

### Batch Operations

```typescript
async ingest(sessions: UnifiedSession[], options: IngestOptions) {
  // Process in batches
  const BATCH_SIZE = 10
  const documentIds: string[] = []

  for (let i = 0; i < sessions.length; i += BATCH_SIZE) {
    const batch = sessions.slice(i, i + BATCH_SIZE)

    const responses = await Promise.all(
      batch.map(session => this.client.add(this.formatSession(session)))
    )

    documentIds.push(...responses.map(r => r.id))
  }

  return { documentIds }
}
```

### Caching

If your API is slow, cache results:

```typescript
private cache = new Map<string, unknown[]>()

async search(query: string, options: SearchOptions) {
  const cacheKey = `${query}:${options.containerTag}`

  if (this.cache.has(cacheKey)) {
    return this.cache.get(cacheKey)!
  }

  const results = await this.client.search(...)
  this.cache.set(cacheKey, results)
  return results
}
```

---

## See Also

- [Provider Template](provider-template.md) - Complete code templates
- [Data Formats](data-formats.md) - Understanding UnifiedSession transformations
- [Benchmarks](benchmarks.md) - What each benchmark tests
