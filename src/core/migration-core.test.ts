import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type {
  BuildBatchRequest,
  BuildProvider,
  BuildSearchRequest,
  BuildSearchResponse,
  RemoteDocumentState,
} from "../types/provider"
import type {
  AssetRef,
  DocumentPlan,
  DocumentSpec,
  MemoryBuildPlan,
  NormalizedRetrievalResult,
  ProviderCapabilities,
  RetrievalConfig,
  ValidatedDocumentPlan,
} from "../types/migration"
import { ArtifactStore } from "./artifact-store"
import { BuildEngine } from "./build-engine"
import { BuildStore } from "./build-store"
import { canonicalJson, sha256, stableHash } from "./canonical"
import {
  createPhysicalDocuments,
  splitContent,
  type TrajectoryConverter,
  validateDocumentPlan,
} from "./document-plan"
import {
  buildFingerprint,
  evaluatorFingerprint,
  memoryBuildId,
  queryFingerprint,
  readerFingerprint,
} from "./fingerprints"
import { requireProviderCapabilities } from "./provider-capabilities"
import { QueryRunner } from "./query-runner"

const temporaryRoots: string[] = []

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

const CAPABILITIES: ProviderCapabilities = {
  deterministicExternalIds: true,
  batchUpload: true,
  documentDependencies: false,
  ingestionMetadataFilters: true,
  searchMetadataFilters: true,
  searchModes: ["hybrid", "memories"],
  reranking: true,
  queryRewriting: true,
  remoteClear: true,
  readinessStates: true,
  mediaIngestion: false,
  durableLocalPersistence: true,
  splitPhaseSafe: true,
}

const RETRIEVAL: RetrievalConfig = {
  topK: 2,
  threshold: 0,
  searchMode: "hybrid",
  rerank: true,
  rewriteQuery: false,
  includeSummaries: true,
  includeChunks: true,
  includeDocuments: true,
  includeRelatedMemories: false,
  metadataFilter: { runFingerprint: "build-fingerprint" },
}

function documentSpec(
  logicalDocumentId: string,
  content = `content-${logicalDocumentId}`,
  overrides: Partial<DocumentSpec> = {}
): DocumentSpec {
  return {
    logicalDocumentId,
    content,
    metadata: {},
    sourceStateIndices: [],
    localAttachmentPaths: [],
    dependsOn: [],
    allowParallelUpload: true,
    documentType: "state",
    allowDuplicateContent: false,
    ...overrides,
  }
}

class StaticConverter implements TrajectoryConverter<{ id: string }, { suffix?: string }> {
  readonly name = "test-converter"
  readonly version = 1
  readonly sourceHash = "source-hash"

  constructor(private readonly factory: () => DocumentPlan) {}

  convert(): DocumentPlan {
    return this.factory()
  }
}

function validatedPlan(
  trajectoryId: string,
  documents = [documentSpec("state-0000")],
  batchUpload = true
): ValidatedDocumentPlan {
  const plan: DocumentPlan = {
    trajectoryId,
    documents,
    batchUpload,
    declaredInvariants: ["test invariant"],
  }
  return validateDocumentPlan({
    plan,
    converter: new StaticConverter(() => plan),
    trajectory: { id: trajectoryId },
    context: {},
  })
}

function buildPlan(
  trajectoryIds = ["trajectory-1"],
  options: { documentCount?: number; fingerprint?: string } = {}
): MemoryBuildPlan {
  const fingerprint = options.fingerprint ?? "b".repeat(64)
  const plans = trajectoryIds.map((trajectoryId) =>
    validatedPlan(
      trajectoryId,
      Array.from({ length: options.documentCount ?? 1 }, (_, index) =>
        documentSpec(`state-${index.toString().padStart(4, "0")}`, `${trajectoryId}-${index}`)
      )
    )
  )
  const documents = plans.flatMap((plan) =>
    createPhysicalDocuments({
      plan,
      buildFingerprint: fingerprint,
      maxDocumentChars: 10_000,
    })
  )
  return {
    schemaVersion: 1,
    buildId: `build-${fingerprint.slice(0, 8)}`,
    benchmark: "longmemeval-v2",
    provider: "fake",
    datasetFingerprint: "dataset-fingerprint",
    tier: "small",
    domain: "web",
    orderedSourceIds: [...trajectoryIds],
    sourceContentHashes: trajectoryIds.map((id) => sha256(id)),
    converter: {
      name: "structured-accessibility",
      version: 1,
      sourceHash: "converter-source",
    },
    providerBuildConfig: { dreaming: "instant" },
    buildFingerprint: fingerprint,
    containerTag: `lme2-test-${fingerprint.slice(0, 12)}`,
    documentPlans: plans,
    documents,
  }
}

