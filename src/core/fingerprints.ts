import type {
  EvaluationArtifact,
  MemoryBuildPlan,
  QueryArtifact,
  RetrievalConfig,
} from "../types/migration"
import { sha256, stableHash } from "./canonical"

export const FINGERPRINT_SCHEMA_VERSION = 1

export function buildFingerprint(input: {
  benchmark: string
  datasetFingerprint: string
  tier: string
  domain: string
  orderedSourceIds: string[]
  sourceContentHashes: string[]
  converter: { name: string; version: number; sourceHash: string }
  validatedPlanHashes: string[]
  provider: string
  providerBuildConfig: Record<string, unknown>
  documentPlanVersion: number
  splitterVersion: number
}): string {
  return stableHash({ schemaVersion: FINGERPRINT_SCHEMA_VERSION, ...input })
}

export function queryFingerprint(input: {
  buildFingerprint: string
  questionText: string
  questionImageHash?: string
  retrieval: RetrievalConfig
  normalizerVersion: number
}): string {
  return stableHash({
    schemaVersion: FINGERPRINT_SCHEMA_VERSION,
    buildFingerprint: input.buildFingerprint,
    questionTextHash: sha256(input.questionText),
    questionImageHash: input.questionImageHash,
    retrieval: input.retrieval,
    normalizerVersion: input.normalizerVersion,
  })
}

export function readerFingerprint(input: {
  queryArtifact: Pick<QueryArtifact, "queryFingerprint" | "normalizedResults">
  model: string
  settings: Record<string, unknown>
  promptVersion: string
  imageHashes: string[]
  contextBudgetVersion: string
}): string {
  return stableHash({
    schemaVersion: FINGERPRINT_SCHEMA_VERSION,
    queryArtifact: {
      queryFingerprint: input.queryArtifact.queryFingerprint,
      normalizedResults: input.queryArtifact.normalizedResults.map((result) => ({
        ...result,
        screenshotRefs: result.screenshotRefs.map((asset) => ({
          ...asset,
          absolutePath: undefined,
        })),
      })),
    },
    model: input.model,
    settings: input.settings,
    promptVersion: input.promptVersion,
    imageHashes: input.imageHashes,
    contextBudgetVersion: input.contextBudgetVersion,
  })
}

export function evaluatorFingerprint(input: {
  answerArtifactHash: string
  groundTruth: string
  evalFunction: string
  evaluatorModel?: string
  settings: Record<string, unknown>
  promptVersion: string
  implementationVersion: string
}): string {
  return stableHash({ schemaVersion: FINGERPRINT_SCHEMA_VERSION, ...input })
}

export function memoryBuildId(plan: Pick<MemoryBuildPlan, "buildFingerprint">): string {
  return `mb-${plan.buildFingerprint.slice(0, 24)}`
}

export function evaluationArtifactHash(
  artifact: Pick<EvaluationArtifact, "answer" | "evalFunction" | "groundTruth">
): string {
  return stableHash(artifact)
}
