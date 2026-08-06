import type { BenchmarkName } from "../types/benchmark"
import type { ConcurrencyConfig } from "../types/concurrency"
import type { BuildPhaseAttempt, PhaseId, RunCheckpoint, SamplingConfig } from "../types/checkpoint"
import type { JudgeName } from "../types/judge"
import type { AnsweringRuntimeIdentity } from "../types/model"
import type { ProviderName } from "../types/provider"
import type { BenchmarkProtocol } from "../types/protocol"
import type { UnifiedQuestion } from "../types/unified"
import { createBenchmark } from "../benchmarks"
import { createJudge } from "../judges"
import { createProvider } from "../providers"
import { fingerprintProviderPrompts } from "../providers/prompt-identity"
import { getJudgeConfig, getProviderConfig } from "../utils/config"
import { logger } from "../utils/logger"
import { resolveAnsweringRuntimeIdentity, resolveModel } from "../utils/models"
import { stableSha256 } from "../utils/stable"
import {
  assertResumeBuilds,
  cloneCompletedBuildsForReuse,
  createBuildCheckpoint,
  prepareValidatedBuildPlans,
} from "./builds"
import { CheckpointManager } from "./checkpoint"
import { runAnswerPhase } from "./phases/answer"
import { runEvaluatePhase } from "./phases/evaluate"
import { runIndexingPhase } from "./phases/indexing"
import { DEFAULT_INGEST_READINESS_TIMEOUT_MS, runIngestPhase } from "./phases/ingest"
import { generateReport, printReport, saveReport } from "./phases/report"
import { runSearchPhase } from "./phases/search"
import {
  canonicalizeSelectedQuestionIds,
  fingerprintSelectedBenchmarkInput,
  resolveEffectiveDatasetRevision,
} from "./input-identity"

export interface OrchestratorOptions {
  provider: ProviderName
  benchmark: BenchmarkName
  judgeModel: string
  runId: string
  answeringModel?: string
  dataPath?: string
  datasetRevision?: string
  retrievalTopK?: number
  answerCutoff?: number
  evaluationProfile?: string
  /** Reuse validated completed ingest/index builds and start a new run at search. */
  sourceRunId?: string
  limit?: number
  sampling?: SamplingConfig
  concurrency?: ConcurrencyConfig
  ingestBatchSize?: number
  ingestReadinessTimeoutMs?: number
  force?: boolean
  questionIds?: string[]
  phases?: PhaseId[]
  /** Resolves only after dataset/protocol/build/resume validation and checkpoint durability. */
  onPreflightComplete?: () => void
  /** Internal comparison barrier: stop after durable preflight, before provider initialization. */
  preflightOnly?: boolean
}

export function mergeResumeConcurrency(
  persisted: ConcurrencyConfig | undefined,
  override: ConcurrencyConfig | undefined
): ConcurrencyConfig | undefined {
  if (!override) return persisted
  return { ...(persisted ?? {}), ...override } as ConcurrencyConfig
}

function selectQuestionsBySampling(
  allQuestions: { questionId: string; questionType: string }[],
  sampling?: SamplingConfig,
  limit?: number,
  explicitQuestionIds?: string[]
): string[] {
  if (explicitQuestionIds?.length) return [...explicitQuestionIds]
  if (sampling?.mode === "limit" && sampling.limit != null) {
    return allQuestions.slice(0, sampling.limit).map((question) => question.questionId)
  }
  if (sampling?.mode === "sample" && sampling.perCategory != null) {
    const grouped = new Map<string, typeof allQuestions>()
    for (const question of allQuestions) {
      const members = grouped.get(question.questionType) || []
      members.push(question)
      grouped.set(question.questionType, members)
    }
    return [...grouped.values()].flatMap((questions) => {
      const candidates =
        sampling.sampleType === "random"
          ? [...questions].sort(() => Math.random() - 0.5)
          : questions
      return candidates.slice(0, sampling.perCategory).map((question) => question.questionId)
    })
  }
  if (limit != null) return allQuestions.slice(0, limit).map((question) => question.questionId)
  return allQuestions.map((question) => question.questionId)
}

