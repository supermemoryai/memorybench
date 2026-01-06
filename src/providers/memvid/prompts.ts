import type { ProviderPrompts } from "../../types/prompts"

interface MemvidResult {
    content?: string
    text?: string
    snippet?: string
    title?: string
    score?: number
    created_at?: string
    [key: string]: unknown
}

function buildMemvidContext(context: unknown[]): string {
    return context.map((item) => {
        const r = item as MemvidResult
        const title = r.title || "Untitled"
        const content = r.snippet || r.text || r.content || JSON.stringify(r)
        return `Title: ${title}\nSnippet: ${content}`
    }).join("\n\n")
}

export function buildMemvidAnswerPrompt(question: string, context: unknown[], questionDate?: string): string {
    const contextStr = buildMemvidContext(context)

    return `Based on the following context from the knowledge base, answer the question.

Context:
${contextStr}

Question: ${question}
Question Date: ${questionDate || "Not provided"}

Answer:`
}

export const MEMVID_PROMPTS: ProviderPrompts = {
    answerPrompt: buildMemvidAnswerPrompt
}
