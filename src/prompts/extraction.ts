import { createOpenAI } from "@ai-sdk/openai"
import { generateText } from "ai"
import type { UnifiedSession } from "../types/unified"

/** Model used for memory extraction (fast, cheap, sufficient for extraction) */
const EXTRACTION_MODEL = "gpt-4o-mini"

/**
 * Build an extraction prompt that instructs the LLM to extract structured
 * memories from a conversation session. Produces MEMORY.md-style markdown
 * with categorized facts, events, preferences, and relationships.
 */
export function buildExtractionPrompt(session: UnifiedSession): string {
  const speakerA = (session.metadata?.speakerA as string) || "Speaker A"
  const speakerB = (session.metadata?.speakerB as string) || "Speaker B"
  const date =
    (session.metadata?.formattedDate as string) ||
    (session.metadata?.date as string) ||
    "Unknown date"

  const conversation = session.messages
    .map((m) => {
      const speaker = m.speaker || m.role
      const ts = m.timestamp ? ` [${m.timestamp}]` : ""
      return `${speaker}${ts}: ${m.content}`
    })
    .join("\n")

  return `You are a memory extraction system. Read the following conversation and extract all important, memorable information into structured markdown. This will be stored as a memory file for later retrieval.

Conversation Date: ${date}
Participants: ${speakerA}, ${speakerB}

<conversation>
${conversation}
</conversation>

Extract memories into the following structured markdown format. Only include sections that have content. Be specific and include names, dates, and details.

## Key Facts
- [Personal details, biographical information, skills, jobs, locations, ages, physical descriptions, etc.]

## Preferences
- [Likes, dislikes, preferences, opinions, favorites, etc.]

## Events
- [${date}]: [Things that happened or were discussed, plans made, activities described]

## Relationships
- [Relationships between people, pets, family members, friends, colleagues, etc.]

## Decisions & Plans
- [Decisions made, future plans, goals, commitments, scheduled events, etc.]

Rules:
- Extract ONLY from what was explicitly stated in the conversation
- Use the speakers' actual names when known, never "the user" or "the assistant"
- Include specific dates, numbers, and proper nouns when mentioned
- Each bullet point should be a self-contained fact (understandable without context)
- For events, always prefix with the date in [brackets]
- Do not invent or infer information that was not stated
- If a section would be empty, omit it entirely
- Keep each bullet concise but complete (one line per fact)
- Resolve relative date references ("yesterday", "last week") to absolute dates using the conversation date when possible`
}

/**
 * Call LLM to extract structured memories from a conversation session.
 * Returns MEMORY.md-style markdown with categorized facts, events, preferences.
 */
export async function extractMemories(
  openai: ReturnType<typeof createOpenAI>,
  session: UnifiedSession
): Promise<string> {
  const prompt = buildExtractionPrompt(session)

  const params: Record<string, unknown> = {
    model: openai(EXTRACTION_MODEL),
    prompt,
    maxTokens: 2000,
    temperature: 0,
  }

  const { text } = await generateText(params as Parameters<typeof generateText>[0])

  return text.trim()
}
