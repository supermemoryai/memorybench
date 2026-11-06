import type { ProviderPrompts } from "../../types/prompts"

interface ZepResult {
  _type?: string
  fact?: string
  name?: string
  summary?: string
  valid_at?: string
  invalid_at?: string
}

function buildZepContext(context: unknown[]): string {
  const facts: string[] = []
  const entities: string[] = []

  for (const r of context) {
    const result = r as ZepResult
    const type = result._type

    if (type === "node") {
      const name = result.name || "Unknown"
      const summary = result.summary || ""
      entities.push(`  - ${name}: ${summary}`)
    } else {
      const content = result.fact || JSON.stringify(r)
      const validAt = result.valid_at
      facts.push(`  - ${content} (event_time: ${validAt || "unknown"})`)
    }
  }

  let contextStr = `FACTS and ENTITIES represent relevant context to the current conversation.

# These are the most relevant facts for the conversation along with the datetime of the event that the fact refers to.
# If a fact mentions something happening a week ago, then the datetime will be the date time of last week and not the datetime
# of when the fact was stated.
# Timestamps in memories represent the actual time the event occurred, not the time the event was mentioned in a message.

<FACTS>
${facts.join("\n")}
</FACTS>`

  if (entities.length > 0) {
    contextStr += `

# These are the most relevant entities
# ENTITY_NAME: entity summary
<ENTITIES>
${entities.join("\n")}
</ENTITIES>`
  }

  return contextStr
}

export function buildZepAnswerPrompt(question: string, context: unknown[]): string {
  const contextStr = buildZepContext(context)

  return `# CONTEXT:
You have access to facts and entities from a conversation.

# INSTRUCTIONS:
1. Carefully analyze all provided memories
2. Pay special attention to the timestamps to determine the answer
3. If the question asks about a specific event or fact, look for direct evidence in the memories
4. If the memories contain contradictory information, prioritize the most recent memory
5. Always convert relative time references to specific dates, months, or years.
6. Be as specific as possible when talking about people, places, and events
7. Timestamps in memories represent the actual time the event occurred, not the time the event was mentioned in a message.

Clarification:
When interpreting memories, use the timestamp to determine when the described event happened, not when someone talked about the event.

Example:

Memory: (2023-03-15T16:33:00Z) I went to the vet yesterday.
Question: What day did I go to the vet?
Correct Answer: March 15, 2023
Explanation:
Even though the phrase says "yesterday," the timestamp shows the event was recorded as happening on March 15th. Therefore, the actual vet visit happened on that date, regardless of the word "yesterday" in the text.


# APPROACH (Think step by step):
1. First, examine all memories that contain information related to the question
2. Examine the timestamps and content of these memories carefully
3. Look for explicit mentions of dates, times, locations, or events that answer the question
4. If the answer requires calculation (e.g., converting relative time references), show your work
5. Formulate a precise, concise answer based solely on the evidence in the memories
6. Double-check that your answer directly addresses the question asked
7. Ensure your final answer is specific and avoids vague time references

Context:

${contextStr}

Question: ${question}
Answer:`
}

export const ZEP_PROMPTS: ProviderPrompts = {
  formatContext: buildZepContext,
  answerPrompt: buildZepAnswerPrompt,
}
