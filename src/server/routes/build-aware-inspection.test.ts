import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { BuildAwareRunCheckpoint } from "../../types/build-aware"
import {
  createBuildAwareInspectionHandler,
  listBuildAwareRunSummaries,
} from "./build-aware-inspection"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

async function fixture(options?: {
  unsafeArtifact?: boolean
  unsafeArtifactRoot?: boolean
  symlinkArtifact?: boolean
  unsafeBuildRoot?: boolean
  buildState?: boolean
  imageAssetMode?: "valid" | "tampered" | "symlink"
}) {
  const root = await mkdtemp(join(tmpdir(), "memorybench-inspection-"))
  temporaryDirectories.push(root)
  const runsRoot = join(root, "runs-v2")
  const buildsRoot = join(root, "builds")
  const artifactsRoot = join(root, "artifacts")
  const datasetRoot = join(root, "dataset")
  const runId = options?.unsafeArtifact ? "unsafe-run" : "inspection-run"
  const runRoot = join(runsRoot, runId)
  await mkdir(join(runRoot, "builds"), { recursive: true })
  await mkdir(join(artifactsRoot, "queries"), { recursive: true })
  await mkdir(join(artifactsRoot, "assets"), { recursive: true })
  await mkdir(join(datasetRoot, "screenshots/trajectory-1"), { recursive: true })
  await mkdir(buildsRoot, { recursive: true })

  const imageBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4])
  const imageHash = createHash("sha256").update(imageBytes).digest("hex")
  const assetId = `trajectory-screenshot:${imageHash}`
  const datasetImageRelativePath = "screenshots/trajectory-1/0.png"
  const materializedImageRelativePath = `assets/${imageHash}.png`
  if (options?.imageAssetMode === "symlink") {
    const outsideImage = join(root, "outside-image.png")
    await writeFile(outsideImage, imageBytes)
    await symlink(outsideImage, join(datasetRoot, datasetImageRelativePath))
  } else {
    const bytes =
      options?.imageAssetMode === "tampered"
        ? Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 4, 3, 2, 1])
        : imageBytes
    await writeFile(join(datasetRoot, datasetImageRelativePath), bytes)
    await writeFile(join(artifactsRoot, materializedImageRelativePath), bytes)
  }
  const datasetAsset = {
    assetId,
    kind: "trajectory-screenshot" as const,
    relativePath: datasetImageRelativePath,
    mimeType: "image/png",
    sha256: imageHash,
    byteLength: imageBytes.byteLength,
  }
  const materializedAsset = {
    ...datasetAsset,
    relativePath: materializedImageRelativePath,
  }

  if (options?.buildState) {
    const checkpointDirectory = join(buildsRoot, "supermemory", "build-fingerprint")
    await mkdir(checkpointDirectory, { recursive: true })
    const database = new Database(join(checkpointDirectory, "checkpoint.sqlite"))
    database.exec(`
      CREATE TABLE builds (
        build_id TEXT PRIMARY KEY,
        build_fingerprint TEXT NOT NULL,
        container_tag TEXT NOT NULL,
        provider TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT
      );
      CREATE TABLE trajectories (build_id TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE documents (build_id TEXT NOT NULL, status TEXT NOT NULL);
      INSERT INTO builds VALUES (
        'build-1', 'sqlite-build-fingerprint', 'container-1', 'supermemory', 'ready', NULL
      );
      INSERT INTO trajectories VALUES ('build-1', 'ready');
      INSERT INTO documents VALUES ('build-1', 'ready');
      INSERT INTO documents VALUES ('build-1', 'ready');
    `)
    database.close()
  }

  const rawBytes = Buffer.from(
    JSON.stringify({
      results: [{ id: "result-1", text: "evidence" }],
      authorization: "Bearer private",
      nested: {
        absolutePath: "/private/evidence.png",
        tokenValue: "sm_12345678901234567890",
      },
    })
  )
  const artifactRelativePath = options?.symlinkArtifact
    ? "queries/raw-link.json"
    : "queries/raw.json"
  if (options?.symlinkArtifact) {
    const outsidePath = join(root, "outside.json")
    await writeFile(outsidePath, rawBytes)
    await symlink(outsidePath, join(artifactsRoot, artifactRelativePath))
  } else {
    await writeFile(join(artifactsRoot, artifactRelativePath), rawBytes)
  }
  const rawDescriptor = {
    relativePath: options?.unsafeArtifact ? "../../outside.json" : artifactRelativePath,
    sha256: createHash("sha256").update(rawBytes).digest("hex"),
    byteLength: rawBytes.byteLength,
  }

  const checkpoint = {
    schemaVersion: 1,
    executionModel: "shared-memory-build-v1",
    runId,
    configFingerprint: "config-fingerprint",
    status: "completed",
    currentStage: "report",
    config: {
      provider: "supermemory",
      benchmark: "longmemeval-v2",
      datasetPath: datasetRoot,
      datasetRevision: "revision-1",
      tier: "small",
      domain: "all",
      seed: "seed",
      retrieval: {
        topK: 10,
        searchMode: "hybrid",
        rerank: true,
        rewriteQuery: false,
        includeRelatedMemories: true,
        metadataFilter: {},
      },
      reader: {
        model: "reader-model",
        reasoningEffort: "high",
        maxCompletionTokens: 1000,
        maxContextTokens: 2000,
        evidenceTopK: 10,
        maxImages: 4,
        maxImageBytes: 1000000,
        malformedResponseAttempts: 2,
      },
      evaluator: {
        model: "evaluator-model",
        reasoningEffort: "high",
        maxCompletionTokens: 1000,
      },
      build: {
        dreaming: "instant",
        rootFilterMode: "self",
        maxDocumentChars: 1000,
        trajectoryConcurrency: 2,
        maxInFlightRequests: 4,
        maxTrajectoryAttempts: 3,
        indexingTimeoutMs: 1000,
        pollIntervalMs: 100,
        preflightMaxAgeMs: 24 * 60 * 60_000,
      },
    },
    targetQuestionIds: ["q1", "q2"],
    buildIds: ["build-1"],
    artifactRoot: options?.unsafeArtifactRoot ? "/private/outside-artifact-root" : artifactsRoot,
    buildRoot: options?.unsafeBuildRoot ? "/private/outside-build-root" : buildsRoot,
    preflightGate: {
      schemaVersion: 1,
      reportFingerprint: "f".repeat(64),
      generatedAt: "2026-01-01T00:00:00.000Z",
      baseUrl: "https://api.supermemory.ai",
      testedTopK: 10,
    },
    buildLinks: {
      q1: "build-1",
      q2: "build-1",
    },
    questions: {
      q1: {
        questionId: "q1",
        questionType: "static-environment",
        question: "What happened?",
        groundTruth: "The event",
        evalFunction: "qa",
        buildId: "build-1",
        stages: {
          query: { status: "completed", cacheHit: true },
          read: { status: "completed", cacheHit: false },
          evaluate: { status: "completed" },
        },
        queryArtifact: {
          schemaVersion: 1,
          questionId: "q1",
          buildId: "build-1",
          buildFingerprint: "build-fingerprint",
          queryFingerprint: "query-fingerprint",
          query: "What happened?",
          config: {
            topK: 10,
            searchMode: "hybrid",
            rerank: true,
            rewriteQuery: false,
            includeRelatedMemories: true,
            metadataFilter: {},
          },
          request: {},
          rawArtifact: rawDescriptor,
          normalizedArtifact: rawDescriptor,
          normalizedResults: [
            {
              rank: 1,
              kind: "memory",
              text: "evidence",
              chunks: [],
              documentIds: ["document-1"],
              screenshotRefs: [datasetAsset],
              provenanceValid: true,
            },
          ],
          remoteDurationMs: 10,
          wallDurationMs: 12,
          cacheHit: true,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        readerArtifact: {
          schemaVersion: 1,
          questionId: "q1",
          readerFingerprint: "reader-fingerprint",
          model: "reader-model",
          systemPrompt: "prompt",
          parts:
            options?.imageAssetMode === "symlink"
              ? []
              : [{ type: "image", asset: materializedAsset }],
          sentAssetIds: options?.imageAssetMode === "symlink" ? [] : [assetId],
          omittedItems: 0,
          responseText: "The event",
          parsedAnswer: "The event",
          durationMs: 20,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        evaluationArtifact: {
          schemaVersion: 1,
          questionId: "q1",
          evaluatorFingerprint: "evaluator-fingerprint",
          evalFunction: "qa",
          answer: "The event",
          groundTruth: "The event",
          score: 1,
          label: "correct",
          promptVersion: "v1",
          implementationVersion: "v1",
          durationMs: 30,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      },
      q2: {
        questionId: "q2",
        questionType: "static-environment",
        question: "When?",
        groundTruth: "Then",
        evalFunction: "qa",
        buildId: "build-1",
        stages: {
          query: { status: "pending" },
          read: { status: "pending" },
          evaluate: { status: "pending" },
        },
      },
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
  } as unknown as BuildAwareRunCheckpoint
  await writeFile(join(runRoot, "checkpoint.json"), JSON.stringify(checkpoint))
  await writeFile(
    join(runRoot, "control.json"),
    JSON.stringify({
      schemaVersion: 1,
      runId,
      events: [
        { action: "start", at: "2026-01-01T00:00:00.000Z", through: "report" },
        { action: "completed", at: "2026-01-01T00:01:00.000Z", through: "report" },
      ],
    })
  )
  await writeFile(
    join(runRoot, "builds", "build-1.plan.json"),
    JSON.stringify({
      buildId: "build-1",
      buildFingerprint: "build-fingerprint",
      containerTag: "container-1",
      provider: "supermemory",
      domain: "web",
      orderedSourceIds: ["trajectory-1"],
      documents: [{ customId: "document-1" }, { customId: "document-2" }],
    })
  )

  const report = {
    schemaVersion: 1,
    protocol: "longmemeval-v2-official",
    runId,
    assetId,
    imageBytes,
    benchmark: "longmemeval-v2",
    provider: "supermemory",
    converter: "Structured Accessibility Converter",
    targetQuestionCount: 2,
    completedQuestionCount: 1,
    failedQuestionCount: 0,
    buildIds: ["build-1"],
    builds: [
      {
        buildId: "build-1",
        buildFingerprint: "build-fingerprint",
        containerTag: "container-1",
        domain: "web",
        trajectoryCount: 1,
        documentCount: 2,
        linkedQuestionIds: ["q1", "q2"],
        reused: false,
      },
    ],
    official: {
      overall: {
        overall_full_set: 0.5,
        overall_non_abstention_only: 0.5,
        overall_abstention_only: null,
        count_all_questions: 2,
        count_non_abstention: 2,
        count_abstention: 0,
      },
      non_abstention_by_category: {},
      abstention_by_category: {},
      combined_abstention_by_category: {},
      abstention_overall: {},
      execution: { completed: 1, failed: 0, pending: 1, blocked: 0 },
    },
    diagnostics: {
      queryCacheHits: 1,
      readerCacheHits: 0,
      remoteSearchLatencyMs: [10],
      queryWallLatencyMs: [12],
      contextImagesSent: 0,
      failedQuestions: [],
    },
    createdAt: "2026-01-01T00:01:00.000Z",
  }
  await writeFile(join(runRoot, "report.json"), JSON.stringify(report))

  return {
    runId,
    assetId,
    imageBytes,
    runsRoot,
    handler: createBuildAwareInspectionHandler({
      runsRoot,
      buildsRoot,
      artifactsRoot,
    }),
  }
}

async function request(
  handler: ReturnType<typeof createBuildAwareInspectionHandler>,
  path: string
) {
  return handler(new Request(`http://localhost${path}`), new URL(`http://localhost${path}`))
}

describe("build-aware inspection routes", () => {
  test("lists build-aware runs as read-only summaries for the shared runs page", async () => {
    const { runsRoot, runId } = await fixture()
    const summaries = await listBuildAwareRunSummaries(runsRoot)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      runId,
      provider: "supermemory",
      benchmark: "longmemeval-v2",
      judge: "evaluator-model",
      answeringModel: "reader-model",
      status: "completed",
      readOnlyInspection: true,
      accuracy: 0.5,
      summary: {
        total: 2,
        ingested: 2,
        indexed: 2,
        searched: 1,
        answered: 1,
        evaluated: 1,
      },
    })
  })

  test("surfaces an orphaned running checkpoint as failed and resumable", async () => {
    const { handler, runsRoot, runId } = await fixture()
    const checkpointPath = join(runsRoot, runId, "checkpoint.json")
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"))
    checkpoint.status = "running"
    checkpoint.currentStage = "query"
    delete checkpoint.error
    await writeFile(checkpointPath, JSON.stringify(checkpoint))

    const summaries = await listBuildAwareRunSummaries(runsRoot)
    expect(summaries[0].status).toBe("failed")

    const response = await request(handler, `/api/runs/${runId}`)
    expect(await response!.json()).toMatchObject({
      status: "failed",
      currentStage: "query",
      error: "Run process is no longer active; resume from the durable checkpoint",
    })
  })

  test("does not misclassify an independently managed CLI checkpoint as stale", async () => {
    const { handler, runsRoot, runId } = await fixture()
    const checkpointPath = join(runsRoot, runId, "checkpoint.json")
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"))
    checkpoint.status = "running"
    checkpoint.currentStage = "query"
    delete checkpoint.error
    await writeFile(checkpointPath, JSON.stringify(checkpoint))
    await rm(join(runsRoot, runId, "control.json"))

    const summaries = await listBuildAwareRunSummaries(runsRoot)
    expect(summaries[0].status).toBe("running")

    const response = await request(handler, `/api/runs/${runId}`)
    expect(await response!.json()).toMatchObject({ status: "running", currentStage: "query" })
  })

  test("separates official metrics, diagnostics, and build reuse", async () => {
    const { handler, runId } = await fixture({ unsafeBuildRoot: true })
    const response = await request(handler, `/api/runs/${runId}`)
    expect(response?.status).toBe(200)
    const body = await response!.json()
    expect(body.executionModel).toBe("shared-memory-build-v1")
    expect(body.inspection.metricNamespaces.official.overall.overall_full_set).toBe(0.5)
    expect(body.inspection.metricNamespaces.diagnostics.queryCacheHits).toBe(1)
    expect(body.inspection.builds[0].reuseCount).toBe(2)
    expect(body.inspection.builds[0].reused).toBe(true)
    expect(body.inspection.builds[0].priorBuildReuse).toBe(false)
    expect(body.inspection.builds[0].checkpointLink.status).toBe("rejected")
    expect(body.inspection.control.events.map((event: { action: string }) => event.action)).toEqual(
      ["start", "completed"]
    )
    expect(body.questionBuildLinks).toEqual({ q1: "build-1", q2: "build-1" })
    expect(body.preflightGate).toEqual({
      schemaVersion: 1,
      reportFingerprint: "f".repeat(64),
      generatedAt: "2026-01-01T00:00:00.000Z",
      baseUrl: "https://api.supermemory.ai",
      testedTopK: 10,
    })
    expect(JSON.stringify(body)).not.toContain("/private/outside-build-root")

    const compactResponse = await request(handler, `/api/runs/${runId}?compact=true`)
    const compactBody = await compactResponse!.json()
    expect(compactBody.questions).toBeUndefined()
    expect(compactBody.summary.total).toBe(2)

    const questionsResponse = await request(handler, `/api/runs/${runId}/questions?limit=1`)
    const questionsBody = await questionsResponse!.json()
    expect(questionsBody.pagination).toMatchObject({ page: 1, limit: 1, total: 2, totalPages: 2 })
    expect(questionsBody.questions).toHaveLength(1)
    expect(questionsBody.questions[0]).toMatchObject({
      questionId: "q1",
      evaluationArtifact: { score: 1, label: "correct" },
    })
    expect(questionsBody.questions[0].queryArtifact).toBeUndefined()
    expect(questionsBody.questions[0].readerArtifact).toBeUndefined()
  })

  test("serves named artifacts with integrity checks and response redaction", async () => {
    const { handler, runId } = await fixture()
    const detail = await request(handler, `/api/runs/${runId}/questions/q1`)
    const detailBody = await detail!.json()
    expect(detailBody.artifactLinks["query-raw"].available).toBe(true)
    expect(detailBody.buildReuseCount).toBe(2)

    const response = await request(handler, `/api/runs/${runId}/questions/q1/artifacts/query-raw`)
    expect(response?.status).toBe(200)
    const body = await response!.json()
    expect(body.provenance.integrity).toBe("verified")
    expect(body.data.authorization).toBe("[REDACTED]")
    expect(body.data.nested.absolutePath).toBeUndefined()
    expect(body.data.nested.tokenValue).toBe("[REDACTED]")
  })

  test("serves only referenced image assets after root, hash, size, and MIME verification", async () => {
    const { handler, runId, assetId, imageBytes } = await fixture({ imageAssetMode: "valid" })
    const response = await request(
      handler,
      `/api/runs/${runId}/questions/q1/assets/${encodeURIComponent(assetId)}`
    )
    expect(response?.status).toBe(200)
    expect(response?.headers.get("content-type")).toBe("image/png")
    expect(response?.headers.get("x-content-type-options")).toBe("nosniff")
    expect(Buffer.from(await response!.arrayBuffer())).toEqual(imageBytes)

    const unreferenced = await request(
      handler,
      `/api/runs/${runId}/questions/q1/assets/${encodeURIComponent("unreferenced-asset")}`
    )
    expect(unreferenced?.status).toBe(404)
  })

  test("rejects tampered and symlink-escaped referenced images", async () => {
    const tampered = await fixture({ imageAssetMode: "tampered" })
    const tamperedResponse = await request(
      tampered.handler,
      `/api/runs/${tampered.runId}/questions/q1/assets/${encodeURIComponent(tampered.assetId)}`
    )
    expect(tamperedResponse?.status).toBe(422)
    expect((await tamperedResponse!.json()).error).toContain("hash does not match")

    const escaped = await fixture({ imageAssetMode: "symlink" })
    const escapedResponse = await request(
      escaped.handler,
      `/api/runs/${escaped.runId}/questions/q1/assets/${encodeURIComponent(escaped.assetId)}`
    )
    expect(escapedResponse?.status).toBe(422)
    expect((await escapedResponse!.json()).error).toContain("outside its recorded root")
  })

  test("summarizes an allowlisted build checkpoint through a read-only database", async () => {
    const { handler, runId } = await fixture({ buildState: true })
    const response = await request(handler, `/api/runs/${runId}/builds/build-1`)
    expect(response?.status).toBe(200)
    const body = await response!.json()
    expect(body.checkpointLink).toEqual({
      status: "available",
      scope: "builds",
      relativePath: "supermemory/build-fingerprint/checkpoint.sqlite",
    })
    expect(body.stateStore.status).toBe("ready")
    expect(body.stateStore.documents).toEqual({ ready: 2 })
    expect(body.stateStore.trajectories).toEqual({ ready: 1 })
  })

  test("rejects checkpoint artifact traversal instead of reading it", async () => {
    const { handler, runId } = await fixture({ unsafeArtifact: true })
    const response = await request(handler, `/api/runs/${runId}/questions/q1/artifacts/query-raw`)
    expect(response?.status).toBe(422)
    expect(await response!.json()).toEqual({
      error: "Artifact path is outside the artifact root",
    })
  })

  test("rejects a recorded artifact root outside the server allowlist", async () => {
    const { handler, runId } = await fixture({ unsafeArtifactRoot: true })
    const detail = await request(handler, `/api/runs/${runId}/questions/q1`)
    const detailBody = await detail!.json()
    expect(detailBody.artifactLinks["query-raw"].available).toBe(false)

    const response = await request(handler, `/api/runs/${runId}/questions/q1/artifacts/query-raw`)
    expect(response?.status).toBe(422)
    expect(await response!.json()).toEqual({
      error: "Recorded artifact root is outside the allowed artifact root",
    })
  })

  test("rejects an artifact symlink that escapes the allowlisted root", async () => {
    const { handler, runId } = await fixture({ symlinkArtifact: true })
    const response = await request(handler, `/api/runs/${runId}/questions/q1/artifacts/query-raw`)
    expect(response?.status).toBe(422)
    expect(await response!.json()).toEqual({
      error: "Artifact is missing or outside the artifact root",
    })
  })

  test("returns null for legacy or missing runs", async () => {
    const { handler } = await fixture()
    const response = await request(handler, "/api/runs/legacy-run")
    expect(response).toBeNull()
  })
})
