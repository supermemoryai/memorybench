import type { LanguageModel } from "ai"
import type { UnifiedQuestion, UnifiedSession, QuestionTypeRegistry } from "./unified"
import type { JudgeResult } from "./judge"

export interface BenchmarkJudgeInput {
  question: UnifiedQuestion
  hypothesis: string
}

export interface BenchmarkConfig {
  dataPath?: string
}

export interface QuestionFilter {
  /** Filter by raw question type ids (benchmark-specific) */
  questionTypes?: string[]
  limit?: number
  offset?: number
}

export interface Benchmark {
  name: string
  load(config?: BenchmarkConfig): Promise<void>
  getQuestions(filter?: QuestionFilter): UnifiedQuestion[]
  getHaystackSessions(questionId: string): UnifiedSession[]
  getGroundTruth(questionId: string): string
  getQuestionTypes(): QuestionTypeRegistry
  /** Questions with the same key share one haystack and one container (default: one per question) */
  getContainerKey?(questionId: string): string
  /** Question types left out of the comparable headline score (still reported per type) */
  headlineExcludedTypes?: string[]
  /** Results requested per search (default 10) */
  searchLimit?: number
  /** Standard answer prompt for this benchmark; takes priority over provider prompts so runs stay comparable */
  buildAnswerPrompt?(question: UnifiedQuestion, context: string, results?: unknown[]): string
  /** Answer rules for agentic answering, so agent answers follow the same format as the standard prompt */
  agentRules?(question: UnifiedQuestion): string
  /** Benchmark-owned scoring with the judge model, for scores other than right/wrong */
  evaluateAnswer?(
    question: UnifiedQuestion,
    hypothesis: string,
    model: LanguageModel
  ): Promise<JudgeResult>
  /** Standard judge prompt for this benchmark; takes priority over provider and default judge prompts */
  buildJudgePrompt?(input: BenchmarkJudgeInput): string
}

export type BenchmarkName = "locomo" | "longmemeval" | "convomem" | "beam"
