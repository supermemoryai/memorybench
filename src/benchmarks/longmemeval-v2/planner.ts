import type {
  DatasetManifest,
  MemoryBuildPlan,
  MetadataValue,
  PhysicalDocument,
} from "../../types/migration"
import {
  createPhysicalDocuments,
  DOCUMENT_PLAN_VERSION,
  SPLITTER_VERSION,
  validateDocumentPlan,
} from "../../core/document-plan"
import { buildFingerprint } from "../../core/fingerprints"
import { stableHash } from "../../core/canonical"
import { structuredAccessibilityConverter } from "./converter"
import type { LongMemEvalV2BuildGroup, PreparedTrajectory } from "./types"

export interface LongMemEvalV2BuildPlanningOptions {
  provider: string
  providerBuildConfig: {
    dreaming: "instant"
    rootFilterMode: "self"
    maxDocumentChars: number
    [key: string]: unknown
  }
  containerPrefix?: string
}

function requireIdentifier(value: string, field: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 40) {
    throw new Error(`${field} must match [A-Za-z0-9_-]+ and be <= 40 characters`)
  }
}

export function planLongMemEvalV2Build(input: {
  manifest: DatasetManifest
  group: LongMemEvalV2BuildGroup
  trajectories: Map<string, PreparedTrajectory>
  options: LongMemEvalV2BuildPlanningOptions
}): MemoryBuildPlan {
  const { manifest, group, trajectories, options } = input
  if (manifest.benchmark !== "longmemeval-v2") {
    throw new Error(`Unexpected benchmark manifest: ${manifest.benchmark}`)
  }
  const orderedTrajectories = group.orderedTrajectoryIds.map((trajectoryId) => {
    const trajectory = trajectories.get(trajectoryId)
    if (!trajectory) throw new Error(`Missing prepared trajectory ${trajectoryId}`)
    if (trajectory.domain !== group.domain) {
      throw new Error(`Cross-domain trajectory ${trajectoryId} in ${group.domain} build`)
    }
    return trajectory
  })
  const documentPlans = orderedTrajectories.map((trajectory) => {
    const plan = structuredAccessibilityConverter.convert(trajectory, undefined)
    return validateDocumentPlan({
      plan,
      converter: structuredAccessibilityConverter,
      trajectory,
      context: undefined,
    })
  })
  const sourceContentHashes = orderedTrajectories.map((trajectory) => trajectory.contentHash)
  const fingerprint = buildFingerprint({
    benchmark: "longmemeval-v2",
    datasetFingerprint: manifest.fingerprint,
    tier: group.tier,
    domain: group.domain,
    orderedSourceIds: group.orderedTrajectoryIds,
    sourceContentHashes,
    converter: {
      name: structuredAccessibilityConverter.name,
      version: structuredAccessibilityConverter.version,
      sourceHash: structuredAccessibilityConverter.sourceHash,
    },
    validatedPlanHashes: documentPlans.map((plan) => plan.planHash),
    provider: options.provider,
    providerBuildConfig: options.providerBuildConfig,
    documentPlanVersion: DOCUMENT_PLAN_VERSION,
    splitterVersion: SPLITTER_VERSION,
  })
  const prefix = options.containerPrefix ?? "lme-v2"
  requireIdentifier(prefix, "containerPrefix")
  const haystackHash = stableHash(group.orderedTrajectoryIds)
  const containerTag = `${prefix}-${group.tier}-${group.domain}-${haystackHash.slice(0, 12)}-${fingerprint.slice(0, 12)}`
  if (containerTag.length > 100) throw new Error("Computed container tag exceeds 100 characters")
  const buildId = `mb-${fingerprint.slice(0, 24)}`
  const trajectoryOrder = new Map(
    group.orderedTrajectoryIds.map((trajectoryId, index) => [trajectoryId, index])
  )
  const physicalDocuments = documentPlans.flatMap((plan) =>
    createPhysicalDocuments({
      plan,
      buildFingerprint: fingerprint,
      maxDocumentChars: options.providerBuildConfig.maxDocumentChars,
    })
  )
  const documents = physicalDocuments.map((document): PhysicalDocument => {
    const infrastructure: Record<string, MetadataValue> = {
      benchmark: "longmemeval-v2",
      adapterSchemaVersion: 1,
      buildFingerprint: fingerprint,
      runFingerprint: fingerprint,
      tier: group.tier,
      domain: group.domain,
      haystackHash,
      trajectoryId: document.trajectoryId,
      trajectoryOrder: trajectoryOrder.get(document.trajectoryId)!,
      documentType: document.documentType,
      documentOrdinal: document.documentOrdinal,
      partIndex: document.partIndex,
      partCount: document.partCount,
      contentHash: document.contentHash,
      logicalDocumentId: document.logicalDocumentId,
    }
    if (document.stateIndex !== undefined) infrastructure.stateIndex = document.stateIndex
    if (document.step !== undefined) infrastructure.step = document.step
    if (document.screenshotRef) {
      infrastructure.screenshotPath = document.screenshotRef.relativePath
      infrastructure.screenshotSha256 = document.screenshotRef.sha256
      infrastructure.screenshotMimeType = document.screenshotRef.mimeType
      infrastructure.screenshotByteLength = document.screenshotRef.byteLength
    }
    return {
      ...document,
      metadata: { ...document.metadata, ...infrastructure },
    }
  })
  return {
    schemaVersion: 1,
    buildId,
    benchmark: "longmemeval-v2",
    provider: options.provider,
    datasetFingerprint: manifest.fingerprint,
    tier: group.tier,
    domain: group.domain,
    orderedSourceIds: [...group.orderedTrajectoryIds],
    sourceContentHashes,
    converter: {
      name: structuredAccessibilityConverter.name,
      version: structuredAccessibilityConverter.version,
      sourceHash: structuredAccessibilityConverter.sourceHash,
    },
    providerBuildConfig: { ...options.providerBuildConfig },
    buildFingerprint: fingerprint,
    containerTag,
    documentPlans,
    documents,
  }
}
