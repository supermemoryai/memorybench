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
- Read EVERY observation carefully, including the last ones. Information may appear in ANY observation.
- Extract and synthesize ALL relevant information from ALL observations below.
- If information is mentioned even briefly or indirectly, include it in your answer.
- Infer reasonable answers from the available context. For example, if an observation mentions someone "moved from Sweden 4 years ago", you can answer "Sweden" to "Where did they move from?"
- When listing items (places, people, dates, etc.), scan ALL observations and compile a COMPLETE list. Do not stop after finding a few matches.
- For temporal/date questions, convert relative references ("two weekends ago", "last month") into absolute dates using the conversation timestamps provided.
- For hypothetical or counterfactual questions ("would X still...if..."), reason about what would change under the hypothetical condition.
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
