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
- Read EVERY observation carefully, including the last ones. Information may appear in ANY observation, even the lowest-ranked ones.
- Extract and synthesize ALL relevant information from ALL observations below.
- If information is mentioned even briefly or indirectly, include it in your answer.
- Infer reasonable answers from the available context. For example, if an observation mentions someone "moved from Sweden 4 years ago", you can answer "Sweden" to "Where did they move from?"
- When listing items (places, people, dates, etc.), scan ALL observations and compile a COMPLETE list. After your first pass, RESCAN all observations to verify you haven't missed anything. Items are often mentioned casually in unrelated conversations.
- For temporal/date questions: use the conversation date headers to anchor relative references ("last Saturday", "two weekends ago"). Keep answers at the same level of precision as the evidence — if the evidence only implies a month (e.g. "June 2023"), answer with the month, not an exact date. When a question asks "when is X planning to..." answer with the future timeframe mentioned, not when it actually happened later. When the evidence says "last Saturday" or "last Friday", prefer expressing the answer as "the [day] before [conversation date]" rather than computing a specific calendar date.
- For hypothetical or counterfactual questions ("would X still...if..."), reason about what would change under the hypothetical condition.
- Use the EXACT terms and descriptions from the observations. If someone says "abstract art", answer "abstract art" — don't paraphrase to "paintings and drawings".
- When asked about specific items (books, pottery types, art styles, locations), look for NAMES and TYPES explicitly mentioned in the text. If someone says "we made bowls and a cup", include both "bowls" and "cup".
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