function result(
  rank: number,
  overrides: Partial<NormalizedRetrievalResult> = {}
): NormalizedRetrievalResult {
  return {
    rank,
    score: 1 - rank / 10,
    kind: "memory",
    text: `result-${rank}`,
    chunks: [],
    documentIds: [`remote-${rank}`],
    screenshotRefs: [],
    provenanceValid: true,
    ...overrides,
  }
}

class FakeBuildProvider implements BuildProvider {
  readonly name = "fake"
  readonly capabilities = CAPABILITIES
  readonly remote = new Map<string, RemoteDocumentState>()
  readonly submittedCustomIds: string[] = []
  submitCalls = 0
  reconcileCalls = 0
  searchCalls = 0
  deleteCalls = 0
  deleteFailure = false
  ambiguousSubmitOnce = false
  failuresBeforeStore = 0
  permanentFailure = false
  reconcileDelayMs = 0
  pollsBeforeReady = 0
  searchResults: NormalizedRetrievalResult[] = [result(0)]
  remoteDurationMs = 321

  async submitDocumentBatch(request: BuildBatchRequest): Promise<RemoteDocumentState[]> {
    this.submitCalls += 1
    if (this.failuresBeforeStore > 0) {
      this.failuresBeforeStore -= 1
      throw new Error("transport failed before remote store")
    }
    const states = request.documents.map((document) => {
      this.submittedCustomIds.push(document.customId)
      const state: RemoteDocumentState = this.permanentFailure
        ? {
            customId: document.customId,
            remoteId: `remote-${document.customId}`,
            status: "failed",
            error: "permanent remote failure",
          }
        : {
            customId: document.customId,
            remoteId: `remote-${document.customId}`,
            status: this.pollsBeforeReady > 0 ? "pending" : "ready",
          }
      this.remote.set(document.customId, state)
      return { ...state }
    })
    if (this.ambiguousSubmitOnce) {
      this.ambiguousSubmitOnce = false
      throw new Error("response lost after remote success")
    }
    return states
  }

  async reconcileDocuments(
    _build: MemoryBuildPlan,
    customIds: string[]
  ): Promise<RemoteDocumentState[]> {
    this.reconcileCalls += 1
    if (this.reconcileDelayMs > 0) await Bun.sleep(this.reconcileDelayMs)
    return customIds.map((customId) => {
      const current = this.remote.get(customId)
      if (!current) return { customId, status: "absent" }
      if (current.status === "pending" && this.reconcileCalls > this.pollsBeforeReady) {
        const ready = { ...current, status: "ready" as const }
        this.remote.set(customId, ready)
        return ready
      }
      return { ...current }
    })
  }

  async searchBuild(request: BuildSearchRequest): Promise<BuildSearchResponse> {
    this.searchCalls += 1
    return {
      request: {
        containerTag: request.build.containerTag,
        filters: { runFingerprint: request.build.buildFingerprint },
        limit: request.config.topK,
      },
      rawResponse: { results: this.searchResults },
      normalizedResults: this.searchResults.map((item) => ({ ...item })),
      remoteDurationMs: this.remoteDurationMs,
    }
  }

  async verifyBuildHealth(build: MemoryBuildPlan): Promise<RemoteDocumentState[]> {
    return build.documents.map(
      (document) =>
        this.remote.get(document.customId) ?? {
          customId: document.customId,
          status: "absent",
        }
    )
  }

  async deleteDocuments(_build: MemoryBuildPlan, customIds: string[]): Promise<void> {
    this.deleteCalls += 1
    if (this.deleteFailure) throw new Error("HTTP 409: document is still processing")
    for (const customId of customIds) this.remote.delete(customId)
  }

  async clearBuild(): Promise<void> {
    this.remote.clear()
  }
}

