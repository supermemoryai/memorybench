# Data Formats Reference

This document explains the data structures used in MemoryBench and how to transform them for your memory system.

## UnifiedSession Format

MemoryBench uses a standardized format for all benchmark data called `UnifiedSession`.

### TypeScript Definition

```typescript
interface UnifiedSession {
  sessionId: string
  messages: Array<{
    role: 'user' | 'assistant'
    content: string
  }>
  metadata?: {
    date?: string           // ISO 8601 format: "2024-01-15T10:30:00Z"
    formattedDate?: string  // Human readable: "January 15, 2024"
    [key: string]: unknown  // Additional benchmark-specific metadata
  }
}
```

### Example Data

```typescript
const session: UnifiedSession = {
  sessionId: "session_42",
  messages: [
    {
      role: "user",
      content: "I'm planning a trip to Japan in March. Any recommendations?"
    },
    {
      role: "assistant",
      content: "March is a great time to visit Japan! Cherry blossoms typically bloom..."
    },
    {
      role: "user",
      content: "What about hotels in Tokyo?"
    },
    {
      role: "assistant",
      content: "For Tokyo, I'd recommend staying in Shibuya or Shinjuku..."
    }
  ],
  metadata: {
    date: "2024-01-15T10:30:00Z",
    formattedDate: "January 15, 2024",
    userId: "user_123"
  }
}
```

## Common Transformation Patterns

Your memory system likely expects a different format. Here are common patterns:

### Pattern 1: Plain Text Concatenation

Convert the entire session to a single text string:

```typescript
function formatAsPlainText(session: UnifiedSession): string {
  const conversation = session.messages
    .map(msg => `${msg.role.toUpperCase()}: ${msg.content}`)
    .join('\n\n')

  const datePrefix = session.metadata?.formattedDate
    ? `Date: ${session.metadata.formattedDate}\n\n`
    : ''

  return `${datePrefix}${conversation}`
}

// Result:
// Date: January 15, 2024
//
// USER: I'm planning a trip to Japan in March. Any recommendations?
//
// ASSISTANT: March is a great time to visit Japan! Cherry blossoms...
```

### Pattern 2: JSON String

Serialize the session to JSON:

```typescript
function formatAsJSON(session: UnifiedSession): string {
  const sessionStr = JSON.stringify(session.messages, null, 2)
    .replace(/</g, "&lt;")   // Escape HTML for safety
    .replace(/>/g, "&gt;")

  const datePrefix = session.metadata?.formattedDate
    ? `Session Date: ${session.metadata.formattedDate}\n\n`
    : ''

  return `${datePrefix}Session Data:\n${sessionStr}`
}

// Result:
// Session Date: January 15, 2024
//
// Session Data:
// [
//   {
//     "role": "user",
//     "content": "I'm planning..."
//   },
//   ...
// ]
```

### Pattern 3: Structured with Metadata

Include all metadata fields:

```typescript
function formatWithMetadata(session: UnifiedSession): string {
  const metadata = session.metadata || {}
  const metadataStr = Object.entries(metadata)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')

  const conversation = session.messages
    .map(msg => `${msg.role}: ${msg.content}`)
    .join('\n\n')

  return `Session: ${session.sessionId}\n${metadataStr}\n\n${conversation}`
}

// Result:
// Session: session_42
// date: 2024-01-15T10:30:00Z
// formattedDate: January 15, 2024
// userId: user_123
//
// user: I'm planning a trip to Japan...
```

### Pattern 4: Markdown Format

Readable markdown structure:

```typescript
function formatAsMarkdown(session: UnifiedSession): string {
  const date = session.metadata?.formattedDate || 'Unknown date'

  const conversation = session.messages.map(msg => {
    const speaker = msg.role === 'user' ? '**User**' : '*Assistant*'
    return `${speaker}: ${msg.content}`
  }).join('\n\n')

  return `# Session: ${session.sessionId}
*Date: ${date}*

## Conversation

${conversation}`
}

// Result:
// # Session: session_42
// *Date: January 15, 2024*
//
// ## Conversation
//
// **User**: I'm planning a trip to Japan...
//
// *Assistant*: March is a great time...
```

### Pattern 5: Per-Message Documents

Split into individual messages (if your system prefers granular storage):

```typescript
function formatAsMessages(session: UnifiedSession): Array<{
  content: string
  metadata: Record<string, unknown>
}> {
  return session.messages.map((msg, idx) => ({
    content: msg.content,
    metadata: {
      sessionId: session.sessionId,
      messageIndex: idx,
      role: msg.role,
      date: session.metadata?.date,
      formattedDate: session.metadata?.formattedDate,
    }
  }))
}

// Result: Array of individual message objects
```

## Ingestion Transformation

Your provider's `ingest()` method must transform UnifiedSession to your format:

```typescript
async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
  const documentIds: string[] = []

  for (const session of sessions) {
    // TRANSFORM HERE based on your pattern
    const content = this.formatSession(session)

    // Then pass to your API
    const response = await this.client.add({
      content,
      containerTag: options.containerTag,
      metadata: {
        sessionId: session.sessionId,
        date: session.metadata?.date,
      }
    })

    documentIds.push(response.id)
  }

  return { documentIds }
}

private formatSession(session: UnifiedSession): string {
  // Choose transformation pattern here
  return formatAsPlainText(session)
  // or formatAsJSON(session)
  // or formatWithMetadata(session)
  // etc.
}
```

## Search Result Formats

