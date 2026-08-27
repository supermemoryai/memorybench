import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { readFile, readdir, realpath, stat } from "node:fs/promises"
import { basename, isAbsolute, parse, relative, resolve, sep } from "node:path"
import type {
  BuildAwareQuestionCheckpoint,
  BuildAwareReport,
  BuildAwareRunCheckpoint,
} from "../../types/build-aware"
import type { AssetRef } from "../../types/migration"
import { isRunActive } from "../runState"

const MAX_JSON_ARTIFACT_BYTES = 8 * 1024 * 1024
const MAX_IMAGE_ASSET_BYTES = 25 * 1024 * 1024
const SAFE_RUN_ID = /^[A-Za-z0-9_-]{1,100}$/
const SAFE_ENTITY_ID = /^[A-Za-z0-9._:-]{1,200}$/
const ARTIFACT_KINDS = new Set(["query-raw", "query-normalized", "reader", "evaluation"])
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

export interface BuildAwareInspectionRouteOptions {
  runsRoot?: string
  buildsRoot?: string
  artifactsRoot?: string
}

interface ArtifactDescriptor {
  relativePath: string
  sha256?: string
  byteLength?: number
}

interface ResolvedBuildLink {
  status: "available" | "missing" | "rejected"
  scope?: "run" | "builds"
  relativePath?: string
  absolutePath?: string
  reason?: string
}

interface BuildPlanSummary {
  buildId: string
  buildFingerprint: string
  containerTag?: string
  provider?: string
  domain?: string
  trajectoryCount?: number
  documentCount?: number
}

interface ReferencedAsset {
  asset: AssetRef
  scope: "dataset" | "artifacts"
}

interface PublicControlHistory {
  schemaVersion: 1
  runId: string
  events: Array<{
    action: string
    at?: string
    through?: string
    message?: string
  }>
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function isInside(root: string, target: string): boolean {
  const fromRoot = relative(root, target)
  return (
    fromRoot === "" ||
    (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
  )
}

async function resolveExistingFileWithin(root: string, candidate: string): Promise<string | null> {
  const rootAbsolute = resolve(root)
  const targetAbsolute = resolve(rootAbsolute, candidate)
  if (!isInside(rootAbsolute, targetAbsolute)) return null

  try {
    const [rootReal, targetReal] = await Promise.all([
      realpath(rootAbsolute),
      realpath(targetAbsolute),
    ])
    if (!isInside(rootReal, targetReal)) return null
    const metadata = await stat(targetReal)
    return metadata.isFile() ? targetReal : null
  } catch {
    return null
  }
}

function imageSignatureMatches(bytes: Buffer, mimeType: string): boolean {
  if (mimeType === "image/png") {
    return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  }
  if (mimeType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8
  if (mimeType === "image/gif") {
    const signature = bytes.subarray(0, 6).toString("ascii")
    return signature === "GIF87a" || signature === "GIF89a"
  }
  if (mimeType === "image/webp") {
    return (
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP"
    )
  }
  return false
}

function referencedAssets(question: BuildAwareQuestionCheckpoint): ReferencedAsset[] {
  const assets: ReferencedAsset[] = []
  const add = (asset: AssetRef | undefined, scope: ReferencedAsset["scope"]): void => {
    if (!asset || typeof asset.assetId !== "string") return
    assets.push({ asset, scope })
  }
  add(question.queryArtifact?.questionImage, "dataset")
  for (const result of question.queryArtifact?.normalizedResults ?? []) {
    for (const asset of result.screenshotRefs) add(asset, "dataset")
  }
  for (const part of question.readerArtifact?.parts ?? []) {
    if (part.type === "image") add(part.asset, "artifacts")
  }
  return assets
}

async function verifiedImageAsset(root: string, asset: AssetRef): Promise<Buffer> {
  if (
    !asset.relativePath ||
    isAbsolute(asset.relativePath) ||
    asset.relativePath.includes("\0") ||
    asset.relativePath.includes("\\") ||
    !IMAGE_MIME_TYPES.has(asset.mimeType) ||
    !Number.isInteger(asset.byteLength) ||
    asset.byteLength < 1 ||
    asset.byteLength > MAX_IMAGE_ASSET_BYTES ||
    !/^[a-f0-9]{64}$/.test(asset.sha256)
  ) {
    throw new Error("Referenced image metadata is invalid")
  }
  const path = await resolveExistingFileWithin(root, asset.relativePath)
  if (!path) throw new Error("Referenced image is missing or outside its recorded root")
  const metadata = await stat(path)
  if (metadata.size !== asset.byteLength) throw new Error("Referenced image size does not match")
  const bytes = await readFile(path)
  if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
    throw new Error("Referenced image hash does not match")
  }
  if (!imageSignatureMatches(bytes, asset.mimeType)) {
    throw new Error("Referenced image bytes do not match the recorded MIME type")
  }
  return bytes
}

async function loadControlHistory(runRoot: string, runId: string): Promise<PublicControlHistory> {
  const empty: PublicControlHistory = { schemaVersion: 1, runId, events: [] }
  const path = await resolveExistingFileWithin(runRoot, "control.json")
  if (!path) return empty
  try {
    const history = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
    if (history.schemaVersion !== 1 || history.runId !== runId || !Array.isArray(history.events)) {
      return empty
    }
    return sanitizeForResponse({
      ...history,
      events: history.events.slice(-100),
    }) as PublicControlHistory
  } catch {
    return empty
  }
}

function validateRunId(runId: string): boolean {
  return SAFE_RUN_ID.test(runId)
}

function validateEntityId(id: string): boolean {
  return SAFE_ENTITY_ID.test(id)
}

function sanitizeForResponse(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\b(?:sk|sm)_[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]")
  }
  if (Array.isArray(value)) return value.map(sanitizeForResponse)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "absolutePath")
        .map(([key, item]) => [
          key,
          /^(?:api[-_]?key|authorization|token|secret|password|credential|tokenValue|accessToken|refreshToken|.*[-_]token)$/i.test(
            key
          )
            ? "[REDACTED]"
            : sanitizeForResponse(item),
        ])
    )
  }
  return value
}

