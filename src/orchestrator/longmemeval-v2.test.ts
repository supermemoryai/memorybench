import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import {
  AUDITED_LONGMEMEVAL_V2_DATASET_VALIDATION,
  type LongMemEvalV2DatasetValidationProfile,
} from "../benchmarks/longmemeval-v2/dataset"
import type {
  ReaderModelClient,
  ReaderModelRequest,
  ReaderModelResponse,
} from "../benchmarks/longmemeval-v2/reader"
import {
  type StrictJudgeCallback,
  type StrictJudgeRequest,
} from "../benchmarks/longmemeval-v2/evaluation"
import { LONGMEMEVAL_V2_PINNED_REVISION } from "../benchmarks/longmemeval-v2/source"
import { longMemEvalV2Command } from "../cli/commands/longmemeval-v2"
import { atomicWriteJson, sha256 } from "../core/canonical"
import {
  supermemoryPreflightGatePath,
  type SupermemoryPreflightReport,
} from "../providers/supermemory/advanced"
import type { BuildAwareReport, BuildAwareRunConfig } from "../types/build-aware"
import type {
  BuildBatchRequest,
  BuildProvider,
  BuildSearchRequest,
  BuildSearchResponse,
  RemoteDocumentState,
} from "../types/provider"
import type { MemoryBuildPlan, ProviderCapabilities } from "../types/migration"
import { LongMemEvalV2Runner, limitLongMemEvalV2Haystacks } from "./longmemeval-v2"

const temporaryRoots: string[] = []
const PNG_BYTES = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])

test("haystack limiting keeps complete deterministic builds and their linked questions", () => {
  const question = (id: string, buildKey: string) =>
    ({ question: { id }, buildKey }) as unknown as Parameters<
      typeof limitLongMemEvalV2Haystacks
    >[0]["questions"][number]
  const build = (buildKey: string) =>
    ({ buildKey }) as Parameters<typeof limitLongMemEvalV2Haystacks>[0]["builds"][number]
  const planned = {
    questions: [question("q-1", "build-a"), question("q-2", "build-b"), question("q-3", "build-a")],
    builds: [build("build-a"), build("build-b")],
  }

  const limited = limitLongMemEvalV2Haystacks(planned, 1)
  expect(limited.builds.map((item) => item.buildKey)).toEqual(["build-a"])
  expect(limited.questions.map((item) => item.question.id)).toEqual(["q-1", "q-3"])
  expect(() => limitLongMemEvalV2Haystacks(planned, 3)).toThrow("exceeds 2 available")
})

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memorybench-lme2-runner-"))
  temporaryRoots.push(root)
  return root
}

interface MiniDatasetFixture {
  root: string
  validationProfile: LongMemEvalV2DatasetValidationProfile
}

