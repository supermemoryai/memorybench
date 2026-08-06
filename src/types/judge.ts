import type { ProviderPrompts } from "./prompts"
import type { ModelTransport } from "./protocol"

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
  context?: string
  /** Optional provider-specific judge prompts */
  providerPrompts?: ProviderPrompts
}

export interface JudgeResult {
  score: number
  label: "correct" | "incorrect"
  explanation: string
  details?: Record<string, unknown>
}

export interface Judge {
  name: string
  initialize(config: JudgeConfig): Promise<void>
  evaluate(input: JudgeInput): Promise<JudgeResult>
  getPromptForQuestionType(questionType: string, providerPrompts?: ProviderPrompts): string
  getModel(transport?: ModelTransport): import("ai").LanguageModel
}

export type JudgeName = "openai" | "anthropic" | "google"