function publicCheckpoint(
  checkpoint: BuildAwareRunCheckpoint,
  storageRoots: {
    artifacts: "available" | "missing" | "rejected"
    builds: "available" | "missing" | "rejected"
  },
  uiManaged = false
) {
  const {
    buildLinks: _privateBuildLinks,
    datasetManifestPath: _privateManifestPath,
    artifactRoot: _privateArtifactRoot,
    buildRoot: _privateBuildRoot,
    ...safeCheckpoint
  } = checkpoint
  return {
    ...safeCheckpoint,
    ...(safeCheckpoint.status === "running" && uiManaged && !isRunActive(safeCheckpoint.runId)
      ? {
          status: "failed" as const,
          error: "Run process is no longer active; resume from the durable checkpoint",
        }
      : {}),
    config: {
      ...safeCheckpoint.config,
      datasetPath: isAbsolute(safeCheckpoint.config.datasetPath)
        ? basename(safeCheckpoint.config.datasetPath)
        : safeCheckpoint.config.datasetPath,
    },
    questionBuildLinks: Object.fromEntries(
      Object.entries(checkpoint.buildLinks).filter(
        ([questionId, buildId]) => validateEntityId(questionId) && validateEntityId(buildId)
      )
    ),
    buildLinkCount: Object.keys(checkpoint.buildLinks).length,
    storageRoots,
  }
}

async function loadCheckpoint(
  runsRoot: string,
  runId: string
): Promise<{ checkpoint: BuildAwareRunCheckpoint; runRoot: string } | null> {
  if (!validateRunId(runId)) return null
  const runRoot = resolve(runsRoot, runId)
  try {
    const [runsRootReal, runRootReal] = await Promise.all([realpath(runsRoot), realpath(runRoot)])
    if (!isInside(runsRootReal, runRootReal)) return null
  } catch {
    return null
  }
  const checkpointPath = await resolveExistingFileWithin(runRoot, "checkpoint.json")
  if (!checkpointPath) return null

  const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8")) as BuildAwareRunCheckpoint
  if (
    checkpoint.schemaVersion !== 1 ||
    checkpoint.executionModel !== "shared-memory-build-v1" ||
    checkpoint.runId !== runId ||
    !checkpoint.questions ||
    !checkpoint.config
  ) {
    throw new Error(`Invalid build-aware checkpoint for run ${runId}`)
  }
  return { checkpoint, runRoot }
}