/**
 * Resolve the actual benchmark-owned retrieval budget from the selected
 * protocol plans. A run checkpoint has one Top-K identity, so mixed per-question
 * budgets are rejected instead of being hidden behind an optional CLI value.
 */
export function resolveEffectiveRetrievalTopK(
  protocol: BenchmarkProtocol,
  questions: UnifiedQuestion[],
  configuredTopK?: number
): number {
  if (questions.length === 0) throw new Error("Question selection is empty")
  const requestedTopKs = [
    ...new Set(
      questions.map((question) => protocol.createRetrievalPlan({ question }).requestedTopK)
    ),
  ]
  for (const topK of requestedTopKs) {
    if (!Number.isInteger(topK) || topK <= 0) {
      throw new Error(`Protocol returned invalid retrieval Top-K: ${String(topK)}`)
    }
  }
  if (requestedTopKs.length !== 1) {
    throw new Error(
      `Selected questions require mixed retrieval Top-K values: ${requestedTopKs.join(", ")}`
    )
  }
  const effectiveTopK = requestedTopKs[0]
  if (configuredTopK != null && configuredTopK !== effectiveTopK) {
    throw new Error(
      `Configured retrieval Top-K ${configuredTopK} differs from protocol plan ${effectiveTopK}`
    )
  }
  return effectiveTopK
}

export function assertResumeIdentity(
  checkpoint: RunCheckpoint,
  input: {
    provider: string
    providerAdapterVersion: string
    providerPromptFingerprint: string
    benchmark: string
    benchmarkScope: unknown
    datasetIdentity: unknown
    benchmarkInputFingerprint: string
    selectedQuestionIdsDigest: string
    protocolIdentity: unknown
    retrievalTopK?: number
    judge: string
    answeringModel: string
    answeringRuntimeIdentity: AnsweringRuntimeIdentity
    ingestBatchSize?: number
  }
): void {
  const mismatches: string[] = []
  if (checkpoint.provider !== input.provider) mismatches.push("provider")
  if (checkpoint.providerAdapterVersion !== input.providerAdapterVersion) {
    mismatches.push("provider adapter version")
  }
  if (
    checkpoint.protocolIdentity.id === "memorybench.legacy" &&
    checkpoint.providerPromptFingerprint !== input.providerPromptFingerprint
  ) {
    mismatches.push("provider prompt")
  }
  if (checkpoint.benchmark !== input.benchmark) mismatches.push("benchmark")
  if (stableSha256(checkpoint.benchmarkScope) !== stableSha256(input.benchmarkScope)) {
    mismatches.push("benchmark scope")
  }
  if (
    stableSha256(checkpoint.datasetIdentity ?? null) !== stableSha256(input.datasetIdentity ?? null)
  ) {
    mismatches.push("dataset identity")
  }
  if (checkpoint.benchmarkInputFingerprint !== input.benchmarkInputFingerprint) {
    mismatches.push("benchmark input")
  }
  if (checkpoint.selectedQuestionIdsDigest !== input.selectedQuestionIdsDigest) {
    mismatches.push("selected question IDs")
  }
  if (stableSha256(checkpoint.protocolIdentity) !== stableSha256(input.protocolIdentity)) {
    mismatches.push("benchmark protocol")
  }
  if (checkpoint.retrievalTopK !== input.retrievalTopK) mismatches.push("retrieval Top-K")
  if (checkpoint.judge !== input.judge) mismatches.push("judge model")
  if (checkpoint.answeringModel !== input.answeringModel) mismatches.push("answering model")
  if ((checkpoint.ingestBatchSize ?? 1) !== (input.ingestBatchSize ?? 1)) {
    mismatches.push("ingest batch size")
  }
  if (
    !checkpoint.answeringRuntimeIdentity ||
    stableSha256(checkpoint.answeringRuntimeIdentity) !==
      stableSha256(input.answeringRuntimeIdentity)
  ) {
    mismatches.push("answering runtime")
  }
  if (mismatches.length > 0) {
    throw new Error(`Cannot resume ${checkpoint.runId}; changed ${mismatches.join(", ")}`)
  }
}

