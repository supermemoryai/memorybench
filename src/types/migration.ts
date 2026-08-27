export type BenchmarkDomain = "web" | "enterprise" | string
export type DatasetTier = "small" | "medium" | string

export interface AssetRef {
  assetId: string
  kind: "question-image" | "trajectory-screenshot"
  /** Runtime-only resolved path. It is excluded from persisted identities. */
  absolutePath?: string
  relativePath: string
  mimeType: string
  sha256: string
  byteLength: number
}

export interface DatasetFileManifest {
  relativePath: string
  sha256: string
  byteLength: number
}

export interface DatasetManifest {
  schemaVersion: number
  benchmark: string
  source: string
  revision: string
  dataRoot: string
  tier: DatasetTier
  domain?: BenchmarkDomain
  files: DatasetFileManifest[]
  /** Assets used by this manifest/run. Every entry is content addressed. */
  assets: AssetRef[]
  assetScope?: "selected-run" | "full-dataset"
  assetsFingerprint?: string
  questionOrder: string[]
  trajectoryOrder: string[]
  expectedCounts: {
    questions: number
    trajectories: number
    states: number
    assets: number
    uniqueBuilds: number
  }
  fingerprint: string
}

export type MetadataValue = string | number | boolean | string[]

export interface DocumentSpec {
  logicalDocumentId: string
  content: string
  metadata: Record<string, MetadataValue>
  sourceStateIndices: number[]
  localAttachmentPaths: string[]
  dependsOn: string[]
  allowParallelUpload: boolean
  documentType: string
  stateIndex?: number
  step?: number
  screenshotRef?: AssetRef
  allowDuplicateContent: boolean
}

export interface DocumentPlan {
  trajectoryId: string
  documents: DocumentSpec[]
  batchUpload: boolean
  declaredInvariants: string[]
  notes?: string
}

export interface ValidatedDocument {
  spec: DocumentSpec
  documentOrdinal: number
  contentHash: string
  dependsOnOrdinals: number[]
}

export interface ValidatedDocumentPlan {
  trajectoryId: string
  planHash: string
  documents: ValidatedDocument[]
  batchUpload: boolean
  declaredInvariants: string[]
}

export interface PhysicalDocument {
  trajectoryId: string
  logicalDocumentId: string
  documentOrdinal: number
  partIndex: number
  partCount: number
  content: string
  contentHash: string
  customId: string
  documentType: string
  stateIndex?: number
  step?: number
  screenshotRef?: AssetRef
  metadata: Record<string, MetadataValue>
}

export interface MemoryBuildPlan {
  schemaVersion: number
  buildId: string
  benchmark: string
  provider: string
  datasetFingerprint: string
  tier: DatasetTier
  domain: BenchmarkDomain
  orderedSourceIds: string[]
  sourceContentHashes: string[]
  converter: {
    name: string
    version: number
    sourceHash: string
  }
  providerBuildConfig: Record<string, unknown>
  buildFingerprint: string
  containerTag: string
  documentPlans: ValidatedDocumentPlan[]
  documents: PhysicalDocument[]
}

export interface RetrievalConfig {
  topK: number
  threshold: number
  searchMode: "hybrid" | "memories"
  rerank: boolean
  rewriteQuery: boolean
  includeSummaries: boolean
  includeChunks: boolean
  includeDocuments: boolean
  includeRelatedMemories: boolean
  metadataFilter: Record<string, unknown>
}

export interface NormalizedRetrievalResult {
  rank: number
  score?: number
  kind: string
  text: string
  summary?: string
  chunks: string[]
  providerResultId?: string
  documentIds: string[]
  trajectoryId?: string
  stateIndex?: number
  screenshotRefs: AssetRef[]
  provenanceValid: boolean
}

export interface QueryArtifact {
  schemaVersion: number
  questionId: string
  buildId: string
  buildFingerprint: string
  queryFingerprint: string
  query: string
  questionImage?: AssetRef
  config: RetrievalConfig
  request: Record<string, unknown>
  rawArtifact: { relativePath: string; sha256: string; byteLength: number }
  normalizedArtifact: { relativePath: string; sha256: string; byteLength: number }
  normalizedResults: NormalizedRetrievalResult[]
  remoteDurationMs: number
  wallDurationMs: number
  cacheHit: boolean
  createdAt: string
}

export type ReaderMessagePart =
  | { type: "text"; text: string; provenance?: Record<string, unknown> }
  | {
      type: "image"
      asset: AssetRef
      caption?: string
      provenance?: Record<string, unknown>
    }

export interface ReaderArtifact {
  schemaVersion: number
  questionId: string
  readerFingerprint: string
  model: string
  reasoningEffort?: string
  systemPrompt: string
  parts: ReaderMessagePart[]
  sentAssetIds: string[]
  omittedItems: number
  responseText: string
  parsedAnswer: string
  rawAttempts?: unknown[]
  usage?: Record<string, number>
  durationMs: number
  cacheHit: boolean
  createdAt: string
}

export interface EvaluationArtifact {
  schemaVersion: number
  questionId: string
  evaluatorFingerprint: string
  evalFunction: string
  answer: string
  groundTruth: string
  score: 0 | 1
  label: "correct" | "incorrect"
  evaluatorModel?: string
  promptVersion: string
  implementationVersion: string
  request?: Record<string, unknown>
  rawResponse?: unknown
  rationale?: string
  error?: string
  durationMs: number
  createdAt: string
}

export interface ProviderCapabilities {
  deterministicExternalIds: boolean
  batchUpload: boolean
  documentDependencies: boolean
  ingestionMetadataFilters: boolean
  searchMetadataFilters: boolean
  searchModes: ReadonlyArray<"hybrid" | "memories">
  reranking: boolean
  queryRewriting: boolean
  remoteClear: boolean
  readinessStates: boolean
  mediaIngestion: boolean
  durableLocalPersistence: boolean
  splitPhaseSafe: boolean
}
