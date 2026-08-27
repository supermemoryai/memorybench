import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { BuildAwareQuestionCheckpoint, BuildAwareRunConfig } from "../types/build-aware"
import { BuildAwareRunStore } from "./build-aware-run-store"

const temporaryRoots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memorybench-build-aware-"))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

function runConfig(overrides: Partial<BuildAwareRunConfig> = {}): BuildAwareRunConfig {
  return {
    provider: "supermemory",
    benchmark: "longmemeval-v2",
    mode: "benchmark",
    datasetPath: "/machine-a/datasets/longmemeval-v2",
    datasetRevision: "f152293e235517d504809563c833d7190b8c713b",
    tier: "small",
    domain: "web",
    questionIds: ["q1", "q2"],
    seed: "fixed-seed",
    retrieval: {
      topK: 20,
      threshold: 0,
      searchMode: "hybrid",
      rerank: true,
      rewriteQuery: false,
      includeSummaries: true,
      includeChunks: true,
      includeDocuments: true,
      includeRelatedMemories: false,
      metadataFilter: { runFingerprint: "build-fingerprint" },
    },
    reader: {
      model: "gpt-5",
      reasoningEffort: "high",
      maxCompletionTokens: 20_000,
      maxContextTokens: 100_000,
      evidenceTopK: 20,
      maxImages: 20,
      maxImageBytes: 20_000_000,
      malformedResponseAttempts: 5,
    },
    evaluator: {
      model: "gpt-5.2",
      reasoningEffort: "medium",
      maxCompletionTokens: 2_048,
    },
    build: {
      serviceBaseUrl: "https://api.supermemory.ai",
      dreaming: "instant",
      rootFilterMode: "self",
      maxDocumentChars: 100_000,
      trajectoryConcurrency: 20,
      maxInFlightRequests: 40,
      maxTrajectoryAttempts: 4,
      indexingTimeoutMs: 1_800_000,
      pollIntervalMs: 2_000,
      preflightMaxAgeMs: 24 * 60 * 60_000,
    },
    execution: {
      buildConcurrency: 1,
      questionConcurrency: 4,
    },
    ...overrides,
  }
}

function question(
  overrides: Partial<Omit<BuildAwareQuestionCheckpoint, "stages">> = {}
): Omit<BuildAwareQuestionCheckpoint, "stages"> {
  return {
    questionId: "q1",
    questionType: "static-environment",
    question: "Where is the setting?",
    groundTruth: "Settings, General",
    evalFunction:
      "norm_phrase_set_match|lower=true|normalize_hyphen=true|strip_punct=true|separators=,;|require_non_empty=true",
    buildId: "shared-web-small-build",
    questionImageHash: "image-hash",
    ...overrides,
  }
}

