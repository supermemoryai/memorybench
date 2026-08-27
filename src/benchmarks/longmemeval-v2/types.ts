import type { AssetRef } from "../../types/migration"

export type LongMemEvalV2Domain = "web" | "enterprise"
export type LongMemEvalV2Tier = "small" | "medium"

export interface LongMemEvalV2Question {
  id: string
  domain: LongMemEvalV2Domain
  environment: string
  question_type: string
  question: string
  image: string | null
  answer: string
  eval_function: string
}

export interface LongMemEvalV2State {
  state_index?: number
  step?: number
  url: string
  action: string | null
  thought?: string | null
  thoughts?: string | null
  accessibility_tree?: string
  text?: string
  screenshot: string
}

export interface LongMemEvalV2Trajectory {
  id: string
  domain: LongMemEvalV2Domain
  goal: string
  start_url: string
  outcome: string | null
  states: LongMemEvalV2State[]
}

export interface PreparedTrajectoryState {
  stateIndex: number
  step: number
  url: string
  action: string | null
  thoughts: string | null
  accessibilityTree: string
  screenshot: AssetRef
}

export interface PreparedTrajectory {
  id: string
  domain: LongMemEvalV2Domain
  goal: string
  startUrl: string
  outcome: string | null
  states: PreparedTrajectoryState[]
  contentHash: string
}

export interface LongMemEvalV2QuestionPlan {
  question: LongMemEvalV2Question
  questionImage?: AssetRef
  orderedTrajectoryIds: string[]
  haystackHash: string
  buildKey: string
}

export interface LongMemEvalV2BuildGroup {
  buildKey: string
  domain: LongMemEvalV2Domain
  tier: LongMemEvalV2Tier
  orderedTrajectoryIds: string[]
  questionIds: string[]
}