async function loadReport(runRoot: string, runId: string): Promise<BuildAwareReport | null> {
  for (const relativePath of ["report.json", "reports/report.json"]) {
    const reportPath = await resolveExistingFileWithin(runRoot, relativePath)
    if (!reportPath) continue
    const report = JSON.parse(await readFile(reportPath, "utf8")) as BuildAwareReport
    if (
      report.schemaVersion !== 1 ||
      report.protocol !== "longmemeval-v2-official" ||
      report.runId !== runId
    ) {
      throw new Error(`Invalid build-aware report for run ${runId}`)
    }
    return report
  }
  return null
}

export async function listBuildAwareRunSummaries(
  runsRoot = "data/runs-v2"
): Promise<Array<Record<string, unknown>>> {
  let entries
  try {
    entries = await readdir(resolve(runsRoot), { withFileTypes: true })
  } catch {
    return []
  }
  const summaries = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && validateRunId(entry.name))
      .map(async (entry) => {
        try {
          const loaded = await loadCheckpoint(runsRoot, entry.name)
          if (!loaded) return null
          const { checkpoint, runRoot } = loaded
          const report = await loadReport(runRoot, checkpoint.runId)
          const control = await loadControlHistory(runRoot, checkpoint.runId)
          const uiManaged = control.events.some(
            (event) => event.action === "start" || event.action === "resume"
          )
          const questions = Object.values(checkpoint.questions)
          const queryCompleted = questions.filter(
            (question) => question.stages.query.status === "completed"
          ).length
          const readCompleted = questions.filter(
            (question) => question.stages.read.status === "completed"
          ).length
          const evaluateCompleted = questions.filter(
            (question) => question.stages.evaluate.status === "completed"
          ).length
          const buildFinished =
            checkpoint.status === "completed" ||
            ["query", "read", "evaluate", "report"].includes(checkpoint.currentStage)
          return {
            runId: checkpoint.runId,
            provider: checkpoint.config.provider,
            benchmark: checkpoint.config.benchmark,
            judge: checkpoint.config.evaluator.model,
            answeringModel: checkpoint.config.reader.model,
            createdAt: checkpoint.createdAt,
            updatedAt: checkpoint.updatedAt,
            status:
              checkpoint.status === "running" && uiManaged && !isRunActive(checkpoint.runId)
                ? "failed"
                : checkpoint.status,
            summary: {
              total: questions.length,
              ingested: buildFinished ? questions.length : 0,
              indexed: buildFinished ? questions.length : 0,
              searched: queryCompleted,
              answered: readCompleted,
              evaluated: evaluateCompleted,
            },
            accuracy: report?.official.overall.overall_full_set ?? null,
            readOnlyInspection: true,
          }
        } catch {
          return null
        }
      })
  )
  return summaries.filter((summary) => summary !== null)
}

function questionStageSummary(checkpoint: BuildAwareRunCheckpoint) {
  const questions = Object.values(checkpoint.questions)
  const count = (stage: "query" | "read" | "evaluate", status: string) =>
    questions.filter((question) => question.stages[stage].status === status).length
  return {
    total: questions.length,
    query: {
      completed: count("query", "completed"),
      failed: count("query", "failed"),
      cacheHits: questions.filter((question) => question.stages.query.cacheHit === true).length,
    },
    read: {
      completed: count("read", "completed"),
      failed: count("read", "failed"),
      cacheHits: questions.filter((question) => question.stages.read.cacheHit === true).length,
    },
    evaluate: {
      completed: count("evaluate", "completed"),
      failed: count("evaluate", "failed"),
      blocked: count("evaluate", "blocked"),
    },
  }
}

function questionListItem(question: BuildAwareQuestionCheckpoint) {
  return {
    questionId: question.questionId,
    questionType: question.questionType,
    question: question.question,
    buildId: question.buildId,
    stages: {
      query: { status: question.stages.query.status },
      read: { status: question.stages.read.status },
      evaluate: { status: question.stages.evaluate.status },
    },
    ...(question.evaluationArtifact
      ? {
          evaluationArtifact: {
            score: question.evaluationArtifact.score,
            label: question.evaluationArtifact.label,
          },
        }
      : {}),
  }
}