Your provider's `search()` method returns results. Common formats:

### Format 1: Content + Metadata

```typescript
interface SearchResult {
  id: string
  content: string
  metadata: {
    sessionId: string
    date?: string
    score?: number
  }
}

// Example:
[
  {
    id: "doc_123",
    content: "USER: I'm planning a trip...\n\nASSISTANT: March is great...",
    metadata: {
      sessionId: "session_42",
      date: "2024-01-15T10:30:00Z",
      score: 0.87
    }
  }
]
```

### Format 2: Memory Objects

```typescript
interface MemoryResult {
  memory: string
  context?: string
  relevance: number
  timestamp?: string
}

// Example:
[
  {
    memory: "User is planning a trip to Japan in March",
    context: "From conversation on January 15, 2024",
    relevance: 0.92,
    timestamp: "2024-01-15T10:30:00Z"
  }
]
```

### Format 3: Simple Array

```typescript
// Just strings
["Memory 1 text here", "Memory 2 text here", ...]

// Or objects with minimal structure
[{ text: "...", score: 0.85 }, ...]
```

## Custom Prompts for Search Results

If your search results have a special format, you may need custom prompts to format them for the LLM.

### Default Prompt Behavior

MemoryBench's default answer prompt does this:

```typescript
const formattedContext = context.map((item, idx) => {
  return `[${idx + 1}] ${JSON.stringify(item)}`
}).join('\n\n')
```

This works but may not be optimal for your format.

### Custom Prompt Example

Create `prompts.ts` to format your results better:

```typescript
export const MY_PROMPTS: ProviderPrompts = {
  answerPrompt: (question: string, context: unknown[], questionDate?: string) => {
    // Cast to your format
    const results = context as Array<{
      memory: string
      relevance: number
      timestamp?: string
    }>

    // Format nicely
    const formattedContext = results.map((item, idx) => {
      const date = item.timestamp
        ? `\nDate: ${new Date(item.timestamp).toLocaleDateString()}`
        : ''
      const score = `\nRelevance: ${(item.relevance * 100).toFixed(0)}%`

      return `[Memory ${idx + 1}]${date}${score}\n${item.memory}`
    }).join('\n\n---\n\n')

    return `Question: ${question}
${questionDate ? `Asked on: ${questionDate}` : ''}

Retrieved Memories:
${formattedContext}

Answer the question based only on the memories above.

Answer:`
  }
}
```

## Container Tags

MemoryBench uses `containerTag` to isolate benchmark runs:

```typescript
interface IngestOptions {
  containerTag: string  // e.g., "run_abc123_locomo"
  metadata?: Record<string, unknown>
}

interface SearchOptions {
  containerTag: string  // Same as ingestion
  limit?: number
  threshold?: number
}
```

Your provider should:
1. Store the containerTag with each ingested document
2. Filter search results by containerTag
3. Support clearing data by containerTag (optional)

### Implementation Example

```typescript
async ingest(sessions: UnifiedSession[], options: IngestOptions) {
  for (const session of sessions) {
    await this.client.add({
      content: formatSession(session),
      metadata: {
        containerTag: options.containerTag,  // ← Store this
        sessionId: session.sessionId,
      }
    })
  }
}

async search(query: string, options: SearchOptions) {
  return await this.client.search({
    query,
    filter: {
      containerTag: options.containerTag  // ← Filter by this
    }
  })
}
```

## Temporal Information

Temporal context is especially important for LoCoMo benchmark:

### Including Dates in Content

```typescript
function formatWithDate(session: UnifiedSession): string {
  const date = session.metadata?.formattedDate
  if (date) {
    return `This conversation took place on ${date}.\n\n${formatConversation(session)}`
  }
  return formatConversation(session)
}
```

### Date in Metadata vs Content

**Metadata approach:**
```typescript
await this.client.add({
  content: formatConversation(session),
  metadata: {
    date: session.metadata?.date,  // ISO format for filtering
    sessionId: session.sessionId,
  }
})
```

**Content approach:**
```typescript
await this.client.add({
  content: `Date: ${session.metadata?.formattedDate}\n\n${formatConversation(session)}`,
  metadata: { sessionId: session.sessionId }
})
```

**Recommendation:** Include date in BOTH content (for LLM understanding) and metadata (for filtering/sorting).

## Best Practices

1. **Preserve temporal information** - Include dates if available
2. **Include session IDs** - Helps with debugging
3. **Format for readability** - LLMs perform better with clear structure
4. **Escape HTML** - Prevent injection if content has `<` or `>`
5. **Test with sample data** - Verify transformations before full benchmark
6. **Use custom prompts** - If search results have rich structure

## Debugging Data Flow

To debug transformations:

```typescript
async ingest(sessions: UnifiedSession[], options: IngestOptions) {
  for (const session of sessions) {
    const content = this.formatSession(session)

    // LOG THE TRANSFORMATION
    logger.debug("Transformed session", {
      sessionId: session.sessionId,
      originalLength: JSON.stringify(session).length,
      transformedLength: content.length,
      preview: content.substring(0, 100)
    })

    await this.client.add({ content, ... })
  }
}
```

Check logs to ensure:
- Dates are included correctly
- Content is properly formatted
- No data loss in transformation
- Special characters handled correctly

## See Also

- [Provider Template](provider-template.md) - Code templates using these formats
- [Benchmarks](benchmarks.md) - Understanding what data each benchmark provides
- [Debugging](debugging.md) - Troubleshooting data format issues