describe("canonical values and four-level fingerprints", () => {
  test("canonical JSON is key-order stable and rejects unsafe values", () => {
    expect(canonicalJson({ z: 1, a: { d: 4, b: 2 }, omitted: undefined })).toBe(
      '{"a":{"b":2,"d":4},"z":1}'
    )
    expect(stableHash({ a: 1, b: 2 })).toBe(stableHash({ b: 2, a: 1 }))
    expect(() => canonicalJson({ bad: Number.NaN })).toThrow("non-finite")
    expect(() => canonicalJson({ bad: BigInt(1) })).toThrow("bigint")
    expect(() => canonicalJson({ bad: () => true })).toThrow("function")
  })

  test("build identity is deterministic, order-sensitive, and independent from query settings", () => {
    const input = {
      benchmark: "longmemeval-v2",
      datasetFingerprint: "dataset",
      tier: "small",
      domain: "web",
      orderedSourceIds: ["a", "b"],
      sourceContentHashes: ["ha", "hb"],
      converter: { name: "structured", version: 1, sourceHash: "source" },
      validatedPlanHashes: ["pa", "pb"],
      provider: "supermemory",
      providerBuildConfig: { dreaming: "instant", metadata: { b: 2, a: 1 } },
      documentPlanVersion: 1,
      splitterVersion: 1,
    }
    const first = buildFingerprint(input)
    expect(buildFingerprint({ ...input })).toBe(first)
    expect(
      buildFingerprint({
        ...input,
        providerBuildConfig: { metadata: { a: 1, b: 2 }, dreaming: "instant" },
      })
    ).toBe(first)
    expect(buildFingerprint({ ...input, orderedSourceIds: ["b", "a"] })).not.toBe(first)
    expect(buildFingerprint({ ...input, sourceContentHashes: ["changed", "hb"] })).not.toBe(first)
    expect(memoryBuildId({ buildFingerprint: first })).toBe(`mb-${first.slice(0, 24)}`)
  })

  test("query, reader, and evaluator fingerprints invalidate only their dependencies", () => {
    const queryA = queryFingerprint({
      buildFingerprint: "build",
      questionText: "question",
      retrieval: RETRIEVAL,
      normalizerVersion: 1,
    })
    const queryB = queryFingerprint({
      buildFingerprint: "build",
      questionText: "question",
      retrieval: { ...RETRIEVAL, topK: 1 },
      normalizerVersion: 1,
    })
    expect(queryB).not.toBe(queryA)

    const queryArtifact = {
      queryFingerprint: queryA,
      normalizedResults: [result(0)],
    }
    const readerA = readerFingerprint({
      queryArtifact,
      model: "gpt-5",
      settings: { reasoningEffort: "high" },
      promptVersion: "p1",
      imageHashes: ["image-a"],
      contextBudgetVersion: "budget-1",
    })
    expect(
      readerFingerprint({
        queryArtifact,
        model: "gpt-5",
        settings: { reasoningEffort: "high" },
        promptVersion: "p1",
        imageHashes: ["image-b"],
        contextBudgetVersion: "budget-1",
      })
    ).not.toBe(readerA)

    const evaluatorA = evaluatorFingerprint({
      answerArtifactHash: "answer",
      groundTruth: "gold",
      evalFunction: "mc_choice_match|require_non_empty=true",
      settings: {},
      promptVersion: "prompt-1",
      implementationVersion: "implementation-1",
    })
    expect(
      evaluatorFingerprint({
        answerArtifactHash: "answer",
        groundTruth: "gold",
        evalFunction: "mc_choice_match|require_non_empty=true",
        settings: {},
        promptVersion: "prompt-2",
        implementationVersion: "implementation-1",
      })
    ).not.toBe(evaluatorA)
  })
})

