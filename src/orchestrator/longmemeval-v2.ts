import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { ArtifactStore } from "../core/artifact-store"
import { BuildEngine } from "../core/build-engine"
import { BuildStore } from "../core/build-store"
import { atomicWriteJson, stableHash } from "../core/canonical"
import { requireProviderCapabilities } from "../core/provider-capabilities"
import { QueryRunner } from "../core/query-runner"
import {
  LongMemEvalV2Dataset,
  type LongMemEvalV2DatasetValidationProfile,
} from "../benchmarks/longmemeval-v2/dataset"
import { planLongMemEvalV2Build } from "../benchmarks/longmemeval-v2/planner"
import {
  LongMemEvalV2Reader,
  OpenAIReaderClient,
  type ReaderModelClient,
} from "../benchmarks/longmemeval-v2/reader"
import {
  StrictJudgeError,
  aggregateLongMemEvalV2,
  createOpenAIStrictJudge,
  evaluateLongMemEvalV2,
  isUnknownAnswer,
  type LongMemEvalV2AggregateRecord,
  type StrictJudgeCallback,
} from "../benchmarks/longmemeval-v2/evaluation"
import {
  AdvancedSupermemoryProvider,
  supermemoryPreflightGatePath,
  validateSupermemoryPreflightReport,
  type SupermemoryPreflightReport,
} from "../providers/supermemory/advanced"
import type { BuildProvider } from "../types/provider"
import type { ProviderName } from "../types/provider"
import type {
  BuildAwareReport,
  BuildAwareRunCheckpoint,
  BuildAwareRunConfig,
} from "../types/build-aware"
import type {
  AssetRef,
  DatasetManifest,
  EvaluationArtifact,
  MemoryBuildPlan,
} from "../types/migration"
import type {
  LongMemEvalV2BuildGroup,
  LongMemEvalV2QuestionPlan,
  PreparedTrajectory,
} from "../benchmarks/longmemeval-v2/types"
import { BuildAwareRunStore } from "./build-aware-run-store"

export type LongMemEvalV2RunThrough = "plan" | "build" | "query" | "read" | "evaluate" | "report"

const STAGE_ORDER: LongMemEvalV2RunThrough[] = [
  "plan",
  "build",
  "query",
  "read",
  "evaluate",
  "report",
]

export interface LongMemEvalV2RunnerOptions {
  runId: string
  config: BuildAwareRunConfig
  runRoot?: string
  buildRoot?: string
  cacheRoot?: string
  supermemoryApiKey?: string
  openAIApiKey?: string
  provider?: BuildProvider
  readerClient?: ReaderModelClient
  strictJudge?: StrictJudgeCallback
  datasetValidationProfile?: LongMemEvalV2DatasetValidationProfile
  preflightRoot?: string
  requirePreflight?: boolean
  signal?: AbortSignal
}

export interface LongMemEvalV2ExecuteOptions {
  through?: LongMemEvalV2RunThrough
  forceBuild?: boolean
  freshQuery?: boolean
}

interface PreparedRun {
  manifest: DatasetManifest
  questions: LongMemEvalV2QuestionPlan[]
  trajectories: Map<string, PreparedTrajectory>
  builds: MemoryBuildPlan[]
  buildByQuestionId: Map<string, MemoryBuildPlan>
}

interface BuildExecution {
  plan: MemoryBuildPlan
  reused: boolean
  status: "ready" | "degraded"
  skippedTrajectoryCount: number
  skippedDocumentCount: number
}

export function limitLongMemEvalV2Haystacks(
  planned: {
    questions: LongMemEvalV2QuestionPlan[]
    builds: LongMemEvalV2BuildGroup[]
  },
  limit: number | undefined
): {
  questions: LongMemEvalV2QuestionPlan[]
  builds: LongMemEvalV2BuildGroup[]
} {
  if (limit === undefined) return planned
  assertPositiveInteger(limit, "haystackLimit")
  if (limit > planned.builds.length) {
    throw new Error(
      `haystackLimit ${limit} exceeds ${planned.builds.length} available exact haystacks`
    )
  }
  const builds = planned.builds.slice(0, limit)
  const buildKeys = new Set(builds.map((build) => build.buildKey))
  return {
    builds,
    questions: planned.questions.filter((question) => buildKeys.has(question.buildKey)),
  }
}

function portableAsset(asset: AssetRef): AssetRef {
  return { ...asset, absolutePath: undefined }
}

