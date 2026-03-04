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

export function buildZepJudgePrompt(question: string, groundTruth: string, hypothesis: string) {
  const prompt = `Your task is to label an answer to a question as 'CORRECT' or 'WRONG'. You will be given the following data:
    (1) a question (posed by one user to another user),
    (2) a 'gold' (ground truth) answer,
    (3) a generated answer
which you will score as CORRECT/WRONG.

The point of the question is to ask about something one user should know about the other user based on their prior conversations.
The gold answer will usually be a concise and short answer that includes the referenced topic, for example:
Question: Do you remember what I got the last time I went to Hawaii?
Gold answer: A shell necklace
The generated answer might be much longer, but you should be generous with your grading - as long as it touches on the same topic as the gold answer, it should be counted as CORRECT.

For time related questions, the gold answer will be a specific date, month, year, etc. The generated answer might be much longer or use relative time references (like "last Tuesday" or "next month"), but you should be generous with your grading - as long as it refers to the same date or time period as the gold answer, it should be counted as CORRECT. Even if the format differs (e.g., "May 7th" vs "7 May"), consider it CORRECT if it's the same date.

Now it's time for the real question:
Question: ${question}
Gold answer: ${groundTruth}
Generated answer: ${hypothesis}

First, provide a short (one sentence) explanation of your reasoning, then respond with ONLY a JSON object:
{"score": 1, "label": "correct", "explanation": "..."} if the response contains the correct answer
{"score": 0, "label": "incorrect", "explanation": "..."} if the response does not contain the correct answer

Do NOT include both labels in your response.`

  return { default: prompt }
}

export const ZEP_PROMPTS: ProviderPrompts = {
  answerPrompt: buildZepAnswerPrompt,
  judgePrompt: buildZepJudgePrompt,
}