describe("document-plan validation and lossless physical documents", () => {
  test("validates deterministic plans and creates stable custom IDs", () => {
    const plan: DocumentPlan = {
      trajectoryId: "trajectory",
      documents: [
        documentSpec("overview", "goal"),
        documentSpec("state", "observed state", {
          dependsOn: ["overview"],
          allowParallelUpload: false,
        }),
      ],
      batchUpload: false,
      declaredInvariants: ["no question leakage"],
    }
    const converter = new StaticConverter(() => plan)
    const validatedA = validateDocumentPlan({
      plan,
      converter,
      trajectory: { id: "trajectory" },
      context: {},
    })
    const validatedB = validateDocumentPlan({
      plan,
      converter,
      trajectory: { id: "trajectory" },
      context: {},
    })
    expect(validatedA.planHash).toBe(validatedB.planHash)
    expect(validatedA.documents[1].dependsOnOrdinals).toEqual([0])
    const physicalA = createPhysicalDocuments({
      plan: validatedA,
      buildFingerprint: "f".repeat(64),
      maxDocumentChars: 100,
    })
    const physicalB = createPhysicalDocuments({
      plan: validatedB,
      buildFingerprint: "f".repeat(64),
      maxDocumentChars: 100,
    })
    expect(physicalA).toEqual(physicalB)
    expect(physicalA.every((item) => /^lme2-[a-f0-9]{56}$/.test(item.customId))).toBeTrue()
  })

  test("rejects malformed identities, metadata, dependencies, duplicate content, and drift", () => {
    const cases: Array<{ plan: DocumentPlan; message: string }> = [
      {
        plan: {
          trajectoryId: "t",
          documents: [documentSpec("bad id")],
          batchUpload: false,
          declaredInvariants: [],
        },
        message: "invalid logicalDocumentId",
      },
      {
        plan: {
          trajectoryId: "t",
          documents: [documentSpec("a", "a", { metadata: { runFingerprint: "x" } })],
          batchUpload: false,
          declaredInvariants: [],
        },
        message: "reserved",
      },
      {
        plan: {
          trajectoryId: "t",
          documents: [
            documentSpec("a", "a", { dependsOn: ["b"] }),
            documentSpec("b", "b", { dependsOn: ["a"] }),
          ],
          batchUpload: false,
          declaredInvariants: [],
        },
        message: "cycle",
      },
      {
        plan: {
          trajectoryId: "t",
          documents: [documentSpec("a", "same"), documentSpec("b", "same")],
          batchUpload: false,
          declaredInvariants: [],
        },
        message: "duplicates",
      },
      {
        plan: {
          trajectoryId: "t",
          documents: [documentSpec("a", "a"), documentSpec("b", "b", { dependsOn: ["a"] })],
          batchUpload: true,
          declaredInvariants: [],
        },
        message: "batch-upload",
      },
    ]
    for (const item of cases) {
      expect(() =>
        validateDocumentPlan({
          plan: item.plan,
          converter: new StaticConverter(() => item.plan),
          trajectory: { id: "t" },
          context: {},
        })
      ).toThrow(item.message)
    }

    let call = 0
    const nondeterministic = new StaticConverter(() => ({
      trajectoryId: "t",
      documents: [documentSpec("a", `content-${call++}`)],
      batchUpload: false,
      declaredInvariants: [],
    }))
    const first = nondeterministic.convert()
    expect(() =>
      validateDocumentPlan({
        plan: first,
        converter: nondeterministic,
        trajectory: { id: "t" },
        context: {},
      })
    ).toThrow("non-deterministic")
  })

  test("splits losslessly but rejects oversized documents in a batch plan", () => {
    const content = `${"paragraph words ".repeat(80)}\n\n${"尾".repeat(80)}`
    const parts = splitContent(content, 100)
    expect(parts.join("")).toBe(content)
    expect(parts.every((part) => part.length > 0 && part.length <= 100)).toBeTrue()
    expect(splitContent(content, 100)).toEqual(parts)
    expect(() => splitContent("x", 0)).toThrow("integer >= 1")

    const plan = validatedPlan("trajectory", [documentSpec("state", "x".repeat(101))])
    expect(() =>
      createPhysicalDocuments({
        plan,
        buildFingerprint: "f".repeat(64),
        maxDocumentChars: 100,
      })
    ).toThrow("batch document cannot be split")
  })
})

describe("provider capability gate", () => {
  test("fails before work when required capabilities are absent", () => {
    expect(() =>
      requireProviderCapabilities("fake", CAPABILITIES, [
        "deterministicExternalIds",
        "batchUpload",
        "searchMetadataFilters",
      ])
    ).not.toThrow()
    expect(() =>
      requireProviderCapabilities(
        "weak",
        { ...CAPABILITIES, batchUpload: false, searchModes: [] },
        ["batchUpload", "searchModes"]
      )
    ).toThrow("batchUpload, searchModes")
  })
})