function portableBuild(plan: MemoryBuildPlan): MemoryBuildPlan {
  return {
    ...plan,
    documents: plan.documents.map((document) => ({
      ...document,
      screenshotRef: document.screenshotRef ? portableAsset(document.screenshotRef) : undefined,
    })),
    documentPlans: plan.documentPlans.map((documentPlan) => ({
      ...documentPlan,
      documents: documentPlan.documents.map((document) => ({
        ...document,
        spec: {
          ...document.spec,
          screenshotRef: document.spec.screenshotRef
            ? portableAsset(document.spec.screenshotRef)
            : undefined,
        },
      })),
    })),
  }
}

function collectAssets(
  questions: LongMemEvalV2QuestionPlan[],
  trajectories: Map<string, PreparedTrajectory>
): AssetRef[] {
  const assets = new Map<string, AssetRef>()
  for (const question of questions) {
    if (question.questionImage) assets.set(question.questionImage.sha256, question.questionImage)
  }
  for (const trajectory of trajectories.values()) {
    for (const state of trajectory.states) {
      const existing = assets.get(state.screenshot.sha256)
      if (
        existing &&
        (existing.byteLength !== state.screenshot.byteLength ||
          existing.mimeType !== state.screenshot.mimeType)
      ) {
        throw new Error(`Asset hash collision for ${state.screenshot.sha256}`)
      }
      assets.set(state.screenshot.sha256, state.screenshot)
    }
  }
  return [...assets.values()]
    .sort((left, right) =>
      `${left.kind}:${left.relativePath}:${left.sha256}`.localeCompare(
        `${right.kind}:${right.relativePath}:${right.sha256}`
      )
    )
    .map(portableAsset)
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`)
  }
}

function validateConfig(config: BuildAwareRunConfig): void {
  if (config.benchmark !== "longmemeval-v2") {
    throw new Error("The build-aware runner only supports longmemeval-v2")
  }
  const providers: ProviderName[] = ["supermemory", "filesystem", "rag", "mem0", "zep"]
  if (!providers.includes(config.provider)) {
    throw new Error(`Unsupported LongMemEval-V2 provider: ${config.provider}`)
  }
  if (!["benchmark", "one-trajectory-canary"].includes(config.mode)) {
    throw new Error("Invalid run mode")
  }
  if (!["small", "medium"].includes(config.tier)) throw new Error("Invalid tier")
  if (!["web", "enterprise", "all"].includes(config.domain)) throw new Error("Invalid domain")
  if (!config.datasetRevision.trim()) throw new Error("An exact dataset revision is required")
  if (config.retrieval.topK < 1 || !Number.isInteger(config.retrieval.topK)) {
    throw new Error("retrieval.topK must be a positive integer")
  }
  if (config.reader.evidenceTopK < 1 || !Number.isInteger(config.reader.evidenceTopK)) {
    throw new Error("reader.evidenceTopK must be a positive integer")
  }
  if (config.reader.evidenceTopK > config.retrieval.topK) {
    throw new Error("reader.evidenceTopK cannot exceed retrieval.topK")
  }
  if (config.reader.maxContextTokens <= config.reader.maxCompletionTokens) {
    throw new Error("Reader context budget must exceed max completion tokens")
  }
  assertPositiveInteger(config.build.trajectoryConcurrency, "build.trajectoryConcurrency")
  assertPositiveInteger(config.build.maxInFlightRequests, "build.maxInFlightRequests")
  assertPositiveInteger(config.build.preflightMaxAgeMs, "build.preflightMaxAgeMs")
  assertPositiveInteger(config.execution.buildConcurrency, "execution.buildConcurrency")
  assertPositiveInteger(config.execution.questionConcurrency, "execution.questionConcurrency")
  if (config.haystackLimit !== undefined) {
    assertPositiveInteger(config.haystackLimit, "haystackLimit")
  }
}

async function mapConcurrent<T>(
  values: T[],
  concurrency: number,
  task: (value: T) => Promise<void>
): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor
      cursor += 1
      await task(values[index])
    }
  })
  await Promise.all(workers)
}

function stageReached(through: LongMemEvalV2RunThrough, stage: LongMemEvalV2RunThrough): boolean {
  return STAGE_ORDER.indexOf(through) >= STAGE_ORDER.indexOf(stage)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Run aborted")
}

export class LongMemEvalV2Runner {
  readonly runStore: BuildAwareRunStore
  readonly buildRoot: string
  readonly cacheRoot: string
  private provider?: BuildProvider
  private readonly cacheArtifacts: ArtifactStore

  constructor(private readonly options: LongMemEvalV2RunnerOptions) {
    validateConfig(options.config)
    this.runStore = new BuildAwareRunStore(options.runId, options.runRoot ?? "data/runs-v2")
    this.buildRoot = resolve(options.buildRoot ?? "data/memory-builds-v2")
    this.cacheRoot = resolve(options.cacheRoot ?? "data/artifacts-v2")
    this.provider = options.provider
    this.cacheArtifacts = new ArtifactStore(this.cacheRoot, [
      "SUPERMEMORY_API_KEY",
      "OPENAI_API_KEY",
      "MEM0_API_KEY",
      "ZEP_API_KEY",
    ])
  }

  async execute(
    executeOptions: LongMemEvalV2ExecuteOptions = {}
  ): Promise<BuildAwareRunCheckpoint> {
    throwIfAborted(this.options.signal)
    const through = executeOptions.through ?? "report"
    if (this.options.config.mode === "one-trajectory-canary" && stageReached(through, "read")) {
      throw new Error(
        "A one-trajectory canary may only plan, build, or query; it is not an official benchmark run"
      )
    }
    const checkpoint = await this.runStore.createOrLoad(this.options.config)
    checkpoint.artifactRoot = this.cacheRoot
    checkpoint.buildRoot = this.buildRoot
    try {
      const prepared = await this.prepare(checkpoint)
      throwIfAborted(this.options.signal)
      if (!stageReached(through, "build")) {
        await this.runStore.setStage(checkpoint, "plan", "completed")
        return checkpoint
      }

      await this.requirePassingPreflight(checkpoint)
      throwIfAborted(this.options.signal)
      await this.runStore.setStage(checkpoint, "build")
      const builds = await this.build(prepared, executeOptions.forceBuild ?? false)
      throwIfAborted(this.options.signal)
      await this.runStore.setStage(
        checkpoint,
        stageReached(through, "query") ? "query" : "build",
        stageReached(through, "query") ? "running" : "completed"
      )
      if (!stageReached(through, "query")) return checkpoint

      await this.query(checkpoint, prepared, executeOptions.freshQuery ?? false)
      throwIfAborted(this.options.signal)
      if (!stageReached(through, "read")) {
        await this.runStore.setStage(checkpoint, "query", "completed")
        return checkpoint
      }

      await this.runStore.setStage(checkpoint, "read")
      await this.read(checkpoint, prepared)
      throwIfAborted(this.options.signal)
      if (!stageReached(through, "evaluate")) {
        await this.runStore.setStage(checkpoint, "read", "completed")
        return checkpoint
      }

      await this.runStore.setStage(checkpoint, "evaluate")
      await this.evaluate(checkpoint, prepared)
      throwIfAborted(this.options.signal)
      if (!stageReached(through, "report")) {
        await this.runStore.setStage(checkpoint, "evaluate", "completed")
        return checkpoint
      }

      await this.runStore.setStage(checkpoint, "report")
      await this.report(checkpoint, prepared, builds)
      await this.runStore.setStage(checkpoint, "report", "completed")
      return checkpoint
    } catch (error) {
      await this.runStore.fail(checkpoint, error)
      throw error
    } finally {
      await this.runStore.flush()
    }
  }

  private async requirePassingPreflight(checkpoint: BuildAwareRunCheckpoint): Promise<void> {
    const required =
      this.options.requirePreflight ??
      (this.options.config.provider === "supermemory" &&
        (this.options.provider === undefined ||
          this.options.provider instanceof AdvancedSupermemoryProvider))
    if (!required) return

    const gatePath = supermemoryPreflightGatePath(
      this.options.preflightRoot ?? "data/preflights-v2",
      this.options.config.build.serviceBaseUrl
    )
    let report: SupermemoryPreflightReport
    try {
      report = (await Bun.file(gatePath).json()) as SupermemoryPreflightReport
    } catch {
      throw new Error(
        `No readable passing Supermemory preflight gate exists for ${this.options.config.build.serviceBaseUrl}; run lme-v2 preflight before build`
      )
    }
    validateSupermemoryPreflightReport(report, {
      baseUrl: this.options.config.build.serviceBaseUrl,
      requiredTopK: this.options.config.retrieval.topK,
      maxAgeMs: this.options.config.build.preflightMaxAgeMs,
    })
    checkpoint.preflightGate = {
      schemaVersion: 1,
      reportFingerprint: stableHash(report),
      generatedAt: report.generatedAt,
      baseUrl: report.baseUrl,
      testedTopK: report.searchContract.requestedTopK,
    }
    await this.runStore.save(checkpoint)
  }

  private async prepare(checkpoint: BuildAwareRunCheckpoint): Promise<PreparedRun> {
    throwIfAborted(this.options.signal)
    await this.runStore.setStage(checkpoint, "plan")
    const dataset = new LongMemEvalV2Dataset({
      dataRoot: this.options.config.datasetPath,
      tier: this.options.config.tier,
      revision: this.options.config.datasetRevision,
      validationProfile: this.options.datasetValidationProfile,
    })
    await dataset.load()
    throwIfAborted(this.options.signal)
    const selected = dataset.selectQuestions({
      domain: this.options.config.domain === "all" ? undefined : this.options.config.domain,
      ids: this.options.config.questionIds,
      limit: this.options.config.limit,
      perCategory: this.options.config.perCategory,
      seed: this.options.config.seed,
    })
    let planned = limitLongMemEvalV2Haystacks(
      dataset.planQuestions(selected),
      this.options.config.haystackLimit
    )
    if (this.options.config.mode === "one-trajectory-canary") {
      if (planned.questions.length !== 1 || planned.builds.length !== 1) {
        throw new Error("A one-trajectory canary requires exactly one selected question")
      }
      planned.builds[0] = {
        ...planned.builds[0],
        orderedTrajectoryIds: planned.builds[0].orderedTrajectoryIds.slice(0, 1),
      }
    }
    await dataset.resolveQuestionImages(planned.questions)
    throwIfAborted(this.options.signal)
    const trajectoryIds = [
      ...new Set(planned.builds.flatMap((build) => build.orderedTrajectoryIds)),
    ]
    const trajectories = await dataset.loadTrajectories(trajectoryIds)
    throwIfAborted(this.options.signal)
    const baseManifest = await dataset.createManifest()
    const assets = collectAssets(planned.questions, trajectories)
    const manifest: DatasetManifest = {
      ...baseManifest,
      assets,
      assetScope: "selected-run",
      assetsFingerprint: stableHash(assets),
    }
    const builds = planned.builds.map((group) =>
      planLongMemEvalV2Build({
        manifest,
        group,
        trajectories,
        options: {
          provider: this.options.config.provider,
          providerBuildConfig: {
            adapter: "memorybench-build-aware-v1",
            ...(this.options.config.provider === "filesystem" ||
            this.options.config.provider === "rag"
              ? {
                  extractionModel: "gpt-4o-mini",
                  extractionPromptVersion: 1,
                }
              : {}),
            ...(this.options.config.provider === "rag"
              ? {
                  embeddingModel: "text-embedding-3-small",
                  chunkSizeCharacters: 1600,
                  chunkOverlapCharacters: 320,
                  hybridWeights: { vector: 0.7, bm25: 0.3 },
                }
              : {}),
            ...(this.options.config.provider === "supermemory"
              ? { serviceBaseUrl: this.options.config.build.serviceBaseUrl }
              : {}),
            dreaming: this.options.config.build.dreaming,
            rootFilterMode: this.options.config.build.rootFilterMode,
            maxDocumentChars: this.options.config.build.maxDocumentChars,
          },
        },
      })
    )
    const buildByKey = new Map(
      planned.builds.map((group, index) => [group.buildKey, builds[index]])
    )
    const buildByQuestionId = new Map<string, MemoryBuildPlan>()
    checkpoint.targetQuestionIds = planned.questions.map((plan) => plan.question.id)
    checkpoint.buildIds = builds.map((build) => build.buildId)
    checkpoint.buildLinks = {}
    checkpoint.datasetFingerprint = manifest.fingerprint
    checkpoint.datasetManifestPath = "dataset-manifest.json"
    for (const questionPlan of planned.questions) {
      const build = buildByKey.get(questionPlan.buildKey)
      if (!build) throw new Error(`No build for question ${questionPlan.question.id}`)
      buildByQuestionId.set(questionPlan.question.id, build)
      checkpoint.buildLinks[questionPlan.question.id] = build.buildId
      await this.runStore.initializeQuestion(checkpoint, {
        questionId: questionPlan.question.id,
        questionType: questionPlan.question.question_type,
        question: questionPlan.question.question,
        groundTruth: questionPlan.question.answer,
        evalFunction: questionPlan.question.eval_function,
        buildId: build.buildId,
        questionImageHash: questionPlan.questionImage?.sha256,
      })
    }
    await atomicWriteJson(resolve(this.runStore.runRoot, "dataset-manifest.json"), {
      ...manifest,
      dataRoot: undefined,
      assets: manifest.assets.map(portableAsset),
    })
    await atomicWriteJson(resolve(this.runStore.runRoot, "selection.json"), {
      schemaVersion: 1,
      mode: this.options.config.mode,
      seed: this.options.config.seed,
      questionIds: checkpoint.targetQuestionIds,
      buildLinks: checkpoint.buildLinks,
      assetsFingerprint: manifest.assetsFingerprint,
    })
    await mkdir(resolve(this.runStore.runRoot, "builds"), { recursive: true })
    for (const build of builds) {
      await atomicWriteJson(
        resolve(this.runStore.runRoot, "builds", `${build.buildId}.plan.json`),
        portableBuild(build)
      )
    }
    await this.runStore.save(checkpoint)
    return {
      manifest,
      questions: planned.questions,
      trajectories,
      builds,
      buildByQuestionId,
    }
  }

  private getProvider(): BuildProvider {
    if (this.provider) return this.provider
    if (this.options.config.provider !== "supermemory") {
      throw new Error(
        `No safe LongMemEval-V2 build adapter was injected for ${this.options.config.provider}`
      )
    }
    const apiKey = this.options.supermemoryApiKey ?? process.env.SUPERMEMORY_API_KEY
    if (!apiKey) throw new Error("SUPERMEMORY_API_KEY is required for build/query stages")
    this.provider = new AdvancedSupermemoryProvider({
      apiKey,
      baseUrl: this.options.config.build.serviceBaseUrl,
      maxInFlightRequests: this.options.config.build.maxInFlightRequests,
    })
    return this.provider
  }

  private validateProvider(provider: BuildProvider): void {
    requireProviderCapabilities(provider.name, provider.capabilities, [
      "deterministicExternalIds",
      "batchUpload",
      "remoteClear",
      "readinessStates",
      "durableLocalPersistence",
      "splitPhaseSafe",
    ])
    if (!provider.capabilities.searchModes.includes(this.options.config.retrieval.searchMode)) {
      throw new Error(
        `Provider ${provider.name} does not support ${this.options.config.retrieval.searchMode} search`
      )
    }
    if (this.options.config.retrieval.rerank && !provider.capabilities.reranking) {
      throw new Error(`Provider ${provider.name} does not support reranking`)
    }
    if (this.options.config.retrieval.rewriteQuery && !provider.capabilities.queryRewriting) {
      throw new Error(`Provider ${provider.name} does not support query rewriting`)
    }
  }

  private async build(prepared: PreparedRun, forceBuild: boolean): Promise<BuildExecution[]> {
    const provider = this.getProvider()
    this.validateProvider(provider)
    const results: BuildExecution[] = []
    await mapConcurrent(
      prepared.builds,
      this.options.config.execution.buildConcurrency,
      async (plan) => {
        if (this.options.signal?.aborted) {
          throw this.options.signal.reason ?? new Error("Run aborted")
        }
        const directory = resolve(this.buildRoot, provider.name, plan.buildFingerprint)
        await mkdir(directory, { recursive: true })
        await atomicWriteJson(resolve(directory, "plan.json"), portableBuild(plan))
        const store = new BuildStore(resolve(directory, "checkpoint.sqlite"))
        try {
          const existing = store.getBuild(plan.buildId)
          const reused = existing?.status === "ready" && !forceBuild
          if (forceBuild && existing) {
            await provider.clearBuild(plan)
            store.resetBuildForReingestion(plan.buildId)
          }
          const engine = new BuildEngine(plan, provider, store, {
            trajectoryConcurrency: this.options.config.build.trajectoryConcurrency,
            maxTrajectoryAttempts: this.options.config.build.maxTrajectoryAttempts,
            indexingTimeoutMs: this.options.config.build.indexingTimeoutMs,
            pollIntervalMs: this.options.config.build.pollIntervalMs,
            leaseMs: Math.max(this.options.config.build.pollIntervalMs * 3 + 1, 60_000),
            continueOnIndexingTimeout: this.options.config.build.continueOnIndexingTimeout ?? false,
            signal: this.options.signal,
          })
          const status = await engine.run()
          await engine.verifyRemoteHealth({ allowDegraded: status === "degraded" })
          const buildSummary = store.buildSummary(plan.buildId)
          const skippedDocumentCount = Object.entries(buildSummary.documents).reduce(
            (total, [documentStatus, count]) => total + (documentStatus === "ready" ? 0 : count),
            0
          )
          await atomicWriteJson(resolve(directory, "summary.json"), {
            schemaVersion: 1,
            buildId: plan.buildId,
            buildFingerprint: plan.buildFingerprint,
            containerTag: plan.containerTag,
            provider: provider.name,
            status,
            serviceBaseUrl: this.options.config.build.serviceBaseUrl,
            providerCapabilities: provider.capabilities,
            requestBudget:
              provider instanceof AdvancedSupermemoryProvider
                ? provider.client.budgetSnapshot
                : undefined,
            summary: buildSummary,
            verifiedAt: new Date().toISOString(),
          })
          results.push({
            plan,
            reused,
            status,
            skippedTrajectoryCount: buildSummary.trajectories.failed,
            skippedDocumentCount,
          })
        } finally {
          store.close()
        }
      }
    )
    return results.sort(
      (left, right) => prepared.builds.indexOf(left.plan) - prepared.builds.indexOf(right.plan)
    )
  }

  private async query(
    checkpoint: BuildAwareRunCheckpoint,
    prepared: PreparedRun,
    fresh: boolean
  ): Promise<void> {
    const provider = this.getProvider()
    this.validateProvider(provider)
    const runner = new QueryRunner(provider, this.cacheArtifacts)
    await mapConcurrent(
      prepared.questions,
      this.options.config.execution.questionConcurrency,
      async (questionPlan) => {
        throwIfAborted(this.options.signal)
        const id = questionPlan.question.id
        const question = checkpoint.questions[id]
        const build = prepared.buildByQuestionId.get(id)!
        const startedAt = new Date().toISOString()
        await this.runStore.updateQuestionStage(checkpoint, id, "query", {
          status: "running",
          startedAt,
          error: undefined,
        })
        try {
          const artifact = await runner.run({
            build,
            questionId: id,
            query: questionPlan.question.question,
            questionImage: questionPlan.questionImage,
            config: this.options.config.retrieval,
            fresh,
          })
          throwIfAborted(this.options.signal)
          question.queryArtifact = artifact
          await this.runStore.updateQuestionStage(checkpoint, id, "query", {
            status: "completed",
            fingerprint: artifact.queryFingerprint,
            artifactPath: artifact.normalizedArtifact.relativePath,
            completedAt: new Date().toISOString(),
            durationMs: artifact.wallDurationMs,
            cacheHit: artifact.cacheHit,
          })
        } catch (error) {
          await this.runStore.updateQuestionStage(checkpoint, id, "query", {
            status: "failed",
            error: errorMessage(error),
            completedAt: new Date().toISOString(),
          })
          await this.runStore.updateQuestionStage(checkpoint, id, "read", {
            status: "blocked",
            error: "Blocked by query failure",
          })
          await this.runStore.updateQuestionStage(checkpoint, id, "evaluate", {
            status: "blocked",
            error: "Blocked by query failure",
          })
          throwIfAborted(this.options.signal)
        }
      }
    )
  }

  private async read(checkpoint: BuildAwareRunCheckpoint, prepared: PreparedRun): Promise<void> {
    const apiKey = this.options.openAIApiKey ?? process.env.OPENAI_API_KEY
    const readerClient =
      this.options.readerClient ?? (apiKey ? new OpenAIReaderClient({ apiKey }) : undefined)
    if (!readerClient) throw new Error("OPENAI_API_KEY is required for the read stage")
    const reader = new LongMemEvalV2Reader(readerClient, this.cacheArtifacts)
    await mapConcurrent(
      prepared.questions,
      this.options.config.execution.questionConcurrency,
      async (questionPlan) => {
        throwIfAborted(this.options.signal)
        const id = questionPlan.question.id
        const question = checkpoint.questions[id]
        if (question.stages.query.status !== "completed" || !question.queryArtifact) {
          return
        }
        await this.runStore.updateQuestionStage(checkpoint, id, "read", {
          status: "running",
          startedAt: new Date().toISOString(),
          error: undefined,
        })
        try {
          const artifact = await reader.answer({
            queryArtifact: question.queryArtifact,
            domain: questionPlan.question.domain,
            question: questionPlan.question.question,
            questionImage: questionPlan.questionImage,
            settings: this.options.config.reader,
            signal: this.options.signal,
          })
          throwIfAborted(this.options.signal)
          question.readerArtifact = artifact
          await this.runStore.updateQuestionStage(checkpoint, id, "read", {
            status: "completed",
            fingerprint: artifact.readerFingerprint,
            artifactPath: `readers/${id}/${artifact.readerFingerprint}.json`,
            completedAt: new Date().toISOString(),
            durationMs: artifact.durationMs,
            cacheHit: artifact.cacheHit,
          })
        } catch (error) {
          await this.runStore.updateQuestionStage(checkpoint, id, "read", {
            status: "failed",
            error: errorMessage(error),
            completedAt: new Date().toISOString(),
          })
          await this.runStore.updateQuestionStage(checkpoint, id, "evaluate", {
            status: "blocked",
            error: "Blocked by reader failure",
          })
          throwIfAborted(this.options.signal)
        }
      }
    )
  }

  private async evaluate(
    checkpoint: BuildAwareRunCheckpoint,
    prepared: PreparedRun
  ): Promise<void> {
    const apiKey = this.options.openAIApiKey ?? process.env.OPENAI_API_KEY
    const judge =
      this.options.strictJudge ?? (apiKey ? createOpenAIStrictJudge({ apiKey }) : undefined)
    await mapConcurrent(
      prepared.questions,
      this.options.config.execution.questionConcurrency,
      async (questionPlan) => {
        throwIfAborted(this.options.signal)
        const id = questionPlan.question.id
        const question = checkpoint.questions[id]
        if (question.stages.read.status !== "completed" || !question.readerArtifact) {
          return
        }
        const cacheKey = stableHash({
          schemaVersion: 1,
          protocol: "longmemeval-v2-official",
          implementationVersion: "longmemeval-v2-official-evaluator-v1",
          questionId: id,
          questionType: question.questionType,
          question: question.question,
          responseText: question.readerArtifact.responseText,
          groundTruth: question.groundTruth,
          evalFunction: question.evalFunction,
          evaluator: this.options.config.evaluator,
        })
        const path = `evaluations/${id}/${cacheKey}.json`
        await this.runStore.updateQuestionStage(checkpoint, id, "evaluate", {
          status: "running",
          startedAt: new Date().toISOString(),
          error: undefined,
        })
        try {
          let artifact: EvaluationArtifact
          let cacheHit = false
          try {
            artifact = await this.cacheArtifacts.readJson<EvaluationArtifact>(path)
            cacheHit = true
          } catch {
            artifact = await evaluateLongMemEvalV2({
              questionId: id,
              questionType: question.questionType,
              question: question.question,
              responseText: question.readerArtifact.responseText,
              groundTruth: question.groundTruth,
              evalFunction: question.evalFunction,
              evaluatorModel: this.options.config.evaluator.model,
              evaluatorSettings: {
                reasoningEffort: this.options.config.evaluator.reasoningEffort,
                maxCompletionTokens: this.options.config.evaluator.maxCompletionTokens,
              },
              judge,
            })
            throwIfAborted(this.options.signal)
            await this.cacheArtifacts.writeJson(path, artifact)
          }
          question.evaluationArtifact = artifact
          await this.runStore.updateQuestionStage(checkpoint, id, "evaluate", {
            status: "completed",
            fingerprint: artifact.evaluatorFingerprint,
            artifactPath: path,
            completedAt: new Date().toISOString(),
            durationMs: artifact.durationMs,
            cacheHit,
          })
        } catch (error) {
          const attemptPath = `evaluations/${id}/${cacheKey}-${crypto.randomUUID()}.failure.json`
          const failure = {
            schemaVersion: 1,
            questionId: id,
            evaluatorCacheKey: cacheKey,
            error: errorMessage(error),
            request: error instanceof StrictJudgeError ? error.request : undefined,
            rawResponse: error instanceof StrictJudgeError ? error.rawResponse : undefined,
            createdAt: new Date().toISOString(),
          }
          await this.cacheArtifacts.writeJson(attemptPath, failure)
          await this.runStore.updateQuestionStage(checkpoint, id, "evaluate", {
            status: "failed",
            artifactPath: attemptPath,
            error: errorMessage(error),
            completedAt: new Date().toISOString(),
          })
          throwIfAborted(this.options.signal)
        }
      }
    )
  }

  private async report(
    checkpoint: BuildAwareRunCheckpoint,
    prepared: PreparedRun,
    buildExecutions: BuildExecution[]
  ): Promise<BuildAwareReport> {
    throwIfAborted(this.options.signal)
    const records: LongMemEvalV2AggregateRecord[] = prepared.questions.map((questionPlan) => {
      const question = checkpoint.questions[questionPlan.question.id]
      const status =
        question.stages.evaluate.status === "completed"
          ? "completed"
          : question.stages.evaluate.status === "blocked"
            ? "blocked"
            : question.stages.evaluate.status === "failed"
              ? "failed"
              : "pending"
      return {
        questionId: question.questionId,
        questionType: question.questionType,
        evalFunction: question.evalFunction,
        status,
        score: question.evaluationArtifact?.score,
        isUnknown: question.evaluationArtifact
          ? isUnknownAnswer(question.evaluationArtifact.answer)
          : false,
      }
    })
    const official = aggregateLongMemEvalV2(records)
    const degradedBuilds = buildExecutions.filter((execution) => execution.status === "degraded")
    const failedQuestions = prepared.questions.flatMap((questionPlan) => {
      const question = checkpoint.questions[questionPlan.question.id]
      for (const stage of ["query", "read", "evaluate"] as const) {
        const state = question.stages[stage]
        if (state.status === "failed") {
          return [{ questionId: question.questionId, stage, error: state.error ?? "failed" }]
        }
      }
      return []
    })
    const report: BuildAwareReport = {
      schemaVersion: 1,
      protocol: "longmemeval-v2-official",
      runId: checkpoint.runId,
      benchmark: "longmemeval-v2",
      provider: this.options.config.provider,
      converter: "Structured Accessibility Converter",
      targetQuestionCount: prepared.questions.length,
      completedQuestionCount: records.filter((record) => record.status === "completed").length,
      failedQuestionCount: records.filter((record) => record.status !== "completed").length,
      officiallyComparable: degradedBuilds.length === 0,
      ineligibilityReasons: degradedBuilds.map(
        (execution) =>
          `${execution.plan.buildId} skipped ${execution.skippedDocumentCount} non-ready documents across ${execution.skippedTrajectoryCount} trajectories after bounded ingestion failures`
      ),
      buildIds: prepared.builds.map((build) => build.buildId),
      builds: prepared.builds.map((build) => ({
        buildId: build.buildId,
        buildFingerprint: build.buildFingerprint,
        containerTag: build.containerTag,
        domain: build.domain,
        trajectoryCount: build.orderedSourceIds.length,
        documentCount: build.documents.length,
        linkedQuestionIds: prepared.questions
          .filter(
            (question) =>
              prepared.buildByQuestionId.get(question.question.id)?.buildId === build.buildId
          )
          .map((question) => question.question.id),
        reused:
          buildExecutions.find((execution) => execution.plan.buildId === build.buildId)?.reused ??
          true,
        status:
          buildExecutions.find((execution) => execution.plan.buildId === build.buildId)?.status ??
          "ready",
        skippedTrajectoryCount:
          buildExecutions.find((execution) => execution.plan.buildId === build.buildId)
            ?.skippedTrajectoryCount ?? 0,
        skippedDocumentCount:
          buildExecutions.find((execution) => execution.plan.buildId === build.buildId)
            ?.skippedDocumentCount ?? 0,
      })),
      official,
      diagnostics: {
        queryCacheHits: records.filter(
          (record) => checkpoint.questions[record.questionId].stages.query.cacheHit
        ).length,
        readerCacheHits: records.filter(
          (record) => checkpoint.questions[record.questionId].stages.read.cacheHit
        ).length,
        remoteSearchLatencyMs: records.flatMap((record) => {
          const artifact = checkpoint.questions[record.questionId].queryArtifact
          return artifact && !artifact.cacheHit ? [artifact.remoteDurationMs] : []
        }),
        queryWallLatencyMs: records.flatMap((record) => {
          const artifact = checkpoint.questions[record.questionId].queryArtifact
          return artifact ? [artifact.wallDurationMs] : []
        }),
        contextImagesSent: records.reduce(
          (total, record) =>
            total +
            (checkpoint.questions[record.questionId].readerArtifact?.sentAssetIds.length ?? 0),
          0
        ),
        failedQuestions,
      },
      createdAt: new Date().toISOString(),
    }
    await atomicWriteJson(resolve(this.runStore.runRoot, "report.json"), report)
    return report
  }
}

export async function inspectLongMemEvalV2Run(
  runId: string,
  runRoot = "data/runs-v2"
): Promise<{
  checkpoint: BuildAwareRunCheckpoint
  report?: BuildAwareReport
}> {
  const store = new BuildAwareRunStore(runId, runRoot)
  const checkpoint = await store.load()
  try {
    const report = await Bun.file(resolve(store.runRoot, "report.json")).json()
    return { checkpoint, report: report as BuildAwareReport }
  } catch {
    return { checkpoint }
  }
}
