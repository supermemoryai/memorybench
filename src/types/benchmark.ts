import type { UnifiedQuestion, UnifiedSession, QuestionTypeRegistry } from "./unified"

export interface BenchmarkConfig {
  dataPath?: string
}

export interface QuestionFilter {
  /** Filter by raw question type ids (benchmark-specific) */
  questionTypes?: string[]
  limit?: number
  offset?: number
  /** Stratified sampling: N questions per conversation (spreads across all convs) */
  stratifyPerConv?: number
  /** Only include questions from these conversation/sample IDs */
  sampleIds?: string[]
}

export interface Benchmark {
  name: string
  load(config?: BenchmarkConfig): Promise<void>
  getQuestions(filter?: QuestionFilter): UnifiedQuestion[]
  getHaystackSessions(questionId: string): UnifiedSession[]
  getGroundTruth(questionId: string): string
  getQuestionTypes(): QuestionTypeRegistry
}

export type BenchmarkName = "locomo" | "longmemeval" | "convomem"
