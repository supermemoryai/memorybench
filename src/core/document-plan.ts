import { existsSync } from "node:fs"
import type {
  DocumentPlan,
  DocumentSpec,
  MetadataValue,
  PhysicalDocument,
  ValidatedDocumentPlan,
} from "../types/migration"
import { canonicalJson, sha256, stableHash } from "./canonical"

export const DOCUMENT_PLAN_VERSION = 1
export const SPLITTER_VERSION = 1

export const RESERVED_METADATA_KEYS = new Set([
  "benchmark",
  "adapterSchemaVersion",
  "buildFingerprint",
  "runFingerprint",
  "tier",
  "domain",
  "haystackHash",
  "trajectoryId",
  "trajectoryOrder",
  "documentType",
  "stateIndex",
  "step",
  "documentOrdinal",
  "partIndex",
  "partCount",
  "contentHash",
  "screenshotPath",
  "logicalDocumentId",
])

const METADATA_KEY = /^[a-zA-Z0-9_.-]+$/
const LOGICAL_ID = /^[A-Za-z0-9_.:-]+$/
const METADATA_KEY_MAX = 100
const METADATA_VALUE_MAX = 1024

export interface TrajectoryConverter<TTrajectory, TContext> {
  readonly name: string
  readonly version: number
  readonly sourceHash: string
  convert(trajectory: TTrajectory, context: TContext): DocumentPlan
}

function portableDocumentSpec(document: DocumentSpec): unknown {
  return {
    ...document,
    screenshotRef: document.screenshotRef
      ? { ...document.screenshotRef, absolutePath: undefined }
      : undefined,
  }
}

function portableDocumentPlan(plan: DocumentPlan): unknown {
  return {
    ...plan,
    documents: plan.documents.map(portableDocumentSpec),
  }
}

function fail(trajectoryId: string, message: string): never {
  throw new Error(`[trajectory ${trajectoryId}] ${message}`)
}

function validateMetadata(
  trajectoryId: string,
  logicalId: string,
  metadata: Record<string, MetadataValue>
): void {
  for (const [key, value] of Object.entries(metadata)) {
    if (!key || key.length > METADATA_KEY_MAX || !METADATA_KEY.test(key)) {
      fail(
        trajectoryId,
        `${logicalId}: metadata key ${JSON.stringify(key)} must match [a-zA-Z0-9_.-]+ and be <= ${METADATA_KEY_MAX} chars`
      )
    }
    if (RESERVED_METADATA_KEYS.has(key)) {
      fail(trajectoryId, `${logicalId}: metadata key ${key} is reserved`)
    }
    const values = Array.isArray(value) ? value : [value]
    if (Array.isArray(value) && !value.every((item) => typeof item === "string")) {
      fail(trajectoryId, `${logicalId}: metadata arrays may contain only strings`)
    }
    if (
      values.some(
        (item) =>
          !["string", "number", "boolean"].includes(typeof item) ||
          (typeof item === "string" && item.length > METADATA_VALUE_MAX) ||
          (typeof item === "number" && !Number.isFinite(item))
      )
    ) {
      fail(trajectoryId, `${logicalId}: unsupported metadata value for ${key}`)
    }
  }
}

function topologicalOrder(trajectoryId: string, documents: DocumentSpec[]): number[] {
  const indexes = new Map(documents.map((document, index) => [document.logicalDocumentId, index]))
  const degrees = documents.map(() => 0)
  const dependents = documents.map(() => [] as number[])
  for (const [index, document] of documents.entries()) {
    for (const dependency of document.dependsOn) {
      const dependencyIndex = indexes.get(dependency)
      if (dependencyIndex === undefined) {
        fail(trajectoryId, `${document.logicalDocumentId}: dependency ${dependency} does not exist`)
      }
      degrees[index] += 1
      dependents[dependencyIndex].push(index)
    }
  }
  const ready = degrees
    .map((degree, index) => ({ degree, index }))
    .filter(({ degree }) => degree === 0)
    .map(({ index }) => index)
  const order: number[] = []
  while (ready.length > 0) {
    ready.sort((a, b) => a - b)
    const index = ready.shift()!
    order.push(index)
    for (const dependent of dependents[index]) {
      degrees[dependent] -= 1
      if (degrees[dependent] === 0) ready.push(dependent)
    }
  }
  if (order.length !== documents.length) {
    const cyclic = documents
      .filter((_, index) => degrees[index] > 0)
      .map((document) => document.logicalDocumentId)
    fail(trajectoryId, `dependency graph contains a cycle involving ${cyclic.join(", ")}`)
  }
  return order
}

