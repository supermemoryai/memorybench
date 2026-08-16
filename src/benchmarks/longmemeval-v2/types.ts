export interface LongMemEvalV2Question {
  id: string
  domain: string
  environment: string
  question_type: string
  question: string
  image?: string | null
  answer: string
  eval_function?: string
}

export interface LongMemEvalV2State {
  state_index: number
  step?: number
  url?: string
  action?: string | null
  thought?: string | null
  accessibility_tree?: string | null
  screenshot?: string | null
}

export interface LongMemEvalV2Trajectory {
  id: string
  domain: string
  environment: string
  goal: string
  outcome?: string
  start_url?: string
  states: LongMemEvalV2State[]
}
