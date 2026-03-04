export interface ConvoMemMessage {
  role: "user" | "assistant"
  content: string
}

export interface ConvoMemSession {
  session_id: string
  messages: ConvoMemMessage[]
}

export interface ConvoMemItem {
  id: string
  question: string
  answer: string
  category: string
  sessions: ConvoMemSession[]
  evidence_session_ids?: string[]
}