describe("SQLite build checkpoint and leases", () => {
  test("registers idempotently, survives reopen, and rejects plan drift", async () => {
    const root = await temporaryRoot("memorybench-build-store-")
    const path = join(root, "checkpoint.sqlite3")
    const plan = buildPlan(["t1", "t2"], { documentCount: 2 })
    let store = new BuildStore(path)
    store.registerBuild(plan)
    store.registerBuild(plan)
    expect(store.buildSummary(plan.buildId)).toEqual({
      trajectories: {
        planned: 2,
        processing: 0,
        ready: 0,
        retryable: 0,
        failed: 0,
      },
      documents: {
        planned: 4,
        submitting: 0,
        accepted: 0,
        indexing: 0,
        ready: 0,
        retryable: 0,
        failed: 0,
      },
    })
    store.close()

    store = new BuildStore(path)
    expect(store.getBuild(plan.buildId)?.buildFingerprint).toBe(plan.buildFingerprint)
    expect(() => store.registerBuild({ ...plan, containerTag: "different-container" })).toThrow(
      "does not match"
    )
    store.close()
  })

  test("enforces lease ownership, renewal, expiry, and the all-ready barrier", async () => {
    const root = await temporaryRoot("memorybench-build-lease-")
    const plan = buildPlan()
    const storeA = new BuildStore(join(root, "checkpoint.sqlite3"))
    const storeB = new BuildStore(join(root, "checkpoint.sqlite3"))
    storeA.registerBuild(plan)
    expect(storeA.claimTrajectory(plan.buildId, "worker-a", 20)).toBe("trajectory-1")
    expect(storeB.claimTrajectory(plan.buildId, "worker-b", 20)).toBeNull()
    expect(() => storeB.renewTrajectoryLease(plan.buildId, "trajectory-1", "worker-b", 20)).toThrow(
      "no longer owns"
    )
    expect(() => storeA.markTrajectoryReady(plan.buildId, "trajectory-1", "worker-a")).toThrow(
      "documents are not ready"
    )
    storeA.renewTrajectoryLease(plan.buildId, "trajectory-1", "worker-a", 20)
    await Bun.sleep(5)
    expect(storeB.claimTrajectory(plan.buildId, "worker-b", 20)).toBeNull()
    await Bun.sleep(25)
    expect(storeB.claimTrajectory(plan.buildId, "worker-b", 20)).toBe("trajectory-1")
    storeA.close()
    storeB.close()
  })

  test("persists the ambiguous submitting state across a simulated crash", async () => {
    const root = await temporaryRoot("memorybench-build-crash-")
    const path = join(root, "checkpoint.sqlite3")
    const plan = buildPlan()
    let store = new BuildStore(path)
    store.registerBuild(plan)
    expect(store.claimTrajectory(plan.buildId, "crashed-worker", 1)).toBe("trajectory-1")
    store.markDocumentSubmitting(plan.documents[0].customId)
    store.close()

    store = new BuildStore(path)
    expect(store.getAmbiguousDocuments(plan.buildId)).toEqual([
      expect.objectContaining({
        customId: plan.documents[0].customId,
        status: "submitting",
        attempts: 1,
      }),
    ])
    store.close()
  })
})

