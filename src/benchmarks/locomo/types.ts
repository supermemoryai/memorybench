export interface LoCoMoMessage {
  speaker: string
  dia_id: string
  text: string
}

export interface LoCoMoQA {
  question: string
  answer: string | number
  evidence: string[]
  category: number
}

export interface LoCoMoConversation {
  speaker_a: string
  speaker_b: string
  [key: string]: string | LoCoMoMessage[] | undefined
}

export interface LoCoMoItem {
  sample_id: string
  qa: LoCoMoQA[]
  conversation: LoCoMoConversation
  event_summary: Record<string, unknown>
  observation: Record<string, unknown>
  session_summary: Record<string, unknown>
}