async function resolveRecordedRoot(
  recordedRoot: string | undefined,
  allowedRoot: string
): Promise<{
  status: "available" | "missing" | "rejected"
  absolutePath?: string
}> {
  const allowedAbsolute = resolve(allowedRoot)
  const recordedAbsolute = resolve(recordedRoot ?? allowedAbsolute)
  if (!isInside(allowedAbsolute, recordedAbsolute)) return { status: "rejected" }
  try {
    const [allowedReal, recordedReal] = await Promise.all([
      realpath(allowedAbsolute),
      realpath(recordedAbsolute),
    ])
    if (!isInside(allowedReal, recordedReal)) return { status: "rejected" }
    const metadata = await stat(recordedReal)
    return metadata.isDirectory()
      ? { status: "available", absolutePath: recordedReal }
      : { status: "rejected" }
  } catch {
    return { status: "missing" }
  }
}

async function loadBuildPlan(runRoot: string, buildId: string): Promise<BuildPlanSummary | null> {
  if (!validateEntityId(buildId)) return null
  const path = await resolveExistingFileWithin(runRoot, `builds/${buildId}.plan.json`)
  if (!path) return null
  const metadata = await stat(path)
  if (metadata.size > MAX_JSON_ARTIFACT_BYTES) return null
  const plan = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
  if (plan.buildId !== buildId || typeof plan.buildFingerprint !== "string") {
    return null
  }
  return {
    buildId,
    buildFingerprint: plan.buildFingerprint,
    containerTag: typeof plan.containerTag === "string" ? plan.containerTag : undefined,
    provider: typeof plan.provider === "string" ? plan.provider : undefined,
    domain: typeof plan.domain === "string" ? plan.domain : undefined,
    trajectoryCount: Array.isArray(plan.orderedSourceIds)
      ? plan.orderedSourceIds.length
      : undefined,
    documentCount: Array.isArray(plan.documents) ? plan.documents.length : undefined,
  }
}

async function resolveBuildCheckpoint(
  buildRoot: {
    status: "available" | "missing" | "rejected"
    absolutePath?: string
  },
  provider: string,
  buildFingerprint: string | undefined
): Promise<ResolvedBuildLink> {
  if (buildRoot.status !== "available" || !buildRoot.absolutePath) {
    return {
      status: buildRoot.status,
      reason:
        buildRoot.status === "rejected"
          ? "Recorded build root is outside the allowed build root"
          : "Build root is not available",
    }
  }
  if (!validateEntityId(provider) || !buildFingerprint || !validateEntityId(buildFingerprint)) {
    return {
      status: "missing",
      reason: "Build fingerprint is not available",
    }
  }
  const relativePath = `${provider}/${buildFingerprint}/checkpoint.sqlite`
  const absolutePath = await resolveExistingFileWithin(buildRoot.absolutePath, relativePath)
  return absolutePath
    ? {
        status: "available",
        scope: "builds",
        relativePath,
        absolutePath,
      }
    : {
        status: "missing",
        scope: "builds",
        relativePath,
        reason: "Durable build checkpoint is not available",
      }
}

function readBuildSqliteSummary(path: string, buildId: string): Record<string, unknown> {
  const db = new Database(path, { readonly: true, strict: true })
  try {
    const build = db
      .query(
        `SELECT build_id, build_fingerprint, container_tag, provider, status, error
         FROM builds WHERE build_id = ?`
      )
      .get(buildId) as {
      build_id: string
      build_fingerprint: string
      container_tag: string
      provider: string
      status: string
      error: string | null
    } | null
    if (!build) return { available: true, buildFound: false }

    const trajectoryRows = db
      .query(
        "SELECT status, COUNT(*) AS count FROM trajectories WHERE build_id = ? GROUP BY status"
      )
      .all(buildId) as Array<{ status: string; count: number }>
    const documentRows = db
      .query("SELECT status, COUNT(*) AS count FROM documents WHERE build_id = ? GROUP BY status")
      .all(buildId) as Array<{ status: string; count: number }>

    return {
      available: true,
      buildFound: true,
      buildFingerprint: build.build_fingerprint,
      containerTag: build.container_tag,
      provider: build.provider,
      status: build.status,
      error: build.error ?? undefined,
      trajectories: Object.fromEntries(trajectoryRows.map((row) => [row.status, row.count])),
      documents: Object.fromEntries(documentRows.map((row) => [row.status, row.count])),
    }
  } finally {
    db.close()
  }
}