async function writeMiniDataset(root: string): Promise<MiniDatasetFixture> {
  const datasetRoot = resolve(root, "dataset")
  await mkdir(resolve(datasetRoot, "haystacks"), { recursive: true })
  await mkdir(resolve(datasetRoot, "screenshots/trajectory-1"), { recursive: true })
  await mkdir(resolve(datasetRoot, "question_screenshots"), { recursive: true })

  const trajectoryScreenshot = Buffer.concat([PNG_BYTES, Buffer.from("trajectory")])
  const questionScreenshot = Buffer.concat([PNG_BYTES, Buffer.from("question")])
  await writeFile(resolve(datasetRoot, "screenshots/trajectory-1/0.png"), trajectoryScreenshot)
  await writeFile(resolve(datasetRoot, "question_screenshots/gotcha.png"), questionScreenshot)

  const questions = [
    {
      id: "q-gotcha",
      domain: "web",
      environment: "browser",
      question_type: "errors-gotchas",
      question: "What is the gotcha?",
      image: "question_screenshots/gotcha.png",
      answer: "The visible toggle is read-only",
      eval_function: "llm_gotchas_checker|require_non_empty=true",
    },
    {
      id: "q-choice",
      domain: "web",
      environment: "browser",
      question_type: "static-environment",
      question: "Which option was selected?",
      image: null,
      answer: "B",
      eval_function: "mc_choice_match|require_non_empty=true",
    },
  ]
  const trajectories = [
    {
      id: "trajectory-1",
      domain: "web",
      goal: "Inspect the visible setting",
      start_url: "https://example.test/settings",
      outcome: "The toggle was read-only and option B was selected.",
      states: [
        {
          state_index: 0,
          step: 0,
          url: "https://example.test/settings",
          action: null,
          thought: "Inspect the setting",
          accessibility_tree:
            "heading 'Settings'\nswitch 'Visible toggle', disabled=true\nradio 'B', checked=true",
          screenshot: "screenshots/trajectory-1/0.png",
        },
      ],
    },
  ]
  const haystacks = {
    "q-gotcha": ["trajectory-1"],
    "q-choice": ["trajectory-1"],
  }
  const files = new Map<string, Buffer>([
    [
      "questions.jsonl",
      Buffer.from(questions.map((value) => `${JSON.stringify(value)}\n`).join("")),
    ],
    [
      "trajectories.jsonl",
      Buffer.from(trajectories.map((value) => `${JSON.stringify(value)}\n`).join("")),
    ],
    ["haystacks/lme_v2_small.json", Buffer.from(`${JSON.stringify(haystacks)}\n`)],
  ])
  for (const [relativePath, bytes] of files) {
    await writeFile(resolve(datasetRoot, relativePath), bytes)
  }

  return {
    root: datasetRoot,
    validationProfile: {
      expectedCounts: {
        questions: 2,
        trajectories: 1,
        states: 1,
        assets: 2,
        uniqueBuilds: { small: 1, medium: 1 },
      },
      requiredFiles: Object.fromEntries(
        [...files].map(([relativePath, bytes]) => [
          relativePath,
          { sha256: sha256(bytes), byteLength: bytes.byteLength },
        ])
      ),
    },
  }
}

const CAPABILITIES: ProviderCapabilities = {
  deterministicExternalIds: true,
  batchUpload: true,
  documentDependencies: false,
  ingestionMetadataFilters: true,
  searchMetadataFilters: true,
  searchModes: ["hybrid"],
  reranking: true,
  queryRewriting: false,
  remoteClear: true,
  readinessStates: true,
  mediaIngestion: false,
  durableLocalPersistence: true,
  splitPhaseSafe: true,
}

class FakeBuildProvider implements BuildProvider {
  readonly name = "fake-build-provider"
  readonly capabilities = CAPABILITIES
  readonly remote = new Map<string, RemoteDocumentState>()
  submitCalls = 0
  reconcileCalls = 0
  searchCalls = 0

  async submitDocumentBatch(request: BuildBatchRequest): Promise<RemoteDocumentState[]> {
    this.submitCalls += 1
    return request.documents.map((document) => {
      const state: RemoteDocumentState = {
        customId: document.customId,
        remoteId: `remote-${document.customId}`,
        status: "ready",
      }
      this.remote.set(document.customId, state)
      return { ...state }
    })
  }

  async reconcileDocuments(
    _build: BuildBatchRequest["build"],
    customIds: string[]
  ): Promise<RemoteDocumentState[]> {
    this.reconcileCalls += 1
    return customIds.map((customId) => this.remote.get(customId) ?? { customId, status: "absent" })
  }

  async searchBuild(request: BuildSearchRequest): Promise<BuildSearchResponse> {
    this.searchCalls += 1
    const screenshot = request.build.documents.find(
      (document) => document.screenshotRef
    )?.screenshotRef
    if (!screenshot) throw new Error("Fixture build is missing its screenshot")
    return {
      request: {
        containerTag: request.build.containerTag,
        filters: { runFingerprint: request.build.buildFingerprint },
        limit: request.config.topK,
      },
      rawResponse: { fixture: true, questionId: request.questionId },
      normalizedResults: [
        {
          rank: 0,
          score: 0.99,
          kind: "memory",
          text: "The visible toggle is read-only. Option B is selected.",
          chunks: [],
          documentIds: [request.build.documents[0].customId],
          trajectoryId: "trajectory-1",
          stateIndex: 0,
          screenshotRefs: [screenshot],
          provenanceValid: true,
        },
      ],
      remoteDurationMs: 7,
    }
  }