export function validateDocumentPlan<TTrajectory, TContext>(input: {
  plan: DocumentPlan
  converter: TrajectoryConverter<TTrajectory, TContext>
  trajectory: TTrajectory
  context: TContext
  checkDeterminism?: boolean
}): ValidatedDocumentPlan {
  const { plan, converter, trajectory, context, checkDeterminism = true } = input
  const trajectoryId = plan.trajectoryId
  if (!trajectoryId) fail("<unknown>", "trajectoryId is required")
  if (plan.documents.length === 0) fail(trajectoryId, "plan contains no documents")
  if (plan.batchUpload && plan.documents.some((document) => document.dependsOn.length > 0)) {
    fail(trajectoryId, "batch-upload plans cannot declare dependencies")
  }

  const ids = new Set<string>()
  const contentIds = new Map<string, string>()
  for (const document of plan.documents) {
    const id = document.logicalDocumentId
    if (!id || !LOGICAL_ID.test(id)) {
      fail(trajectoryId, `invalid logicalDocumentId ${JSON.stringify(id)}`)
    }
    if (ids.has(id)) fail(trajectoryId, `duplicate logicalDocumentId ${id}`)
    ids.add(id)
    if (!document.content.trim()) fail(trajectoryId, `${id}: content must not be empty`)
    if (new Set(document.dependsOn).size !== document.dependsOn.length) {
      fail(trajectoryId, `${id}: duplicate dependency`)
    }
    if (document.dependsOn.includes(id)) fail(trajectoryId, `${id}: self dependency`)
    if (
      document.stateIndex !== undefined &&
      (!Number.isInteger(document.stateIndex) || document.stateIndex < 0)
    ) {
      fail(trajectoryId, `${id}: stateIndex must be an integer >= 0`)
    }
    if (document.step !== undefined && (!Number.isInteger(document.step) || document.step < 0)) {
      fail(trajectoryId, `${id}: step must be an integer >= 0`)
    }
    validateMetadata(trajectoryId, id, document.metadata)
    for (const attachment of document.localAttachmentPaths) {
      if (!existsSync(attachment)) fail(trajectoryId, `${id}: missing attachment ${attachment}`)
    }
    if (
      document.screenshotRef &&
      (!document.screenshotRef.absolutePath || !existsSync(document.screenshotRef.absolutePath))
    ) {
      fail(
        trajectoryId,
        `${id}: missing screenshot ${document.screenshotRef.absolutePath ?? "(unresolved)"}`
      )
    }
    const contentHash = sha256(document.content)
    const earlier = contentIds.get(contentHash)
    if (earlier && !document.allowDuplicateContent) {
      fail(trajectoryId, `${id}: content duplicates ${earlier}`)
    }
    if (!earlier) contentIds.set(contentHash, id)
  }

  for (const document of plan.documents) {
    for (const dependency of document.dependsOn) {
      if (!ids.has(dependency)) {
        fail(trajectoryId, `${document.logicalDocumentId}: unknown dependency ${dependency}`)
      }
    }
  }

  if (checkDeterminism) {
    const repeated = converter.convert(trajectory, context)
    if (
      canonicalJson(portableDocumentPlan(repeated)) !== canonicalJson(portableDocumentPlan(plan))
    ) {
      fail(trajectoryId, `${converter.name} produced non-deterministic output`)
    }
  }

  const order = topologicalOrder(trajectoryId, plan.documents)
  const ordinalByOriginalIndex = new Map(
    order.map((originalIndex, ordinal) => [originalIndex, ordinal])
  )
  const indexById = new Map(
    plan.documents.map((document, index) => [document.logicalDocumentId, index])
  )
  const documents = order.map((originalIndex, documentOrdinal) => {
    const spec = plan.documents[originalIndex]
    return {
      spec,
      documentOrdinal,
      contentHash: sha256(spec.content),
      dependsOnOrdinals: spec.dependsOn
        .map((id) => ordinalByOriginalIndex.get(indexById.get(id)!)!)
        .sort((a, b) => a - b),
    }
  })
  return {
    trajectoryId,
    planHash: stableHash(portableDocumentPlan(plan)),
    documents,
    batchUpload: plan.batchUpload,
    declaredInvariants: [...plan.declaredInvariants],
  }
}

export function splitContent(content: string, maxChars: number): string[] {
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new Error("maxChars must be an integer >= 1")
  }
  if (content.length <= maxChars) return [content]
  const parts: string[] = []
  let remaining = content
  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars + 1)
    let cut = -1
    for (const marker of ["\n\n", "\n", " "]) {
      const candidate = window.lastIndexOf(marker, maxChars)
      if (candidate >= Math.max(1, Math.floor(maxChars / 2))) {
        cut = candidate + marker.length
        break
      }
    }
    if (cut <= 0 || cut > maxChars) cut = maxChars
    parts.push(remaining.slice(0, cut))
    remaining = remaining.slice(cut)
  }
  if (remaining) parts.push(remaining)
  if (parts.some((part) => part.length === 0 || part.length > maxChars)) {
    throw new Error("splitter produced an invalid part")
  }
  if (parts.join("") !== content) throw new Error("splitter reassembly mismatch")
  return parts
}

export function createPhysicalDocuments(input: {
  plan: ValidatedDocumentPlan
  buildFingerprint: string
  maxDocumentChars: number
}): PhysicalDocument[] {
  const { plan, buildFingerprint, maxDocumentChars } = input
  const output: PhysicalDocument[] = []
  for (const document of plan.documents) {
    const parts = splitContent(document.spec.content, maxDocumentChars)
    if (plan.batchUpload && parts.length > 1) {
      fail(
        plan.trajectoryId,
        `${document.spec.logicalDocumentId}: a batch document cannot be split`
      )
    }
    parts.forEach((content, partIndex) => {
      const contentHash = sha256(content)
      const customId = `lme2-${sha256(
        canonicalJson({
          buildFingerprint,
          trajectoryId: plan.trajectoryId,
          documentOrdinal: document.documentOrdinal,
          partIndex,
        })
      ).slice(0, 56)}`
      output.push({
        trajectoryId: plan.trajectoryId,
        logicalDocumentId: document.spec.logicalDocumentId,
        documentOrdinal: document.documentOrdinal,
        partIndex,
        partCount: parts.length,
        content,
        contentHash,
        customId,
        documentType: document.spec.documentType,
        stateIndex: document.spec.stateIndex,
        step: document.spec.step,
        screenshotRef: document.spec.screenshotRef,
        metadata: { ...document.spec.metadata },
      })
    })
  }
  return output
}
