export interface LoCoMoBenchmarkItem {
  qa: Array<qaItem>;
  conversation: Record<string, string | sessionItem[]>;
  event_summary: Record<string, Record<string, string | Array<string>>>;
  observation: Record<string, Record<string, Array<Array<string>>>>;
  session_summary: Record<string, string>;
  sample_id: string;
}

export interface qaItem {
  question: string;
  answer?: string | number;           // Regular answer (categories 1-4)
  adversarial_answer?: string;        // Wrong answer to avoid (category 5)
  evidence: Array<string>;
  category: number;
}

export interface sessionItem {
  speaker: string;
  dia_id: string;
  text: string;
  img_url?: Array<string>;
  blip_caption?: string;
  query?: string;
}

export type conversation = Record<string, string | sessionItem[]>;