describe("durable build engine", () => {
  const options = {
    trajectoryConcurrency: 2,
    maxTrajectoryAttempts: 3,
    indexingTimeoutMs: 2_000,
    pollIntervalMs: 1,
    leaseMs: 100,
    sleep: async () => {},
  }

  test("builds concurrently and an identical rerun performs zero uploads", async () => {
    const root = await temporaryRoot("memorybench-engine-idempotent-")
    const plan = buildPlan(["t1", "t2", "t3"], { documentCount: 2 })
    const provider = new FakeBuildProvider()
    const store = new BuildStore(join(root, "checkpoint.sqlite3"))
    const engine = new BuildEngine(plan, provider, store, options)
    await engine.run()
    expect(store.getBuild(plan.buildId)?.status).toBe("ready")
    expect(provider.submitCalls).toBe(3)
    expect(new Set(provider.submittedCustomIds).size).toBe(plan.documents.length)
    await engine.run()
    expect(provider.submitCalls).toBe(3)
    await engine.verifyRemoteHealth()
    store.close()
  })

  test("reconciles a response lost after remote success without duplication", async () => {
    const root = await temporaryRoot("memorybench-engine-ambiguous-")
    const plan = buildPlan()
    const provider = new FakeBuildProvider()
    provider.ambiguousSubmitOnce = true
    const store = new BuildStore(join(root, "checkpoint.sqlite3"))
    await new BuildEngine(plan, provider, store, options).run()
    expect(provider.submitCalls).toBe(1)
    expect(provider.submittedCustomIds).toEqual([plan.documents[0].customId])
    expect(provider.reconcileCalls).toBeGreaterThan(0)
    expect(store.buildSummary(plan.buildId).documents.ready).toBe(1)
    store.close()
  })

  test("resumes a crash before remote submission and retries a transport failure", async () => {
    const root = await temporaryRoot("memorybench-engine-resume-")
    const plan = buildPlan()
    const store = new BuildStore(join(root, "checkpoint.sqlite3"))
    store.registerBuild(plan)
    expect(store.claimTrajectory(plan.buildId, "dead-worker", 1)).toBe("trajectory-1")
    store.markDocumentSubmitting(plan.documents[0].customId)
    await Bun.sleep(3)

    const provider = new FakeBuildProvider()
    provider.failuresBeforeStore = 1
    await new BuildEngine(plan, provider, store, options).run()
    expect(provider.submitCalls).toBe(2)
    expect(provider.submittedCustomIds).toEqual([plan.documents[0].customId])
    expect(store.getBuild(plan.buildId)?.status).toBe("ready")
    store.close()
  })

  test("waits for an unexpired crashed-worker lease instead of failing the build", async () => {
    const root = await temporaryRoot("memorybench-engine-live-lease-resume-")
    const plan = buildPlan()
    const store = new BuildStore(join(root, "checkpoint.sqlite3"))
    store.registerBuild(plan)
    expect(store.claimTrajectory(plan.buildId, "dead-worker", 40)).toBe("trajectory-1")
    store.markDocumentSubmitting(plan.documents[0].customId)

    const provider = new FakeBuildProvider()
    await new BuildEngine(plan, provider, store, {
      ...options,
      pollIntervalMs: 5,
      leaseMs: 100,
      sleep: (milliseconds) => Bun.sleep(milliseconds),
    }).run()

    expect(provider.submitCalls).toBe(1)
    expect(store.getTrajectoryAttempt(plan.buildId, "trajectory-1")).toBe(2)
    expect(store.getBuild(plan.buildId)?.status).toBe("ready")
    store.close()
  })

  test("never marks a partial or permanently failed build ready", async () => {
    const root = await temporaryRoot("memorybench-engine-failure-")
    const plan = buildPlan()
    const provider = new FakeBuildProvider()
    provider.permanentFailure = true
    const store = new BuildStore(join(root, "checkpoint.sqlite3"))
    await expect(
      new BuildEngine(plan, provider, store, {
        ...options,
        maxTrajectoryAttempts: 2,
      }).run()
    ).rejects.toThrow("Build failed")
    expect(store.getBuild(plan.buildId)?.status).toBe("failed")
    expect(store.buildSummary(plan.buildId).documents.failed).toBe(1)
    expect(provider.submitCalls).toBe(2)
    store.close()
  })

  test("degrades after bounded cleanup conflicts leave documents indexing in non-strict mode", async () => {
    const root = await temporaryRoot("memorybench-engine-degraded-bounded-failure-")
    const plan = buildPlan()
    const provider = new FakeBuildProvider()
    provider.pollsBeforeReady = Number.MAX_SAFE_INTEGER
    provider.deleteFailure = true
    const store = new BuildStore(join(root, "checkpoint.sqlite3"))
    const engine = new BuildEngine(plan, provider, store, {
      ...options,
      maxTrajectoryAttempts: 2,
      indexingTimeoutMs: 10,
      pollIntervalMs: 1,
      continueOnIndexingTimeout: true,
      sleep: (milliseconds) => Bun.sleep(milliseconds),
    })

    expect(await engine.run()).toBe("degraded")
    expect(provider.submitCalls).toBe(1)
    expect(provider.deleteCalls).toBe(2)
    expect(store.getBuild(plan.buildId)).toMatchObject({
      status: "degraded",
      error: expect.stringContaining("bounded ingestion failures"),
    })
    expect(store.buildSummary(plan.buildId)).toEqual({
      trajectories: {
        planned: 0,
        processing: 0,
        ready: 0,
        retryable: 0,
        failed: 1,
      },
      documents: {
        planned: 0,
        submitting: 0,
        accepted: 0,
        indexing: 1,
        ready: 0,
        retryable: 0,
        failed: 0,
      },
    })
    await engine.verifyRemoteHealth({ allowDegraded: true })
    store.close()
  })

  test("bounds indexing waits and records an explicit degraded build", async () => {
    const root = await temporaryRoot("memorybench-engine-degraded-timeout-")
    const plan = buildPlan()
    const provider = new FakeBuildProvider()
    provider.pollsBeforeReady = Number.MAX_SAFE_INTEGER
    const store = new BuildStore(join(root, "checkpoint.sqlite3"))
    const engine = new BuildEngine(plan, provider, store, {
      ...options,
      indexingTimeoutMs: 10,
      pollIntervalMs: 1,
      continueOnIndexingTimeout: true,
      sleep: (milliseconds) => Bun.sleep(milliseconds),
    })

    expect(await engine.run()).toBe("degraded")
    expect(provider.submitCalls).toBe(1)
    expect(provider.deleteCalls).toBe(1)
    expect(store.getTrajectoryAttempt(plan.buildId, "trajectory-1")).toBe(1)
    expect(store.getBuild(plan.buildId)?.status).toBe("degraded")
    expect(store.buildSummary(plan.buildId)).toEqual({
      trajectories: {
        planned: 0,
        processing: 0,
        ready: 0,
        retryable: 0,
        failed: 1,
      },
      documents: {
        planned: 0,
        submitting: 0,
        accepted: 0,
        indexing: 0,
        ready: 0,
        retryable: 0,
        failed: 1,
      },
    })
    await engine.verifyRemoteHealth({ allowDegraded: true })

    expect(await engine.run()).toBe("degraded")
    expect(provider.submitCalls).toBe(1)
    expect(provider.deleteCalls).toBe(1)
    store.close()
  })

  test("renews the trajectory lease while a provider poll is slow", async () => {
    const root = await temporaryRoot("memorybench-engine-heartbeat-")
    const plan = buildPlan()
    const provider = new FakeBuildProvider()
    provider.pollsBeforeReady = 1
    provider.reconcileDelayMs = 180
    const path = join(root, "checkpoint.sqlite3")
    const store = new BuildStore(path)
    const observer = new BuildStore(path)
    const run = new BuildEngine(plan, provider, store, {
      ...options,
      leaseMs: 90,
      pollIntervalMs: 10,
      sleep: async () => {},
    }).run()
    await Bun.sleep(120)
    expect(observer.claimTrajectory(plan.buildId, "lease-thief", 90)).toBeNull()
    await run
    store.close()
    observer.close()
  })

  test("a user stop leaves a claimed trajectory retryable and the next run resumes it", async () => {
    const root = await temporaryRoot("memorybench-engine-user-stop-")
    const plan = buildPlan()
    const provider = new FakeBuildProvider()
    provider.pollsBeforeReady = Number.MAX_SAFE_INTEGER
    provider.reconcileDelayMs = 30
    const store = new BuildStore(join(root, "checkpoint.sqlite3"))
    const controller = new AbortController()
    const run = new BuildEngine(plan, provider, store, {
      ...options,
      signal: controller.signal,
      sleep: (milliseconds, signal) =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, milliseconds)
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer)
              reject(signal.reason ?? new Error("stopped"))
            },
            { once: true }
          )
        }),
    }).run()
    await Bun.sleep(5)
    controller.abort(new Error("Stopped from UI"))
    await expect(run).rejects.toThrow("Stopped from UI")
    expect(store.buildSummary(plan.buildId).trajectories.retryable).toBe(1)
    expect(store.buildSummary(plan.buildId).trajectories.failed).toBe(0)

    provider.pollsBeforeReady = 0
    provider.reconcileDelayMs = 0
    await new BuildEngine(plan, provider, store, options).run()
    expect(store.getBuild(plan.buildId)?.status).toBe("ready")
    store.close()
  })
})

