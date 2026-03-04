import type { ProviderPrompts } from "../../types/prompts"

/**
 * Custom prompts for Anamnesis provider.
 *
 * These prompts help the answering model understand how to interpret
 * the search results format from Anamnesis (observations with narratives).
 */
export const ANAMNESIS_PROMPTS: ProviderPrompts = {
    answerPrompt: (question: string, context: unknown[], questionDate?: string): string => {
        const observations = context as Array<{
            id: string
            content: string
            score: number
            metadata?: {
                title?: string
                created_at?: string
            }
        }>

        let contextStr = "No relevant memories found."
        if (observations && observations.length > 0) {
            contextStr = observations
                .map((obs, i) => {
                    const header = obs.metadata?.title || `Memory ${obs.id}`
                    const date = obs.metadata?.created_at
                        ? ` (${new Date(obs.metadata.created_at).toLocaleDateString()})`
                        : ""
                    return `### ${i + 1}. ${header}${date}\n${obs.content}`
                })
                .join("\n\n---\n\n")
        }

        const dateContext = questionDate ? `\nQuestion date context: ${questionDate}` : ""

        return `You are answering questions based on retrieved memory observations.
Each observation represents a structured memory unit with narratives and facts.

IMPORTANT INSTRUCTIONS:
- Extract and synthesize ALL relevant information from the observations below.
- If information is mentioned even briefly or indirectly, include it in your answer.
- Infer reasonable answers from the available context. For example, if an observation mentions someone "moved from Sweden 4 years ago", you can answer "Sweden" to "Where did they move from?"
- Be thorough: list ALL items, dates, names, and details mentioned in the observations.
- Only say you lack information if the observations contain absolutely nothing relevant.
- Answer concisely and directly — state the facts without hedging.
${dateContext}

## Retrieved Memories

${contextStr}

## Question

${question}

## Answer

`
    }
}