export class Orchestrator {
  private checkpointManager: CheckpointManager

  constructor(checkpointManager = new CheckpointManager()) {
    this.checkpointManager = checkpointManager
  }

  async run(options: OrchestratorOptions): Promise<void> {
    const {
      provider: providerName,
      benchmark: benchmarkName,
      judgeModel,
      runId,
      answeringModel = "gpt-4o",
      limit,
      sampling,
      concurrency,
      ingestBatchSize,
      ingestReadinessTimeoutMs,
      sourceRunId,
      force = false,
      questionIds,
      phases = ["ingest", "indexing", "search", "answer", "evaluate", "report"],
    } = options
    if (sourceRunId && force) {
      throw new Error("--source-run cannot be combined with --force")
    }
    if (sourceRunId === runId) {
      throw new Error("Source and target run IDs must be different")
    }
    if (force && this.checkpointManager.exists(runId)) {
      this.checkpointManager.delete(runId)
      logger.info("Cleared existing checkpoint (--force)")
    }

    const existing = this.checkpointManager.exists(runId)
      ? this.checkpointManager.load(runId)
      : null
    const source = sourceRunId ? this.checkpointManager.load(sourceRunId) : null
    if (sourceRunId && !source) throw new Error(`Source checkpoint not found: ${sourceRunId}`)
    if (source && existing) throw new Error(`Target run ${runId} already exists`)
    if (source && phases[0] !== "search") {
      throw new Error("Source-build reuse must start from the search phase")
    }
    if (source && !source.targetQuestionIds?.length) {
      throw new Error(`Source run ${source.runId} does not record its selected question IDs`)
    }
    if (source && (limit !== undefined || sampling !== undefined || questionIds?.length)) {
      throw new Error("Source-build reuse must retain the source run's exact question set")
    }
    if (source && (source.provider !== providerName || source.benchmark !== benchmarkName)) {
      throw new Error(
        `Source run ${source.runId} is ${source.provider}/${source.benchmark}, not ${providerName}/${benchmarkName}`
      )
    }
    const dataPath = options.dataPath ?? existing?.dataPath ?? source?.dataPath
    const configuredDatasetRevision =
      options.datasetRevision ?? existing?.datasetRevision ?? source?.datasetRevision
    const configuredRetrievalTopK = options.retrievalTopK ?? existing?.retrievalTopK
    const configuredAnswerCutoff = options.answerCutoff ?? existing?.answerCutoff
    const configuredEvaluationProfile = options.evaluationProfile ?? existing?.evaluationProfile
    const configuredIngestBatchSize =
      ingestBatchSize ?? existing?.ingestBatchSize ?? source?.ingestBatchSize ?? 1
    const configuredIngestReadinessTimeoutMs =
      ingestReadinessTimeoutMs ??
      existing?.ingestReadinessTimeoutMs ??
      source?.ingestReadinessTimeoutMs ??
      DEFAULT_INGEST_READINESS_TIMEOUT_MS
    if (
      !Number.isInteger(configuredIngestBatchSize) ||
      configuredIngestBatchSize < 1 ||
      configuredIngestBatchSize > 600
    ) {
      throw new Error(
        `Ingest batch size must be an integer between 1 and 600; received ${configuredIngestBatchSize}`
      )
    }
    if (
      !Number.isInteger(configuredIngestReadinessTimeoutMs) ||
      configuredIngestReadinessTimeoutMs < 1
    ) {
      throw new Error(
        `Ingest readiness timeout must be a positive integer; received ${configuredIngestReadinessTimeoutMs}`
      )
    }
    const benchmark = createBenchmark(benchmarkName)
    const answeringRuntimeIdentity = resolveAnsweringRuntimeIdentity(answeringModel)

    // Dataset and protocol preflight deliberately happens before checkpoint creation
    // and before provider initialization.
    await benchmark.load({
      dataPath,
      datasetRevision: configuredDatasetRevision,
      retrievalTopK: configuredRetrievalTopK,
      answerCutoff: configuredAnswerCutoff,
      evaluationProfile: configuredEvaluationProfile,
    })
    const datasetIdentity = benchmark.getDatasetIdentity?.()
    const datasetRevision = resolveEffectiveDatasetRevision(
      configuredDatasetRevision,
      datasetIdentity
    )
    const judgeModelInfo = resolveModel(judgeModel)
    const requiredJudge = benchmark.protocol.requiredJudge
    if (
      requiredJudge &&
      (judgeModelInfo.provider !== requiredJudge.provider ||
        judgeModelInfo.id !== requiredJudge.modelId)
    ) {
      throw new Error(
        `Protocol ${benchmark.protocol.identity.id} requires judge ${requiredJudge.provider}/${requiredJudge.modelId}; received ${judgeModelInfo.provider}/${judgeModelInfo.id}`
      )
    }
    const allQuestions = benchmark.getQuestions()
    for (const question of allQuestions) benchmark.protocol.validateQuestion(question)

    const requestedQuestionIds = existing?.targetQuestionIds
      ? [...existing.targetQuestionIds]
      : source?.targetQuestionIds
        ? [...source.targetQuestionIds]
        : selectQuestionsBySampling(allQuestions, sampling, limit, questionIds)
    const targetQuestionIds = canonicalizeSelectedQuestionIds(allQuestions, requestedQuestionIds)
    const selectedQuestions = allQuestions.filter((question) =>
      targetQuestionIds.includes(question.questionId)
    )
    const retrievalTopK = resolveEffectiveRetrievalTopK(
      benchmark.protocol,
      selectedQuestions,
      configuredRetrievalTopK
    )
    const selectedQuestionIdsDigest = stableSha256(targetQuestionIds)
    const benchmarkInputFingerprint = fingerprintSelectedBenchmarkInput(
      benchmark,
      selectedQuestions
    )
    const provider = createProvider(providerName)
    const providerConfig = getProviderConfig(providerName)
    const providerPromptFingerprint = fingerprintProviderPrompts(provider.prompts)
    const providerIngestionConfigFingerprint =
      provider.getIngestionConfigFingerprint(providerConfig)
    const dataSourceRunId = existing?.dataSourceRunId || source?.dataSourceRunId || runId
    const buildPlans = prepareValidatedBuildPlans({
      benchmark,
      questions: selectedQuestions,
      provider: provider.name,
      providerAdapterVersion: provider.adapterVersion,
      providerPromptFingerprint,
      providerIngestionConfigFingerprint,
      dataSourceRunId,
      ingestBatchSize: configuredIngestBatchSize,
    })
    const reusedBuilds = source ? cloneCompletedBuildsForReuse(source, buildPlans) : undefined

    let checkpoint: RunCheckpoint
    if (existing) {
      checkpoint = existing
      assertResumeIdentity(checkpoint, {
        provider: provider.name,
        providerAdapterVersion: provider.adapterVersion,
        providerPromptFingerprint,
        benchmark: benchmark.name,
        benchmarkScope: benchmark.scope,
        datasetIdentity,
        benchmarkInputFingerprint,
        selectedQuestionIdsDigest,
        protocolIdentity: benchmark.protocol.identity,
        retrievalTopK,
        judge: judgeModel,
        answeringModel,
        answeringRuntimeIdentity,
        ingestBatchSize: configuredIngestBatchSize,
      })
      assertResumeBuilds(checkpoint, buildPlans)
      checkpoint.dataPath = dataPath
      checkpoint.datasetRevision = datasetRevision
      checkpoint.evaluationProfile = configuredEvaluationProfile
      checkpoint.answerCutoff = configuredAnswerCutoff
      checkpoint.concurrency = mergeResumeConcurrency(checkpoint.concurrency, concurrency)
      checkpoint.ingestBatchSize ??= configuredIngestBatchSize
      checkpoint.ingestReadinessTimeoutMs = configuredIngestReadinessTimeoutMs
      this.checkpointManager.updateStatus(checkpoint, "running")
    } else {
      checkpoint = this.checkpointManager.create(
        runId,
        provider.name,
        benchmark.name,
        judgeModel,
        answeringModel,
        {
          providerAdapterVersion: provider.adapterVersion,
          providerPromptFingerprint,
          benchmarkScope: benchmark.scope,
          protocolIdentity: benchmark.protocol.identity,
          selectedQuestionIdsDigest,
          datasetIdentity,
          benchmarkInputFingerprint,
          dataPath,
          datasetRevision,
          retrievalTopK,
          evaluationProfile: configuredEvaluationProfile,
          answerCutoff: configuredAnswerCutoff,
          dataSourceRunId,
          limit,
          sampling,
          targetQuestionIds,
          concurrency,
          ingestBatchSize: configuredIngestBatchSize,
          ingestReadinessTimeoutMs: configuredIngestReadinessTimeoutMs,
          status: "initializing",
        }
      )
      for (const [index, plan] of buildPlans.entries()) {
        this.checkpointManager.initBuild(
          checkpoint,
          reusedBuilds?.[index] ?? createBuildCheckpoint(plan)
        )
      }
      for (const question of selectedQuestions) {
        const plan = buildPlans.find((candidate) =>
          candidate.memberQuestionIds.includes(question.questionId)
        )
        if (!plan) throw new Error(`No validated build found for ${question.questionId}`)
        this.checkpointManager.initQuestion(checkpoint, question.questionId, plan.buildId, {
          question: question.question,
          groundTruth: question.groundTruth,
          questionType: question.questionType,
          questionDate:
            typeof question.metadata?.questionDate === "string"
              ? question.metadata.questionDate
              : undefined,
        })
      }
      this.checkpointManager.updateStatus(checkpoint, "running")
      await this.checkpointManager.flush(runId)
    }

    const judgeName = judgeModelInfo.provider as JudgeName
    await this.checkpointManager.flush(runId)
    options.onPreflightComplete?.()
    if (options.preflightOnly) return
    logger.info(
      `Starting ${benchmark.scope.displayName}: ${providerName}, protocol ${benchmark.protocol.identity.id}@${benchmark.protocol.identity.version}, ${selectedQuestions.length} questions across ${buildPlans.length} builds`
    )

    try {
      // All dataset, protocol, haystack and resume checks have passed at this point.
      // Initialization still belongs to the durable run lifecycle: a provider
      // failure must mark and flush the checkpoint as failed.
      await provider.initialize(providerConfig)
      const runsBuildPhase = phases.includes("ingest") || phases.includes("indexing")
      let buildPhaseAttempt: BuildPhaseAttempt | undefined
      let buildPhaseStartedMs = 0
      if (runsBuildPhase) {
        buildPhaseStartedMs = Date.now()
        buildPhaseAttempt = {
          startedAt: new Date().toISOString(),
          status: "in_progress",
        }
        checkpoint.buildPhaseAttempts.push(buildPhaseAttempt)
        this.checkpointManager.save(checkpoint)
      }

      if (phases.includes("ingest")) {
        await runIngestPhase(provider, checkpoint, this.checkpointManager, buildPlans)
      }
      if (phases.includes("indexing")) {
        await runIndexingPhase(provider, checkpoint, this.checkpointManager)
      }
      if (buildPhaseAttempt) {
        buildPhaseAttempt.status = "completed"
        buildPhaseAttempt.completedAt = new Date().toISOString()
        buildPhaseAttempt.durationMs = Date.now() - buildPhaseStartedMs
        this.checkpointManager.save(checkpoint)
      }
      const phaseQuestionIds = questionIds?.length ? questionIds : targetQuestionIds
      if (phases.includes("search")) {
        await runSearchPhase(
          provider,
          benchmark,
          checkpoint,
          this.checkpointManager,
          phaseQuestionIds
        )
      }
      if (phases.includes("answer")) {
        await runAnswerPhase(
          benchmark,
          checkpoint,
          this.checkpointManager,
          phaseQuestionIds,
          provider
        )
      }
      if (phases.includes("evaluate")) {
        const judge = createJudge(judgeName)
        const judgeConfig = getJudgeConfig(judgeName)
        judgeConfig.model = judgeModel
        await judge.initialize(judgeConfig)
        await runEvaluatePhase(
          judge,
          benchmark,
          checkpoint,
          this.checkpointManager,
          phaseQuestionIds,
          provider
        )
      }
      if (phases.includes("report")) {
        const report = generateReport(benchmark, checkpoint)
        saveReport(report)
        printReport(report)
      }
      this.checkpointManager.updateStatus(checkpoint, "completed")
      await this.checkpointManager.flush(runId)
      logger.success("Run complete!")
    } catch (error) {
      const activeBuildAttempt = checkpoint.buildPhaseAttempts.at(-1)
      if (activeBuildAttempt?.status === "in_progress") {
        activeBuildAttempt.status = "failed"
        activeBuildAttempt.completedAt = new Date().toISOString()
        activeBuildAttempt.durationMs = Math.max(
          0,
          Date.parse(activeBuildAttempt.completedAt) - Date.parse(activeBuildAttempt.startedAt)
        )
      }
      this.checkpointManager.updateStatus(checkpoint, "failed")
      await this.checkpointManager.flush(runId)
      throw error
    }
  }