describe("artifact safety and immutable query execution", () => {
  test("redacts credentials without destroying non-secret token metrics", async () => {
    const root = await temporaryRoot("memorybench-artifacts-redaction-")
    const envName = "MEMORYBENCH_TEST_SECRET"
    const previous = process.env[envName]
    process.env[envName] = "known-secret-value-12345"
    try {
      const store = new ArtifactStore(root, [envName])
      await store.writeJson("safe/result.json", {
        apiKey: "key-by-name",
        authorization: "Bearer hidden",
        nested: {
          value: process.env[envName],
          generated: "sm_abcdefghijklmnopqrstuvwxyz",
          prompt_tokens: 42,
        },
      })
      const text = await readFile(join(root, "safe/result.json"), "utf8")
      expect(text).not.toContain("known-secret-value-12345")
      expect(text).not.toContain("sm_abcdefghijklmnopqrstuvwxyz")
      expect(text).not.toContain("key-by-name")
      expect(text).toContain('"prompt_tokens": 42')
    } finally {
      if (previous === undefined) delete process.env[envName]
      else process.env[envName] = previous
    }
  })

  test("rejects traversal and symlink escapes from the artifact root", async () => {
    const root = await temporaryRoot("memorybench-artifacts-root-")
    const outside = await temporaryRoot("memorybench-artifacts-outside-")
    const store = new ArtifactStore(root)
    expect(() => store.resolve("../outside.json")).toThrow("inside")
    await symlink(outside, join(root, "escape"))
    await expect(store.writeJson("escape/leak.json", { leaked: true })).rejects.toThrow("symlink")
  })

  test("immutable writes are idempotent and reject collisions", async () => {
    const root = await temporaryRoot("memorybench-artifacts-immutable-")
    const store = new ArtifactStore(root)
    const first = await store.writeImmutable("immutable/value.bin", Buffer.from("first"))
    const second = await store.writeImmutable("immutable/value.bin", Buffer.from("first"))
    expect(second).toEqual(first)
    await expect(
      store.writeImmutable("immutable/value.bin", Buffer.from("different"))
    ).rejects.toThrow("collision")
  })

  test("query cache preserves remote timing and invalidates by retrieval config", async () => {
    const root = await temporaryRoot("memorybench-query-cache-")
    const artifacts = new ArtifactStore(root)
    const provider = new FakeBuildProvider()
    const build = buildPlan()
    const runner = new QueryRunner(provider, artifacts)
    const first = await runner.run({
      build,
      questionId: "question-1",
      query: "Where is the setting?",
      config: RETRIEVAL,
    })
    const second = await runner.run({
      build,
      questionId: "question-1",
      query: "Where is the setting?",
      config: RETRIEVAL,
    })
    expect(first.cacheHit).toBeFalse()
    expect(second.cacheHit).toBeTrue()
    expect(second.remoteDurationMs).toBe(321)
    expect(second.wallDurationMs).toBeGreaterThanOrEqual(0)
    expect(provider.searchCalls).toBe(1)

    await runner.run({
      build,
      questionId: "question-1",
      query: "Where is the setting?",
      config: { ...RETRIEVAL, topK: 1 },
    })
    expect(provider.searchCalls).toBe(2)
  })

  test("rejects provider topK and provenance violations before persisting a record", async () => {
    const root = await temporaryRoot("memorybench-query-contract-")
    const artifacts = new ArtifactStore(root)
    const provider = new FakeBuildProvider()
    const runner = new QueryRunner(provider, artifacts)
    provider.searchResults = [result(0), result(1), result(2)]
    await expect(
      runner.run({
        build: buildPlan(),
        questionId: "too-many",
        query: "query",
        config: RETRIEVAL,
      })
    ).rejects.toThrow("violated topK")

    provider.searchResults = [result(0, { provenanceValid: false })]
    await expect(
      runner.run({
        build: buildPlan(),
        questionId: "wrong-provenance",
        query: "query",
        config: RETRIEVAL,
      })
    ).rejects.toThrow("wrong build provenance")
  })

  test("does not accept a cache record whose identity was tampered", async () => {
    const root = await temporaryRoot("memorybench-query-tamper-")
    const artifacts = new ArtifactStore(root)
    const provider = new FakeBuildProvider()
    const build = buildPlan()
    const runner = new QueryRunner(provider, artifacts)
    const first = await runner.run({
      build,
      questionId: "question-tamper",
      query: "query",
      config: RETRIEVAL,
    })
    const directory = join(root, "queries", "question-tamper", first.queryFingerprint)
    const recordName = (await Array.fromAsync(new Bun.Glob("*.record.json").scan(directory)))[0]
    const recordPath = join(directory, recordName)
    const record = JSON.parse(await readFile(recordPath, "utf8"))
    record.questionId = "different-question"
    record.queryFingerprint = "wrong-fingerprint"
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`)

    const second = await runner.run({
      build,
      questionId: "question-tamper",
      query: "query",
      config: RETRIEVAL,
    })
    expect(second.cacheHit).toBeFalse()
    expect(provider.searchCalls).toBe(2)
  })

  test("a missing normalized artifact forces a fresh provider query", async () => {
    const root = await temporaryRoot("memorybench-query-partial-")
    const artifacts = new ArtifactStore(root)
    const provider = new FakeBuildProvider()
    const build = buildPlan()
    const runner = new QueryRunner(provider, artifacts)
    const first = await runner.run({
      build,
      questionId: "question-partial",
      query: "query",
      config: RETRIEVAL,
    })
    await unlink(artifacts.resolve(first.normalizedArtifact.relativePath))
    const second = await runner.run({
      build,
      questionId: "question-partial",
      query: "query",
      config: RETRIEVAL,
    })
    expect(second.cacheHit).toBeFalse()
    expect(provider.searchCalls).toBe(2)
  })

  test("materialized assets are content-addressed and reject changed bytes", async () => {
    const root = await temporaryRoot("memorybench-assets-")
    const sourceRoot = await temporaryRoot("memorybench-assets-source-")
    const source = join(sourceRoot, "image.png")
    await writeFile(source, "image-bytes")
    const bytes = Buffer.from("image-bytes")
    const asset: AssetRef = {
      assetId: "asset-1",
      kind: "trajectory-screenshot",
      absolutePath: source,
      relativePath: "screenshots/image.png",
      mimeType: "image/png",
      sha256: sha256(bytes),
      byteLength: bytes.byteLength,
    }
    const stored = await new ArtifactStore(root).materializeAsset(asset)
    expect(stored.relativePath).toBe(`assets/${asset.sha256}.png`)
    expect(await readFile(stored.absolutePath!, "utf8")).toBe("image-bytes")
    await writeFile(source, "changed")
    await expect(new ArtifactStore(root).materializeAsset(asset)).rejects.toThrow("bytes changed")
  })
})