async function buildSummaries(
  checkpoint: BuildAwareRunCheckpoint,
  runRoot: string,
  buildRoot: {
    status: "available" | "missing" | "rejected"
    absolutePath?: string
  },
  report: BuildAwareReport | null
): Promise<Array<Record<string, unknown>>> {
  const buildIds = Array.from(
    new Set([
      ...checkpoint.buildIds,
      ...Object.values(checkpoint.questions).map((question) => question.buildId),
    ])
  )

  return Promise.all(
    buildIds.map(async (buildId) => {
      const questions = Object.values(checkpoint.questions).filter(
        (question) => question.buildId === buildId
      )
      const plan = await loadBuildPlan(runRoot, buildId)
      const reportBuild = report?.builds?.find((build) => build.buildId === buildId)
      const checkpointFingerprint = questions.find(
        (question) => question.queryArtifact?.buildFingerprint
      )?.queryArtifact?.buildFingerprint
      const buildFingerprint =
        checkpointFingerprint ?? plan?.buildFingerprint ?? reportBuild?.buildFingerprint
      const provider = plan?.provider ?? checkpoint.config.provider
      const link = await resolveBuildCheckpoint(buildRoot, provider, buildFingerprint)
      let stateStore: Record<string, unknown> = {
        available: false,
        reason: link.status === "rejected" ? link.reason : "No readable build state link",
      }
      if (link.status === "available" && link.absolutePath) {
        try {
          stateStore = readBuildSqliteSummary(link.absolutePath, buildId)
        } catch (error) {
          stateStore = {
            available: false,
            reason:
              error instanceof Error
                ? "Build state is not a supported readable SQLite checkpoint"
                : "Could not inspect build state",
          }
        }
      }
      const storeFingerprint =
        typeof stateStore.buildFingerprint === "string" ? stateStore.buildFingerprint : undefined
      return {
        buildId,
        buildFingerprint: buildFingerprint ?? storeFingerprint,
        containerTag: plan?.containerTag ?? reportBuild?.containerTag,
        domain: plan?.domain ?? reportBuild?.domain,
        trajectoryCount: plan?.trajectoryCount ?? reportBuild?.trajectoryCount,
        documentCount: plan?.documentCount ?? reportBuild?.documentCount,
        questionCount: questions.length,
        questionIds: questions.map((question) => question.questionId),
        questionLinkMismatches: questions
          .filter((question) => checkpoint.buildLinks[question.questionId] !== buildId)
          .map((question) => question.questionId),
        reused: questions.length > 1,
        reuseCount: questions.length,
        priorBuildReuse: reportBuild?.reused,
        checkpointLink: {
          status: link.status,
          scope: link.scope,
          relativePath: link.relativePath,
          reason: link.reason,
        },
        stateStore,
      }
    })
  )
}

function artifactDescriptorFor(
  question: BuildAwareQuestionCheckpoint,
  kind: string
): { descriptor?: ArtifactDescriptor; embedded?: unknown } {
  if (kind === "query-raw") {
    return { descriptor: question.queryArtifact?.rawArtifact }
  }
  if (kind === "query-normalized") {
    return { descriptor: question.queryArtifact?.normalizedArtifact }
  }
  if (kind === "reader") {
    return {
      descriptor: question.stages.read.artifactPath
        ? { relativePath: question.stages.read.artifactPath }
        : undefined,
      embedded: question.readerArtifact,
    }
  }
  return {
    descriptor: question.stages.evaluate.artifactPath
      ? { relativePath: question.stages.evaluate.artifactPath }
      : undefined,
    embedded: question.evaluationArtifact,
  }
}

function artifactLinks(
  runId: string,
  question: BuildAwareQuestionCheckpoint,
  artifactRootAvailable: boolean
): Record<string, unknown> {
  return Object.fromEntries(
    [...ARTIFACT_KINDS].map((kind) => {
      const source = artifactDescriptorFor(question, kind)
      return [
        kind,
        {
          available: Boolean(source.embedded || (source.descriptor && artifactRootAvailable)),
          href: `/api/runs/${encodeURIComponent(runId)}/questions/${encodeURIComponent(
            question.questionId
          )}/artifacts/${kind}`,
          provenance: source.descriptor
            ? {
                relativePath: source.descriptor.relativePath,
                sha256: source.descriptor.sha256,
                byteLength: source.descriptor.byteLength,
              }
            : { source: "checkpoint" },
        },
      ]
    })
  )
}