describe("BuildAwareRunStore", () => {
  test("validates run IDs before resolving filesystem paths", async () => {
    const root = await temporaryRoot()
    expect(() => new BuildAwareRunStore("../escape", root)).toThrow("runId")
    expect(() => new BuildAwareRunStore("contains/slash", root)).toThrow("runId")
    expect(() => new BuildAwareRunStore("", root)).toThrow("runId")
    expect(() => new BuildAwareRunStore("a".repeat(101), root)).toThrow("runId")
    expect(() => new BuildAwareRunStore("safe_Run-01", root)).not.toThrow()
  })

  test("creates a versioned build-aware checkpoint and loads it durably", async () => {
    const root = await temporaryRoot()
    const store = new BuildAwareRunStore("run-create", root)
    const checkpoint = await store.createOrLoad(runConfig())
    expect(checkpoint).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        executionModel: "shared-memory-build-v1",
        runId: "run-create",
        status: "running",
        currentStage: "plan",
        targetQuestionIds: [],
        buildIds: [],
        buildLinks: {},
        questions: {},
      })
    )
    expect(checkpoint.configFingerprint).toHaveLength(64)
    await store.flush()

    const reopened = new BuildAwareRunStore("run-create", root)
    expect(await reopened.exists()).toBeTrue()
    expect(await reopened.load()).toEqual(checkpoint)
  })

  test("excludes machine-local dataset path but rejects semantic config drift", async () => {
    const root = await temporaryRoot()
    const store = new BuildAwareRunStore("run-config", root)
    const original = await store.createOrLoad(runConfig())
    const moved = await store.createOrLoad(
      runConfig({ datasetPath: "/machine-b/moved/longmemeval-v2" })
    )
    expect(moved.configFingerprint).toBe(original.configFingerprint)

    await expect(
      store.createOrLoad(
        runConfig({
          retrieval: { ...runConfig().retrieval, topK: 10 },
        })
      )
    ).rejects.toThrow("different configuration")
    await expect(
      store.createOrLoad(
        runConfig({
          datasetRevision: "different-revision",
        })
      )
    ).rejects.toThrow("different configuration")
  })

  test("initializes questions idempotently and rejects every identity drift", async () => {
    const root = await temporaryRoot()
    const store = new BuildAwareRunStore("run-question", root)
    const checkpoint = await store.createOrLoad(runConfig())
    await store.initializeQuestion(checkpoint, question())
    await store.initializeQuestion(checkpoint, question())
    expect(checkpoint.questions.q1.stages).toEqual({
      query: { status: "pending" },
      read: { status: "pending" },
      evaluate: { status: "pending" },
    })

    for (const changed of [
      question({ question: "changed question" }),
      question({ groundTruth: "changed ground truth" }),
      question({ evalFunction: "mc_choice_match|require_non_empty=true" }),
      question({ buildId: "different-build" }),
      question({ questionImageHash: "different-image" }),
    ]) {
      await expect(store.initializeQuestion(checkpoint, changed)).rejects.toThrow(
        "changed since checkpoint"
      )
    }
  })

  test("persists shared build links and concurrent stage boundaries", async () => {
    const root = await temporaryRoot()
    const store = new BuildAwareRunStore("run-stages", root)
    const checkpoint = await store.createOrLoad(runConfig())
    checkpoint.targetQuestionIds = ["q1", "q2"]
    checkpoint.buildIds = ["shared-web-small-build"]
    checkpoint.buildLinks = {
      q1: "shared-web-small-build",
      q2: "shared-web-small-build",
    }
    await store.initializeQuestion(checkpoint, question())
    await store.initializeQuestion(
      checkpoint,
      question({
        questionId: "q2",
        question: "Which option?",
        groundTruth: "B",
        evalFunction: "mc_choice_match|require_non_empty=true",
        questionImageHash: undefined,
      })
    )

    await Promise.all([
      store.updateQuestionStage(checkpoint, "q1", "query", {
        status: "completed",
        fingerprint: "query-fingerprint",
        artifactPath: "queries/q1/record.json",
        durationMs: 125,
        cacheHit: false,
      }),
      store.updateQuestionStage(checkpoint, "q2", "query", {
        status: "failed",
        error: "provider unavailable",
        durationMs: 40,
      }),
    ])
    await store.setStage(checkpoint, "read")
    await store.flush()

    const reloaded = await new BuildAwareRunStore("run-stages", root).load()
    expect(reloaded.buildIds).toEqual(["shared-web-small-build"])
    expect(reloaded.buildLinks).toEqual({
      q1: "shared-web-small-build",
      q2: "shared-web-small-build",
    })
    expect(reloaded.questions.q1.stages.query).toEqual(
      expect.objectContaining({
        status: "completed",
        fingerprint: "query-fingerprint",
        cacheHit: false,
      })
    )
    expect(reloaded.questions.q2.stages.query).toEqual(
      expect.objectContaining({
        status: "failed",
        error: "provider unavailable",
      })
    )
    expect(reloaded.currentStage).toBe("read")
  })

  test("records run failure durably without losing question state", async () => {
    const root = await temporaryRoot()
    const store = new BuildAwareRunStore("run-failure", root)
    const checkpoint = await store.createOrLoad(runConfig())
    await store.initializeQuestion(checkpoint, question())
    await store.updateQuestionStage(checkpoint, "q1", "query", {
      status: "completed",
      artifactPath: "queries/q1/record.json",
    })
    await store.fail(checkpoint, new Error("reader failed"))
    await store.flush()

    const reloaded = await new BuildAwareRunStore("run-failure", root).load()
    expect(reloaded.status).toBe("failed")
    expect(reloaded.error).toBe("reader failed")
    expect(reloaded.questions.q1.stages.query.status).toBe("completed")

    await store.setStage(checkpoint, "read", "running")
    const resumed = await new BuildAwareRunStore("run-failure", root).load()
    expect(resumed.status).toBe("running")
    expect(resumed.currentStage).toBe("read")
    expect(resumed.error).toBeUndefined()
  })

  test("rejects corrupted schema, execution model, and run identity", async () => {
    const root = await temporaryRoot()
    const store = new BuildAwareRunStore("run-corrupt", root)
    const checkpoint = await store.createOrLoad(runConfig())
    for (const corruption of [
      { ...checkpoint, schemaVersion: 2 },
      { ...checkpoint, executionModel: "legacy-question-containers" },
      { ...checkpoint, runId: "another-run" },
    ]) {
      await writeFile(store.checkpointPath, `${JSON.stringify(corruption)}\n`)
      await expect(store.load()).rejects.toThrow("Invalid build-aware checkpoint")
    }
  })

  test("atomic checkpoint persistence leaves parseable JSON", async () => {
    const root = await temporaryRoot()
    const store = new BuildAwareRunStore("run-json", root)
    const checkpoint = await store.createOrLoad(runConfig())
    for (let index = 0; index < 10; index += 1) {
      await store.setStage(checkpoint, index % 2 === 0 ? "build" : "query")
      JSON.parse(await readFile(store.checkpointPath, "utf8"))
    }
    await store.flush()
    expect(JSON.parse(await readFile(store.checkpointPath, "utf8")).runId).toBe("run-json")
  })
})
