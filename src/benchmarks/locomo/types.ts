export interface LoCoMoMessage {
  speaker: string
  dia_id: string
  text: string
  /** Caption of a photo shared in this turn (part of the dataset's conversation text) */
  blip_caption?: string
  img_url?: string[]
}

export interface LoCoMoQA {
  question: string
  /** Missing for category 5 (adversarial) questions */
  answer?: string | number
  /** Category 5 only: the other speaker's fact the question baits */
  adversarial_answer?: string
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
