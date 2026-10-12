export type JudgePromptResult = Record<string, string> & { default: string }
export type JudgePromptFunction = (
  question: string,
  groundTruth: string,
  hypothesis: string
) => JudgePromptResult

export interface ProviderPrompts {
  answerPrompt?: string | ((question: string, context: unknown[], questionDate?: string) => string)
  judgePrompt?: JudgePromptFunction
  /** Renders search results as text for benchmarks that supply their own answer prompt */
  formatContext?: (context: unknown[]) => string
}

export function buildContextString(context: unknown[]): string {
  return JSON.stringify(context, null, 2)
}