  async verifyBuildHealth(build: BuildBatchRequest["build"]): Promise<RemoteDocumentState[]> {
    return build.documents.map(
      (document) =>
        this.remote.get(document.customId) ?? {
          customId: document.customId,
          status: "absent",
        }
    )
  }

  async deleteDocuments(_build: BuildBatchRequest["build"], customIds: string[]): Promise<void> {
    for (const customId of customIds) this.remote.delete(customId)
  }

  async clearBuild(): Promise<void> {
    this.remote.clear()
  }
}

class BoundedFailureBuildProvider extends FakeBuildProvider {
  override async submitDocumentBatch(_request: BuildBatchRequest): Promise<RemoteDocumentState[]> {
    this.submitCalls += 1
    throw new Error("bounded fixture ingestion failure")
  }
}

class FakeReaderClient implements ReaderModelClient {
  readonly requests: ReaderModelRequest[] = []

  constructor(private readonly failures = new Set<string>()) {}

  async generate(request: ReaderModelRequest): Promise<ReaderModelResponse> {
    this.requests.push(request)
    const text = request.parts
      .filter(
        (part): part is Extract<(typeof request.parts)[number], { type: "text" }> =>
          part.type === "text"
      )
      .map((part) => part.text)
      .join("\n")
    const questionId = text.includes("Which option was selected?") ? "q-choice" : "q-gotcha"
    if (this.failures.has(questionId)) throw new Error(`reader failure for ${questionId}`)
    return {
      text:
        questionId === "q-choice"
          ? "The selected option is \\boxed{B}"
          : "The key issue is \\boxed{The visible toggle is read-only}",
      raw: { fixture: true, questionId },
      usage: { input_tokens: 100, output_tokens: 10 },
    }
  }
}

class AbortAwareReaderClient implements ReaderModelClient {
  private markStarted!: () => void
  readonly started = new Promise<void>((resolve) => {
    this.markStarted = resolve
  })

  async generate(_request: ReaderModelRequest, signal?: AbortSignal): Promise<ReaderModelResponse> {
    this.markStarted()
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("Run aborted"))
        return
      }
      signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("Run aborted")), {
        once: true,
      })
    })
  }
}

class FakeStrictJudge {
  readonly requests: StrictJudgeRequest[] = []
  readonly callback: StrictJudgeCallback = async (request) => {
    this.requests.push(request)
    return {
      text: '{"label":1,"reason":"fixture gotcha matches"}',
      rawResponse: { fixtureJudge: true },
    }
  }
}

function config(
  datasetPath: string,
  options: {
    mode?: BuildAwareRunConfig["mode"]
    questionIds?: string[]
    provider?: BuildAwareRunConfig["provider"]
  } = {}
): BuildAwareRunConfig {
  return {
    provider: options.provider ?? "supermemory",
    benchmark: "longmemeval-v2",
    mode: options.mode ?? "benchmark",
    datasetPath,
    datasetRevision: LONGMEMEVAL_V2_PINNED_REVISION,
    tier: "small",
    domain: "web",
    questionIds: options.questionIds,
    seed: "deterministic-runner-fixture",
    retrieval: {
      topK: 2,
      threshold: 0,
      searchMode: "hybrid",
      rerank: true,
      rewriteQuery: false,
      includeSummaries: true,
      includeChunks: true,
      includeDocuments: true,
      includeRelatedMemories: false,
      metadataFilter: {},
    },
    reader: {
      model: "fake-reader",
      reasoningEffort: "high",
      maxCompletionTokens: 100,
      maxContextTokens: 10_000,
      evidenceTopK: 2,
      maxImages: 10,
      maxImageBytes: 1_000_000,
      malformedResponseAttempts: 1,
    },
    evaluator: {
      model: "fake-strict-judge",
      reasoningEffort: "high",
      maxCompletionTokens: 100,
    },
    build: {
      serviceBaseUrl: "https://fixture.invalid",
      dreaming: "instant",
      rootFilterMode: "self",
      maxDocumentChars: 100_000,
      trajectoryConcurrency: 2,
      maxInFlightRequests: 2,
      maxTrajectoryAttempts: 2,
      indexingTimeoutMs: 1_000,
      pollIntervalMs: 1,
      preflightMaxAgeMs: 24 * 60 * 60_000,
    },
    execution: {
      buildConcurrency: 2,
      questionConcurrency: 2,
    },
  }
}

