import type { ProviderPrompts } from "./prompts"

export interface JudgeConfig {
  apiKey: string
  model?: string
}

export interface JudgeInput {
  question: string
  /** Raw question type from benchmark (e.g., "1", "single-session-user", "user_evidence") */
  questionType: string
  groundTruth: string
  hypothesis: string
  /**
   * True when the question is unanswerable and the system is expected to abstain.
   * Set by the benchmark, since not every benchmark encodes abstention in `questionType`.
   */
  isAbstention?: boolean
  context?: string
  /** Optional provider-specific judge prompts */
  providerPrompts?: ProviderPrompts
}

export interface JudgeResult {
  score: number
  label: "correct" | "incorrect"
  explanation: string
}

export interface Judge {
  name: string
  initialize(config: JudgeConfig): Promise<void>
  evaluate(input: JudgeInput): Promise<JudgeResult>
  getPromptForQuestionType(questionType: string, providerPrompts?: ProviderPrompts): string
  getModel(): import("ai").LanguageModel
}

export type JudgeName = "openai" | "anthropic" | "google"