async function readArtifact(
  artifactRoot: string,
  descriptor: ArtifactDescriptor
): Promise<{ data: unknown; provenance: Record<string, unknown> }> {
  if (
    !descriptor.relativePath ||
    isAbsolute(descriptor.relativePath) ||
    descriptor.relativePath === ".." ||
    descriptor.relativePath.startsWith(`..${sep}`)
  ) {
    throw new Error("Artifact path is outside the artifact root")
  }
  const artifactPath = await resolveExistingFileWithin(artifactRoot, descriptor.relativePath)
  if (!artifactPath) throw new Error("Artifact is missing or outside the artifact root")
  const metadata = await stat(artifactPath)
  if (metadata.size > MAX_JSON_ARTIFACT_BYTES) {
    throw new Error(`Artifact exceeds the ${MAX_JSON_ARTIFACT_BYTES}-byte inspection limit`)
  }
  if (descriptor.byteLength !== undefined && metadata.size !== descriptor.byteLength) {
    throw new Error("Artifact byte length does not match its checkpoint provenance")
  }
  const bytes = await readFile(artifactPath)
  const actualHash = createHash("sha256").update(bytes).digest("hex")
  if (descriptor.sha256 && actualHash !== descriptor.sha256) {
    throw new Error("Artifact hash does not match its checkpoint provenance")
  }
  return {
    data: sanitizeForResponse(JSON.parse(bytes.toString("utf8"))),
    provenance: {
      relativePath: descriptor.relativePath,
      sha256: actualHash,
      byteLength: metadata.size,
      integrity: descriptor.sha256 ? "verified" : "computed",
    },
  }
}

function pageParameters(url: URL): { page: number; limit: number } {
  const rawPage = Number.parseInt(url.searchParams.get("page") ?? "1", 10)
  const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10)
  return {
    page: Number.isFinite(rawPage) ? Math.max(1, rawPage) : 1,
    limit: Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, rawLimit)) : 50,
  }
}

