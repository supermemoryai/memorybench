export type LongMemEvalV2ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh"

export function supportsOpenAIReasoning(model: string): boolean {
  return /^(?:gpt-5|o1|o3|o4)/i.test(model.trim())
}

export function openAICompletionControls(
  model: string,
  maxCompletionTokens: number,
  reasoningEffort?: string
): Record<string, string | number> {
  if (supportsOpenAIReasoning(model)) {
    return {
      max_completion_tokens: maxCompletionTokens,
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    }
  }
  return { max_tokens: maxCompletionTokens }
}
