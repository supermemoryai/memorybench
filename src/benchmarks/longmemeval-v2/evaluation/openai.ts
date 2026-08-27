import type { StrictJudgeCallback, StrictJudgeRequest } from "./judges"
import { openAICompletionControls } from "../openai-model"

export interface OpenAIStrictJudgeOptions {
  apiKey: string
  baseUrl?: string
  timeoutMs?: number
  maxAttempts?: number
}

export function createOpenAIStrictJudge(options: OpenAIStrictJudgeOptions): StrictJudgeCallback {
  if (!options.apiKey) throw new Error("OPENAI_API_KEY is required for strict LLM evaluation")
  return async (request: StrictJudgeRequest) => {
    let lastError: Error | undefined
    for (let attempt = 1; attempt <= (options.maxAttempts ?? 5); attempt += 1) {
      const controller = new AbortController()
      const timeout = setTimeout(
        () => controller.abort(new Error("Evaluator request timed out")),
        options.timeoutMs ?? 10 * 60 * 1000
      )
      try {
        const response = await fetch(
          `${(options.baseUrl ?? "https://api.openai.com").replace(/\/$/, "")}/v1/chat/completions`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${options.apiKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model: request.model,
              messages: request.messages,
              ...openAICompletionControls(
                request.model ?? "gpt-5",
                request.maxCompletionTokens ?? 2048,
                request.reasoningEffort
              ),
              ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
              ...(request.topP !== undefined ? { top_p: request.topP } : {}),
            }),
            signal: controller.signal,
          }
        )
        const raw = (await response.json().catch(() => null)) as Record<string, unknown> | null
        if (!response.ok) {
          const retryable = response.status === 429 || response.status >= 500
          if (!retryable) throw new Error(`Evaluator HTTP ${response.status}`)
          lastError = new Error(`Evaluator HTTP ${response.status}`)
        } else {
          const choices = raw?.choices as Array<Record<string, unknown>> | undefined
          const message = choices?.[0]?.message as Record<string, unknown> | undefined
          const content = message?.content
          let text = typeof content === "string" ? content.trim() : ""
          if (!text && Array.isArray(content)) {
            text = content
              .map((part) =>
                part && typeof part === "object" && typeof part.text === "string" ? part.text : ""
              )
              .filter(Boolean)
              .join("\n")
              .trim()
          }
          if (text) return { text, rawResponse: raw }
          lastError = new Error("Evaluator returned empty content")
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
      } finally {
        clearTimeout(timeout)
      }
      if (attempt < (options.maxAttempts ?? 5)) {
        await Bun.sleep(Math.min(1000 * 2 ** (attempt - 1), 8000))
      }
    }
    throw lastError ?? new Error("Evaluator failed")
  }
}