function runnerOptions(root: string): {
  runRoot: string
  buildRoot: string
  cacheRoot: string
} {
  return {
    runRoot: resolve(root, "runs"),
    buildRoot: resolve(root, "builds"),
    cacheRoot: resolve(root, "artifacts"),
  }
}

async function writePassingPreflightGate(
  root: string,
  runConfig: BuildAwareRunConfig
): Promise<string> {
  const path = supermemoryPreflightGatePath(root, runConfig.build.serviceBaseUrl)
  await mkdir(dirname(path), { recursive: true })
  const report: SupermemoryPreflightReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    baseUrl: runConfig.build.serviceBaseUrl,
    identity: {
      buildId: "preflight-fixture",
      containerTag: "preflight-fixture",
      runFingerprint: "preflight-fixture",
    },
    searchContract: {
      searchMode: "hybrid",
      standaloneChunksExpected: true,
      deprecatedIncludeChunks: false,
      requestedTopK: runConfig.retrieval.topK,
    },
    checks: [],
    allPassed: true,
    blockers: [],
    requestBudget: {
      configuredCap: 2,
      effectiveCap: 2,
      inFlight: 0,
      peakInFlight: 1,
      throttleEvents: 0,
      successStreak: 1,
      notBeforeMs: 0,
    },
  }
  await atomicWriteJson(path, report)
  return path
}

async function loadReport(runner: LongMemEvalV2Runner): Promise<BuildAwareReport> {
  return JSON.parse(
    await readFile(resolve(runner.runStore.runRoot, "report.json"), "utf8")
  ) as BuildAwareReport
}

