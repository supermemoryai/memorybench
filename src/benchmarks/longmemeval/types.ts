export interface LongMemEvalMessage {
  role: "user" | "assistant"
  content: string
  has_answer?: boolean
}

export interface LongMemEvalItem {
  question_id: string
  question: string
  answer: string
  question_type: string
  question_date?: string
  haystack_dates: string[]
  haystack_sessions: LongMemEvalMessage[][]
}
