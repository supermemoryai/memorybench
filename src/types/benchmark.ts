import type { UnifiedQuestion, UnifiedSession, QuestionTypeRegistry } from "./unified"
import type { BenchmarkProtocol } from "./protocol"

export interface BenchmarkConfig {
  dataPath?: string
  datasetRevision?: string
  retrievalTopK?: number
  answerCutoff?: number
  evaluationProfile?: string
}

export interface BenchmarkScope {
  displayName: string
  includedTiers: string[]
  coverage: "full" | "subset"
}

export interface DatasetIdentity {
  /** Identity of the exact tier(s) consumed by this benchmark instance. */
  datasetFingerprint: string
  manifestHash: string
  /** Enclosing prepared snapshot provenance; may contain additional unused tiers. */
  snapshotFingerprint?: string
  snapshotManifestHash?: string
  manifestSchemaVersion: number
  canonicalSchemaVersion: number
  converterVersion: string
  converterImplementationHash: string
  includedTiers: string[]
  counts: Record<string, unknown>
  orderedQuestionIdsDigest: Record<string, string>
  sourceFiles: Array<{ path: string; byteSize: number; sha256: string }>
  canonicalFiles: Array<{ path: string; byteSize: number; sha256: string }>
  sources: Array<{
    repository: string
    split: string
    revision: string
    sourceIdentity: "reviewed-published" | "injected-test-fixture"
  }>
}

export interface QuestionFilter {
  /** Filter by raw question type ids (benchmark-specific) */
  questionTypes?: string[]
  limit?: number
  offset?: number
}

export interface Benchmark {
  name: string
  scope: BenchmarkScope
  protocol: BenchmarkProtocol
  load(config?: BenchmarkConfig): Promise<void>
  getQuestions(filter?: QuestionFilter): UnifiedQuestion[]
  getHaystackSessions(questionId: string): UnifiedSession[]
  getGroundTruth(questionId: string): string
  getQuestionTypes(): QuestionTypeRegistry
  getIngestionGroupId?(questionId: string): string
  getDatasetIdentity?(): DatasetIdentity | undefined
}

export type BenchmarkName =
  | "locomo"
  | "longmemeval"
  | "convomem"
  | "beam-1m"
  | "beam-10m"
  | "beam-1m-10m"