export function createBuildAwareInspectionHandler(options: BuildAwareInspectionRouteOptions = {}) {
  const runsRoot = resolve(options.runsRoot ?? "data/runs-v2")
  const buildsRoot = resolve(options.buildsRoot ?? "data/memory-builds-v2")
  const artifactsRoot = resolve(options.artifactsRoot ?? "data/artifacts-v2")

  return async function handleBuildAwareInspectionRoutes(
    req: Request,
    url: URL
  ): Promise<Response | null> {
    if (req.method !== "GET") return null
    const pathname = url.pathname

    const routeMatch = pathname.match(/^\/api\/runs\/([^/]+)(?:\/.*)?$/)
    if (!routeMatch) return null

    let runId: string
    try {
      runId = decodeURIComponent(routeMatch[1])
    } catch {
      return null
    }
    if (!validateRunId(runId)) {
      return null
    }

    const loaded = await loadCheckpoint(runsRoot, runId)
    if (!loaded) return null
    const { checkpoint, runRoot } = loaded
    const [artifactStorage, buildStorage] = await Promise.all([
      resolveRecordedRoot(checkpoint.artifactRoot, artifactsRoot),
      resolveRecordedRoot(checkpoint.buildRoot, buildsRoot),
    ])
    const storageRoots = {
      artifacts: artifactStorage.status,
      builds: buildStorage.status,
    }

    if (pathname === `/api/runs/${encodeURIComponent(runId)}`) {
      const report = await loadReport(runRoot, runId)
      const builds = await buildSummaries(checkpoint, runRoot, buildStorage, report)
      const control = await loadControlHistory(runRoot, runId)
      const uiManaged = control.events.some(
        (event) => event.action === "start" || event.action === "resume"
      )
      const publicRun = publicCheckpoint(checkpoint, storageRoots, uiManaged)
      const compact = url.searchParams.get("compact") === "true"
      const runPayload = compact
        ? (({ questions: _questions, ...rest }) => rest)(publicRun)
        : publicRun
      return json(
        sanitizeForResponse({
          ...runPayload,
          summary: questionStageSummary(checkpoint),
          inspection: {
            builds,
            control,
            reportAvailable: Boolean(report),
            metricNamespaces: {
              official: report?.official ?? null,
              diagnostics: report?.diagnostics ?? null,
            },
          },
        })
      )
    }

    if (pathname === `/api/runs/${encodeURIComponent(runId)}/inspection`) {
      const report = await loadReport(runRoot, runId)
      const builds = await buildSummaries(checkpoint, runRoot, buildStorage, report)
      const control = await loadControlHistory(runRoot, runId)
      const uiManaged = control.events.some(
        (event) => event.action === "start" || event.action === "resume"
      )
      return json(
        sanitizeForResponse({
          checkpoint: publicCheckpoint(checkpoint, storageRoots, uiManaged),
          summary: questionStageSummary(checkpoint),
          builds,
          control,
          report,
          metricNamespaces: {
            official: report?.official ?? null,
            diagnostics: report?.diagnostics ?? null,
          },
        })
      )
    }

    if (pathname === `/api/runs/${encodeURIComponent(runId)}/report`) {
      const report = await loadReport(runRoot, runId)
      return report ? json(sanitizeForResponse(report)) : json({ error: "Report not found" }, 404)
    }

    if (pathname === `/api/runs/${encodeURIComponent(runId)}/builds`) {
      const report = await loadReport(runRoot, runId)
      return json(
        sanitizeForResponse({
          builds: await buildSummaries(checkpoint, runRoot, buildStorage, report),
        })
      )
    }

    const buildMatch = pathname.match(/^\/api\/runs\/[^/]+\/builds\/([^/]+)$/)
    if (buildMatch) {
      let buildId: string
      try {
        buildId = decodeURIComponent(buildMatch[1])
      } catch {
        return json({ error: "Invalid build ID encoding" }, 400)
      }
      if (!validateEntityId(buildId)) return json({ error: "Invalid build ID" }, 400)
      const report = await loadReport(runRoot, runId)
      const builds = await buildSummaries(checkpoint, runRoot, buildStorage, report)
      const build = builds.find((item) => item.buildId === buildId)
      return build ? json(sanitizeForResponse(build)) : json({ error: "Build not found" }, 404)
    }

    if (pathname === `/api/runs/${encodeURIComponent(runId)}/questions`) {
      const { page, limit } = pageParameters(url)
      const status = url.searchParams.get("status")
      const type = url.searchParams.get("type")
      let questions = Object.values(checkpoint.questions)
      if (status) {
        questions = questions.filter((question) => {
          const evaluationStatus = question.stages.evaluate.status
          if (status === "completed") return evaluationStatus === "completed"
          if (status === "failed") return evaluationStatus === "failed"
          if (status === "pending") {
            return evaluationStatus !== "completed" && evaluationStatus !== "failed"
          }
          return true
        })
      }
      if (type) questions = questions.filter((question) => question.questionType === type)
      const total = questions.length
      const start = (page - 1) * limit
      return json(
        sanitizeForResponse({
          questions: questions.slice(start, start + limit).map(questionListItem),
          questionTypeRegistry: {},
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        })
      )
    }

    const artifactMatch = pathname.match(
      /^\/api\/runs\/[^/]+\/questions\/([^/]+)\/artifacts\/([^/]+)$/
    )
    if (artifactMatch) {
      let questionId: string
      try {
        questionId = decodeURIComponent(artifactMatch[1])
      } catch {
        return json({ error: "Invalid question ID encoding" }, 400)
      }
      const kind = artifactMatch[2]
      if (!validateEntityId(questionId)) return json({ error: "Invalid question ID" }, 400)
      if (!ARTIFACT_KINDS.has(kind)) return json({ error: "Unknown artifact kind" }, 404)
      const question = checkpoint.questions[questionId]
      if (!question) return json({ error: "Question not found" }, 404)
      const source = artifactDescriptorFor(question, kind)
      if (source.embedded) {
        return json({
          kind,
          data: sanitizeForResponse(source.embedded),
          provenance: { source: "checkpoint", integrity: "embedded" },
        })
      }
      if (!source.descriptor) return json({ error: "Artifact not available" }, 404)
      if (artifactStorage.status !== "available" || !artifactStorage.absolutePath) {
        return json(
          {
            error:
              artifactStorage.status === "rejected"
                ? "Recorded artifact root is outside the allowed artifact root"
                : "Artifact root is not available",
          },
          422
        )
      }
      try {
        const artifact = await readArtifact(artifactStorage.absolutePath, source.descriptor)
        return json({ kind, ...artifact })
      } catch (error) {
        return json(
          { error: error instanceof Error ? error.message : "Artifact could not be read" },
          422
        )
      }
    }

    const assetMatch = pathname.match(/^\/api\/runs\/[^/]+\/questions\/([^/]+)\/assets\/([^/]+)$/)
    if (assetMatch) {
      let questionId: string
      let assetId: string
      try {
        questionId = decodeURIComponent(assetMatch[1])
        assetId = decodeURIComponent(assetMatch[2])
      } catch {
        return json({ error: "Invalid asset URL encoding" }, 400)
      }
      if (!validateEntityId(questionId) || !validateEntityId(assetId)) {
        return json({ error: "Invalid question or asset ID" }, 400)
      }
      const question = checkpoint.questions[questionId]
      if (!question) return json({ error: "Question not found" }, 404)
      const candidates = referencedAssets(question).filter(({ asset }) => asset.assetId === assetId)
      if (candidates.length === 0) return json({ error: "Image asset not found" }, 404)

      const errors: string[] = []
      for (const candidate of candidates.sort(
        (left, right) => Number(right.scope === "artifacts") - Number(left.scope === "artifacts")
      )) {
        let root: string | undefined
        if (candidate.scope === "artifacts") {
          root = artifactStorage.status === "available" ? artifactStorage.absolutePath : undefined
        } else {
          try {
            const datasetRoot = resolve(checkpoint.config.datasetPath)
            const datasetReal = await realpath(datasetRoot)
            if (datasetReal !== parse(datasetReal).root) root = datasetReal
          } catch {
            root = undefined
          }
        }
        if (!root) {
          errors.push(`Recorded ${candidate.scope} root is not available`)
          continue
        }
        try {
          const bytes = await verifiedImageAsset(root, candidate.asset)
          return new Response(Uint8Array.from(bytes).buffer, {
            status: 200,
            headers: {
              "Content-Type": candidate.asset.mimeType,
              "Content-Length": String(bytes.byteLength),
              "Cache-Control": "private, max-age=31536000, immutable",
              ETag: `"${candidate.asset.sha256}"`,
              "X-Content-Type-Options": "nosniff",
            },
          })
        } catch (error) {
          errors.push(error instanceof Error ? error.message : "Image verification failed")
        }
      }
      return json({ error: errors[0] ?? "Image asset could not be verified" }, 422)
    }

    const questionMatch = pathname.match(/^\/api\/runs\/[^/]+\/questions\/([^/]+)$/)
    if (questionMatch) {
      let questionId: string
      try {
        questionId = decodeURIComponent(questionMatch[1])
      } catch {
        return json({ error: "Invalid question ID encoding" }, 400)
      }
      if (!validateEntityId(questionId)) return json({ error: "Invalid question ID" }, 400)
      const question = checkpoint.questions[questionId]
      if (!question) return json({ error: "Question not found" }, 404)
      const reuseCount = Object.values(checkpoint.questions).filter(
        (item) => item.buildId === question.buildId
      ).length
      const buildPlan = await loadBuildPlan(runRoot, question.buildId)
      return json(
        sanitizeForResponse({
          ...question,
          buildReuseCount: reuseCount,
          buildLinkMatchesCheckpoint: checkpoint.buildLinks[questionId] === question.buildId,
          buildFingerprint: question.queryArtifact?.buildFingerprint ?? buildPlan?.buildFingerprint,
          artifactLinks: artifactLinks(runId, question, artifactStorage.status === "available"),
          metricNamespace: {
            evaluation: "longmemeval-v2-official",
            retrievalAndLatency: "memorybench-diagnostics",
          },
        })
      )
    }

    return null
  }
}

export const handleBuildAwareInspectionRoutes = createBuildAwareInspectionHandler()