describe("LongMemEvalV2Runner end-to-end", () => {
  test("continues through report with an explicit degraded warning in non-strict mode", async () => {
    const root = await temporaryRoot()
    const fixture = await writeMiniDataset(root)
    const provider = new BoundedFailureBuildProvider()
    const runConfig = config(fixture.root, { questionIds: ["q-choice"] })
    runConfig.build.continueOnIndexingTimeout = true
    const runner = new LongMemEvalV2Runner({
      runId: "fixture-degraded-non-strict",
      config: runConfig,
      provider,
      readerClient: new FakeReaderClient(),
      strictJudge: new FakeStrictJudge().callback,
      datasetValidationProfile: fixture.validationProfile,
      ...runnerOptions(root),
    })

    const checkpoint = await runner.execute()
    const report = await loadReport(runner)

    expect(checkpoint.status).toBe("completed")
    expect(checkpoint.currentStage).toBe("report")
    expect(provider.submitCalls).toBe(runConfig.build.maxTrajectoryAttempts)
    expect(provider.searchCalls).toBe(1)
    expect(report.officiallyComparable).toBeFalse()
    expect(report.builds).toEqual([
      expect.objectContaining({
        status: "degraded",
        skippedTrajectoryCount: 1,
        skippedDocumentCount: expect.any(Number),
      }),
    ])
    expect(report.builds[0].skippedDocumentCount).toBeGreaterThan(0)
    expect(report.ineligibilityReasons).toEqual([
      expect.stringContaining("after bounded ingestion failures"),
    ])
  })

  test("keeps exhausted bounded ingestion failures fatal in strict mode", async () => {
    const root = await temporaryRoot()
    const fixture = await writeMiniDataset(root)
    const provider = new BoundedFailureBuildProvider()
    const runConfig = config(fixture.root, { questionIds: ["q-choice"] })
    runConfig.build.continueOnIndexingTimeout = false
    const runner = new LongMemEvalV2Runner({
      runId: "fixture-failed-strict",
      config: runConfig,
      provider,
      readerClient: new FakeReaderClient(),
      strictJudge: new FakeStrictJudge().callback,
      datasetValidationProfile: fixture.validationProfile,
      ...runnerOptions(root),
    })

    await expect(runner.execute()).rejects.toThrow("Build failed")
    const checkpoint = await runner.runStore.load()
    expect(checkpoint.status).toBe("failed")
    expect(checkpoint.currentStage).toBe("build")
    expect(provider.submitCalls).toBe(runConfig.build.maxTrajectoryAttempts)
    expect(provider.searchCalls).toBe(0)
    expect(await Bun.file(resolve(runner.runStore.runRoot, "report.json")).exists()).toBeFalse()
  })

  test("fingerprints and reports the persisted non-Supermemory provider identity", async () => {
    const root = await temporaryRoot()
    const fixture = await writeMiniDataset(root)
    const provider = new FakeBuildProvider()
    const runner = new LongMemEvalV2Runner({
      runId: "fixture-rag-provider",
      config: config(fixture.root, { questionIds: ["q-choice"], provider: "rag" }),
      provider,
      readerClient: new FakeReaderClient(),
      strictJudge: new FakeStrictJudge().callback,
      datasetValidationProfile: fixture.validationProfile,
      ...runnerOptions(root),
    })
    await runner.execute()
    const report = await loadReport(runner)
    const checkpoint = await runner.runStore.load()
    const buildPlan = JSON.parse(
      await readFile(
        resolve(runner.runStore.runRoot, "builds", `${checkpoint.buildIds[0]}.plan.json`),
        "utf8"
      )
    ) as MemoryBuildPlan
    expect(report.provider).toBe("rag")
    expect(buildPlan.provider).toBe("rag")
    expect(buildPlan.providerBuildConfig).toMatchObject({
      adapter: "memorybench-build-aware-v1",
      extractionModel: "gpt-4o-mini",
      embeddingModel: "text-embedding-3-small",
    })
  })

  test("persists a resumable failed checkpoint when the UI aborts during reading", async () => {
    const root = await temporaryRoot()
    const fixture = await writeMiniDataset(root)
    const provider = new FakeBuildProvider()
    const reader = new AbortAwareReaderClient()
    const controller = new AbortController()
    const runner = new LongMemEvalV2Runner({
      runId: "fixture-ui-stop",
      config: config(fixture.root, { questionIds: ["q-choice"] }),
      provider,
      readerClient: reader,
      datasetValidationProfile: fixture.validationProfile,
      signal: controller.signal,
      ...runnerOptions(root),
    })

    const execution = runner.execute()
    await reader.started
    controller.abort(new Error("Stopped from the MemoryBench UI"))

    await expect(execution).rejects.toThrow("Stopped from the MemoryBench UI")
    const checkpoint = await runner.runStore.load()
    expect(checkpoint.status).toBe("failed")
    expect(checkpoint.error).toBe("Stopped from the MemoryBench UI")
    expect(checkpoint.questions["q-choice"].stages.read.status).toBe("failed")
    expect(await Bun.file(resolve(runner.runStore.runRoot, "report.json")).exists()).toBeFalse()
  })

  test("executes plan through report with one shared multimodal build and reuses it on a second run", async () => {
    const root = await temporaryRoot()
    const fixture = await writeMiniDataset(root)
    const provider = new FakeBuildProvider()
    const reader = new FakeReaderClient()
    const judge = new FakeStrictJudge()
    const shared = runnerOptions(root)
    const runConfig = config(fixture.root)

    const firstRunner = new LongMemEvalV2Runner({
      runId: "fixture-first",
      config: runConfig,
      provider,
      readerClient: reader,
      strictJudge: judge.callback,
      datasetValidationProfile: fixture.validationProfile,
      ...shared,
    })
    const first = await firstRunner.execute()
    const firstReport = await loadReport(firstRunner)
    const selection = JSON.parse(
      await readFile(resolve(firstRunner.runStore.runRoot, "selection.json"), "utf8")
    ) as { questionIds: string[]; buildLinks: Record<string, string> }

    expect(first.currentStage).toBe("report")
    expect(first.status).toBe("completed")
    expect(selection.questionIds).toEqual(["q-gotcha", "q-choice"])
    expect(first.buildIds).toHaveLength(1)
    expect(new Set(Object.values(first.buildLinks)).size).toBe(1)
    expect(provider.submitCalls).toBe(1)
    expect(provider.searchCalls).toBe(2)
    expect(first.questions["q-gotcha"].stages.evaluate.status).toBe("completed")
    expect(first.questions["q-choice"].stages.evaluate.status).toBe("completed")
    expect(first.questions["q-gotcha"].evaluationArtifact?.request?.kind).toBe("gotcha")
    expect(first.questions["q-choice"].evaluationArtifact?.request).toBeUndefined()
    expect(judge.requests).toHaveLength(1)
    expect(firstReport.targetQuestionCount).toBe(2)
    expect(firstReport.completedQuestionCount).toBe(2)
    expect(firstReport.official.overall.overall_full_set).toBe(1)
    expect(firstReport.builds).toEqual([
      expect.objectContaining({
        trajectoryCount: 1,
        linkedQuestionIds: ["q-gotcha", "q-choice"],
        reused: false,
      }),
    ])

    const gotchaRequest = reader.requests.find((request) =>
      request.parts.some(
        (part) => part.type === "text" && part.text.includes("What is the gotcha?")
      )
    )
    expect(gotchaRequest).toBeDefined()
    expect(
      gotchaRequest!.parts.filter((part) => part.type === "image").map((part) => part.asset.kind)
    ).toEqual(["trajectory-screenshot", "question-image"])
    expect(firstReport.diagnostics.contextImagesSent).toBe(3)

    const secondRunner = new LongMemEvalV2Runner({
      runId: "fixture-second",
      config: runConfig,
      provider,
      readerClient: reader,
      strictJudge: judge.callback,
      datasetValidationProfile: fixture.validationProfile,
      ...shared,
    })
    const second = await secondRunner.execute()
    const secondReport = await loadReport(secondRunner)

    expect(second.status).toBe("completed")
    expect(provider.submitCalls).toBe(1)
    expect(provider.reconcileCalls).toBeGreaterThan(0)
    expect(provider.searchCalls).toBe(2)
    expect(reader.requests).toHaveLength(2)
    expect(judge.requests).toHaveLength(1)
    expect(secondReport.builds[0].reused).toBeTrue()
    expect(secondReport.diagnostics.queryCacheHits).toBe(2)
    expect(secondReport.diagnostics.readerCacheHits).toBe(2)
    expect(second.questions["q-gotcha"].stages.evaluate.cacheHit).toBeTrue()
    expect(second.questions["q-choice"].stages.evaluate.cacheHit).toBeTrue()
  })

  test("keeps a failed reader question in the official denominator", async () => {
    const root = await temporaryRoot()
    const fixture = await writeMiniDataset(root)
    const reader = new FakeReaderClient(new Set(["q-choice"]))
    const judge = new FakeStrictJudge()
    const runner = new LongMemEvalV2Runner({
      runId: "fixture-reader-failure",
      config: config(fixture.root),
      provider: new FakeBuildProvider(),
      readerClient: reader,
      strictJudge: judge.callback,
      datasetValidationProfile: fixture.validationProfile,
      ...runnerOptions(root),
    })

    const checkpoint = await runner.execute()
    const report = await loadReport(runner)

    expect(checkpoint.status).toBe("completed")
    expect(checkpoint.questions["q-choice"].stages.read.status).toBe("failed")
    expect(checkpoint.questions["q-choice"].stages.evaluate.status).toBe("blocked")
    expect(report.targetQuestionCount).toBe(2)
    expect(report.completedQuestionCount).toBe(1)
    expect(report.failedQuestionCount).toBe(1)
    expect(report.official.overall.count_all_questions).toBe(2)
    expect(report.official.overall.overall_full_set).toBe(0.5)
    expect(report.official.execution).toEqual({
      completed: 1,
      failed: 0,
      pending: 0,
      blocked: 1,
    })
    expect(report.diagnostics.failedQuestions).toEqual([
      {
        questionId: "q-choice",
        stage: "read",
        error: "reader failure for q-choice",
      },
    ])
  })

  test("allows a one-trajectory canary through query but refuses scoring", async () => {
    const root = await temporaryRoot()
    const fixture = await writeMiniDataset(root)
    const provider = new FakeBuildProvider()
    const runner = new LongMemEvalV2Runner({
      runId: "fixture-canary",
      config: config(fixture.root, {
        mode: "one-trajectory-canary",
        questionIds: ["q-gotcha"],
      }),
      provider,
      datasetValidationProfile: fixture.validationProfile,
      ...runnerOptions(root),
    })

    const checkpoint = await runner.execute({ through: "query" })
    expect(checkpoint.currentStage).toBe("query")
    expect(checkpoint.status).toBe("completed")
    expect(checkpoint.questions["q-gotcha"].stages.query.status).toBe("completed")
    expect(provider.searchCalls).toBe(1)
    await expect(runner.execute({ through: "evaluate" })).rejects.toThrow(
      "not an official benchmark run"
    )
  })

  test("blocks live-style builds until a fresh passing preflight gate covers topK", async () => {
    const root = await temporaryRoot()
    const fixture = await writeMiniDataset(root)
    const provider = new FakeBuildProvider()
    const runConfig = config(fixture.root)
    const preflightRoot = resolve(root, "preflights")
    const shared = runnerOptions(root)

    const missingGateRunner = new LongMemEvalV2Runner({
      runId: "fixture-missing-preflight",
      config: runConfig,
      provider,
      requirePreflight: true,
      preflightRoot,
      datasetValidationProfile: fixture.validationProfile,
      ...shared,
    })
    await expect(missingGateRunner.execute({ through: "build" })).rejects.toThrow(
      "No readable passing Supermemory preflight gate"
    )
    expect(provider.submitCalls).toBe(0)

    await writePassingPreflightGate(preflightRoot, runConfig)
    const gatedRunner = new LongMemEvalV2Runner({
      runId: "fixture-passing-preflight",
      config: runConfig,
      provider,
      requirePreflight: true,
      preflightRoot,
      datasetValidationProfile: fixture.validationProfile,
      ...shared,
    })
    const checkpoint = await gatedRunner.execute({ through: "build" })
    expect(checkpoint.status).toBe("completed")
    expect(checkpoint.preflightGate).toMatchObject({
      schemaVersion: 1,
      baseUrl: runConfig.build.serviceBaseUrl,
      testedTopK: runConfig.retrieval.topK,
    })
    expect(checkpoint.preflightGate?.reportFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(provider.submitCalls).toBe(1)
  })

  test("keeps the full audited snapshot profile as the production default", async () => {
    expect(AUDITED_LONGMEMEVAL_V2_DATASET_VALIDATION.expectedCounts).toEqual({
      questions: 451,
      trajectories: 1870,
      states: 48609,
      assets: 48638,
      uniqueBuilds: { small: 2, medium: 447 },
    })
    expect(AUDITED_LONGMEMEVAL_V2_DATASET_VALIDATION.requiredFiles.LICENSE).toEqual({
      sha256: "d547f7673579465fcecc8f257fcdb410f51c82fd784a10b1587e83036f9c29e1",
      byteLength: 9109,
    })

    const root = await temporaryRoot()
    const fixture = await writeMiniDataset(root)
    const runner = new LongMemEvalV2Runner({
      runId: "fixture-without-profile",
      config: config(fixture.root),
      ...runnerOptions(root),
    })
    await expect(runner.execute({ through: "plan" })).rejects.toThrow(
      "Expected 451 questions, found 2"
    )
  })
})

describe("LongMemEval-V2 CLI safety gates", () => {
  test("rejects medium without explicit authorization and rejects unknown flags", async () => {
    await expect(longMemEvalV2Command(["dry-run", "--tier", "medium"])).rejects.toThrow(
      "pass --allow-medium"
    )
    await expect(longMemEvalV2Command(["dry-run", "--unknown-runner-option"])).rejects.toThrow(
      "Unknown option: --unknown-runner-option"
    )
    await expect(
      longMemEvalV2Command(["dry-run", "--preflight-max-age-hours", "0"])
    ).rejects.toThrow("requires a number > 0")
  })
})