  async ingest(
    options: Omit<OrchestratorOptions, "judgeModel" | "phases"> & { judgeModel?: string }
  ): Promise<void> {
    await this.run({
      ...options,
      judgeModel:
        options.judgeModel ||
        createBenchmark(options.benchmark).protocol.requiredJudge?.modelAlias ||
        "gpt-4o",
      phases: ["ingest", "indexing"],
    })
  }

  async search(
    options: Omit<OrchestratorOptions, "judgeModel" | "phases"> & { judgeModel?: string }
  ): Promise<void> {
    await this.run({
      ...options,
      judgeModel:
        options.judgeModel ||
        createBenchmark(options.benchmark).protocol.requiredJudge?.modelAlias ||
        "gpt-4o",
      phases: ["search"],
    })
  }

  async evaluate(options: OrchestratorOptions): Promise<void> {
    await this.run({ ...options, phases: ["answer", "evaluate", "report"] })
  }

  async testQuestion(options: OrchestratorOptions & { questionId: string }): Promise<void> {
    await this.run({
      ...options,
      questionIds: [options.questionId],
      phases: ["search", "answer", "evaluate", "report"],
    })
  }

  getStatus(runId: string): void {
    const checkpoint = this.checkpointManager.load(runId)
    if (!checkpoint) {
      logger.error(`No run found: ${runId}`)
      return
    }
    const summary = this.checkpointManager.getSummary(checkpoint)
    console.log(`Run: ${runId}`)
    console.log(`Provider: ${checkpoint.provider}`)
    console.log(`Benchmark: ${checkpoint.benchmarkScope.displayName}`)
    console.log(
      `Builds: ${summary.builds} (${summary.ingested} ingested, ${summary.indexed} indexed)`
    )
    const deferredSessions = Object.values(checkpoint.builds).reduce(
      (sum, build) => sum + (build.ingest.deferredSessions?.length ?? 0),
      0
    )
    if (deferredSessions > 0) console.log(`Deferred sessions awaiting retry: ${deferredSessions}`)
    console.log(`Questions: ${summary.total}`)
    console.log(`Searched: ${summary.searched}`)
    console.log(`Answered: ${summary.answered}`)
    console.log(`Evaluated: ${summary.evaluated}`)
  }
}

export const orchestrator = new Orchestrator()
export { CheckpointManager } from "./checkpoint"
