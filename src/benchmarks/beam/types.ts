export type BeamScale = "1M" | "10M"

export const BEAM_SCALES = ["1M", "10M"] as const

export const BEAM_CANONICAL_SCHEMA_VERSION = 3
export const BEAM_MANIFEST_SCHEMA_VERSION = 4
export const BEAM_CONVERTER_VERSION = "1.5.0"

export type BeamSourceIdentity = "reviewed-published" | "injected-test-fixture"

export const BEAM_QUESTION_TYPE_IDS = [
  "abstention",
  "contradiction_resolution",
  "event_ordering",
  "information_extraction",
  "instruction_following",
  "knowledge_update",
  "multi_session_reasoning",
  "preference_following",
  "summarization",
  "temporal_reasoning",
] as const

export type BeamQuestionType = (typeof BEAM_QUESTION_TYPE_IDS)[number]

export interface BeamDatasetSource {
  repository: string
  split: BeamScale
  revision: string
  parquetFiles: Array<{
    path: string
    url: string
    expectedSha256?: string
  }>
}

export interface BeamCanonicalMessage {
  role: "user" | "assistant"
  content: string
  timeAnchor?: string
}

export interface BeamCanonicalSession {
  sessionId: string
  planNumber?: number
  batchNumber: number
  turnIndex: number
  documentDate?: string
  hadInvalidTimeAnchor?: boolean
  hasPaddedAssistant?: true
  messages: BeamCanonicalMessage[]
}

export interface BeamCanonicalChat {
  schemaVersion: number
  scale: BeamScale
  chatId: string
  sessions: BeamCanonicalSession[]
}

export interface BeamCanonicalQuestion {
  schemaVersion: number
  scale: BeamScale
  chatId: string
  questionId: string
  questionType: BeamQuestionType
  question: string
  rubric: string[]
  difficulty?: string
  referenceAnswer?: string
}

export interface BeamSourceFileManifest {
  path: string
  snapshotPath: string
  url: string
  byteSize: number
  sha256: string
}

export interface BeamCanonicalFileManifest {
  path: string
  byteSize: number
  sha256: string
  rowCount: number
}

export interface BeamTierCounts {
  chats: number
  questions: number
  sessions: number
  sessionsWithDocumentDate: number
  sessionsWithoutDocumentDate: number
  sessionsWithInvalidTimeAnchor: number
  sessionsWithPaddedAssistant: number
  byQuestionType: Record<BeamQuestionType, number>
  byChat: Record<
    string,
    {
      sessions: number
      questions: number
      byQuestionType: Record<BeamQuestionType, number>
    }
  >
}

export interface BeamDatasetManifest {
  manifestSchemaVersion: number
  canonicalSchemaVersion: number
  converter: {
    name: "memorybench-beam"
    version: string
    implementationHash: string
  }
  includedTiers: BeamScale[]
  sources: Array<{
    tier: BeamScale
    sourceIdentity: BeamSourceIdentity
    repository: string
    split: BeamScale
    revision: string
    files: BeamSourceFileManifest[]
  }>
  canonicalFiles: BeamCanonicalFileManifest[]
  counts: Partial<Record<BeamScale, BeamTierCounts>>
  orderedChatIds: Partial<Record<BeamScale, string[]>>
  orderedChatIdsDigest: Partial<Record<BeamScale, string>>
  orderedQuestionIds: Partial<Record<BeamScale, string[]>>
  orderedQuestionIdsDigest: Partial<Record<BeamScale, string>>
  datasetFingerprint: string
  manifestHash: string
}

export interface PreparedBeamDataset {
  snapshotPath: string
  manifest: BeamDatasetManifest
  chatsByTier: Partial<Record<BeamScale, BeamCanonicalChat[]>>
  questionsByTier: Partial<Record<BeamScale, BeamCanonicalQuestion[]>>
}

export interface BeamMessage {
  role: "user" | "assistant"
  id?: number
  content: string
  time_anchor?: string
  index?: string
  question_type?: string
  isPaddedAssistant?: true
}

export interface BeamBatch {
  plan_number?: number
  batch_number: number
  time_anchor?: string | null
  turns: BeamMessage[][]
}

export type BeamChatFile = BeamBatch[] | Record<string, BeamBatch[]> | Record<string, BeamBatch[]>[]

export interface BeamProbingQuestion {
  question: string
  rubric: string[]
  difficulty?: string
  answer?: string
  ideal_answer?: string
  ideal_response?: string
  ideal_summary?: string
  [key: string]: unknown
}

export type BeamProbingQuestionsFile = Record<string, BeamProbingQuestion[]>
