import type { ProviderPrompts } from "../../types/prompts"

interface SupermemoryChunk {
  content: string
  position: number
}

interface SupermemoryResult {
  memory?: string
  chunk?: string
  chunks?: SupermemoryChunk[]
  metadata?: {
    temporalContext?: {
      documentDate?: string
      eventDate?: string | string[]
    }
  }
}

function deduplicateAndSortChunks(chunks: SupermemoryChunk[]): SupermemoryChunk[] {
  const uniqueChunks = chunks.filter(
    (chunk, index, self) => index === self.findIndex((c) => c.content === chunk.content)
  )
  return uniqueChunks.sort((a, b) => a.position - b.position)
}

function buildSupermemoryContext(context: unknown[]): string {
  const results = context as SupermemoryResult[]
  const allChunks: SupermemoryChunk[] = []

  for (let i = 0; i < results.length; i++) {
    const result = results[i]

    const chunks = result.chunks || []
    for (const chunk of chunks) {
      allChunks.push({
        content: chunk.content,
        position: chunk.position ?? 0,
      })
    }

    if (result.chunk && typeof result.chunk === "string" && result.chunk.trim()) {
      allChunks.push({
        content: result.chunk,
        position: i,
      })
    }
  }

  const deduplicatedChunks = deduplicateAndSortChunks(allChunks)

  const memoriesSection = results
    .map((result, i) => {
      const memory = result.memory || ""
      const temporalContext = result.metadata?.temporalContext
      const documentDate = temporalContext?.documentDate
      const eventDate = temporalContext?.eventDate

      const memoryParts = [`Result ${i + 1}:`, memory]

      if (documentDate || eventDate) {
        const temporalInfo: string[] = []
        if (documentDate) temporalInfo.push(`documentDate: ${documentDate}`)
        if (eventDate) {
          const eventDates = Array.isArray(eventDate) ? eventDate : [eventDate]
          temporalInfo.push(`eventDate: ${eventDates.join(", ")}`)
        }
        memoryParts.push(`Temporal Context: ${temporalInfo.join(" | ")}`)
      }

      return memoryParts.join("\n")
    })
    .join("\n\n---\n\n")

  const chunksSection =
    deduplicatedChunks.length > 0
      ? `\n\n=== DEDUPLICATED CHUNKS ===\n${deduplicatedChunks.map((chunk) => chunk.content).join("\n\n---\n\n")}`
      : ""

  return memoriesSection + chunksSection
}

export function buildSupermemoryAnswerPrompt(
  question: string,
  context: unknown[],
  questionDate?: string
): string {
  const results = context as SupermemoryResult[]
  const retrievedContext = buildSupermemoryContext(context)

  // console.log(`\n=== DEBUG: Processing ${results.length} search results ===`)
  // for (let i = 0; i < Math.min(results.length, 3); i++) {
  //     const r = results[i]
  //     console.log(`Result ${i + 1}:`)
  //     console.log(`  - memory: ${r.memory?.substring(0, 80)}...`)
  //     console.log(`  - chunk (singular): ${r.chunk ? r.chunk.substring(0, 80) + "..." : "EMPTY"}`)
  //     console.log(`  - chunks (array): ${r.chunks?.length || 0} items`)
  //     if (r.chunks && r.chunks.length > 0) {
  //         console.log(`    First chunk: ${r.chunks[0].content?.substring(0, 80)}...`)
  //     }
  // }
  // console.log(`\n=== Total chunks extracted: ${retrievedContext.includes("DEDUPLICATED CHUNKS") ? "YES" : "NO CHUNKS"} ===`)
  // console.log("Retrieved context preview:", retrievedContext)

  return `You are a question-answering system. Based on the retrieved context below, answer the question.

Question: ${question}
Question Date: ${questionDate || "Not specified"}

Retrieved Context:
${retrievedContext}

**Understanding the Context:**
The context contains search results from a memory system. Each result has multiple components you can use:

1. **Memory**: A high-level summary/atomic fact (e.g., "Alex loves hiking in mountains", "John reports to Maria")
   - This is the searchable title/summary of what was stored

2. **Chunks**: The actual detailed raw content where the memory was extracted from
   - Contains conversations, documents, messages, or text excerpts
   - **This is your primary source for detailed information and facts**
   - Look here for specifics, context, quotes, and evidence

3. **Temporal Context** (if present):
   - **Question Date**: The date when the question was asked (provided above). Use this to understand the temporal perspective of the question.
   - **documentDate**: ISO date string for when the content was originally authored/written/said by the user (NOT the system createdAt timestamp). This is the reference point for calculating relative dates. Extract from document metadata, timestamps, or context.
   - **eventDate**: Array of ISO date strings for when the event/fact being referenced actually occurred or will occur. Always provided as an array, even for single dates. For past events use past dates, for future events use future dates. Calculate relative dates (today, yesterday, last week) based on documentDate, NOT the current date.
   - Useful for time-based questions (what happened when, recent vs old info)
   - **Important**: When you see relative terms like "today", "yesterday", calculate them relative to the documentDate, NOT the current date. The question date helps you understand the temporal context of what the user is asking about.

4. **Version**: Shows if a memory has been updated/extended over time

**How to Answer:**
1. Start by scanning memory titles to find relevant results
2. **Read the chunks carefully** - they contain the actual details you need
3. Use temporal context to understand when things happened
4. Synthesize information from multiple results if needed

Instructions:
- First, think through the problem step by step. Show your reasoning process.
- Identify which parts of the context are relevant to answering the question
- Consider temporal relationships, sequences of events, and any updates to information over time
- If the context contains enough information to answer the question, provide a clear, concise answer
- If the context does not contain enough information, respond with "I don't know" or explain what information is missing
- Base your answer ONLY on the provided context
- **Prioritize information from chunks** - they're the raw source material

**Response Format:**
Think step by step, then provide your answer.

Reasoning:
[Your step-by-step reasoning process here]

Answer:
[Your final answer here]`
}

export const SUPERMEMORY_PROMPTS: ProviderPrompts = {
  answerPrompt: buildSupermemoryAnswerPrompt,
}

export default SUPERMEMORY_PROMPTS
