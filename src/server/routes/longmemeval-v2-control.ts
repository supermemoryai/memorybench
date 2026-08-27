import { lstat, mkdir, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { z } from "zod"
import { LONGMEMEVAL_V2_COMPLETION_MARKER } from "../../benchmarks/longmemeval-v2/download"
import { LONGMEMEVAL_V2_PINNED_REVISION } from "../../benchmarks/longmemeval-v2/source"
import { atomicWriteJson } from "../../core/canonical"
import {
  LongMemEvalV2Runner,
  type LongMemEvalV2ExecuteOptions,
  type LongMemEvalV2RunnerOptions,
  type LongMemEvalV2RunThrough,
} from "../../orchestrator/longmemeval-v2"
import { BuildAwareRunStore } from "../../orchestrator/build-aware-run-store"
import {
  AdvancedSupermemoryProvider,
  supermemoryPreflightGatePath,
  validateSupermemoryPreflightReport,
  type SupermemoryPreflightReport,
} from "../../providers/supermemory/advanced"
import {
  createLongMemEvalV2BuildProvider,
  isLongMemEvalV2BuildProviderName,
} from "../../providers/build-aware"
import type { BuildAwareRunCheckpoint, BuildAwareRunConfig } from "../../types/build-aware"
import type { ProviderName } from "../../types/provider"
import { config as serverConfig } from "../../utils/config"
import {
  endRun as unregisterSharedRun,
  isRunActive as isLegacyRunActive,
  requestStop as requestSharedStop,
  startRun as registerSharedRun,
} from "../runState"

const SAFE_RUN_ID = /^[A-Za-z0-9_-]{1,100}$/
const DEFAULT_PREFLIGHT_MAX_AGE_MS = 24 * 60 * 60_000
const RUN_THROUGH_VALUES = ["plan", "build", "query", "read", "evaluate", "report", "run"] as const

const positiveInteger = z.number().int().positive()
const boundedString = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"), {
    message: "must not contain a null byte",
  })
const reasoningEffort = z.enum(["none", "minimal", "low", "medium", "high", "xhigh"])
const runThrough = z.enum(RUN_THROUGH_VALUES)
const providerName = z.enum(["supermemory", "filesystem", "rag", "mem0", "zep"])

const startSchema = z
  .object({
    runId: z.string().regex(SAFE_RUN_ID, "must match [A-Za-z0-9_-]+ and be <= 100 characters"),
    provider: providerName.default("supermemory"),
    datasetPath: boundedString,
    tier: z.enum(["small", "medium"]).default("small"),
    allowMedium: z.boolean().default(false),
    domain: z.enum(["web", "enterprise", "all"]).default("all"),
    questionIds: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(200)
          .regex(/^[A-Za-z0-9._:-]+$/)
      )
      .min(1)
      .max(451)
      .optional(),
    limit: positiveInteger.max(451).optional(),
    perCategory: positiveInteger.max(451).optional(),
    haystackLimit: positiveInteger.max(447).optional(),
    seed: z.string().min(1).max(200).default("memorybench-longmemeval-v2"),
    mode: z.enum(["benchmark", "one-trajectory-canary"]).default("benchmark"),
    topK: positiveInteger.max(100).default(20),
    evidenceTopK: positiveInteger.max(100).default(20),
    threshold: z.number().finite().default(0),
    readerModel: z.string().trim().min(1).max(100).default("gpt-5"),
    evaluatorModel: z.string().trim().min(1).max(100).default("gpt-5"),
    reasoningEffort: reasoningEffort.default("high"),
    evaluatorReasoningEffort: reasoningEffort.default("high"),
    buildConcurrency: positiveInteger.max(20).default(2),
    questionConcurrency: positiveInteger.max(100).default(5),
    trajectoryConcurrency: positiveInteger.max(100).default(4),
    maxInFlightRequests: positiveInteger.max(100).default(20),
    maxTrajectoryAttempts: positiveInteger.max(20).default(4),
    indexingTimeoutMs: positiveInteger.max(24 * 60 * 60_000).default(30 * 60_000),
    strictIngestion: z.boolean().default(false),
    runThrough: runThrough.default("plan"),
    allowFullRun: z.boolean().default(false),
    forceBuild: z.boolean().default(false),
    freshQuery: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.tier === "medium" && value.runThrough !== "plan" && !value.allowMedium) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowMedium"],
        message: "Medium is an explicit high-cost tier; allowMedium must be true",
      })
    }
    if (value.evidenceTopK > value.topK) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidenceTopK"],
        message: "cannot exceed topK",
      })
    }
    const selectors = [
      value.questionIds,
      value.limit,
      value.perCategory,
      value.haystackLimit,
    ].filter((item) => item !== undefined)
    if (selectors.length > 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["questionIds"],
        message: "questionIds, limit, perCategory, and haystackLimit are mutually exclusive",
      })
    }
    if (selectors.length === 0 && value.runThrough !== "plan" && !value.allowFullRun) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowFullRun"],
        message: "must be true for a non-plan run with the complete tier selection",
      })
    }
    if (value.questionIds && new Set(value.questionIds).size !== value.questionIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["questionIds"],
        message: "must not contain duplicates",
      })
    }
    if (value.mode === "one-trajectory-canary") {
      if (value.questionIds?.length !== 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["questionIds"],
          message: "Canary requires exactly one question ID",
        })
      }
      if (!["plan", "build", "query"].includes(value.runThrough)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["runThrough"],
          message: "Canary may only plan, build, or query",
        })
      }
    }
  })

const resumeSchema = z
  .object({
    runThrough: runThrough.optional(),
    allowFullRun: z.boolean().default(false),
    forceBuild: z.boolean().default(false),
    freshQuery: z.boolean().default(false),
  })
  .strict()
const emptyBodySchema = z.object({}).strict()
const preflightSchema = z
  .object({
    topK: positiveInteger.max(100).default(20),
  })
  .strict()

type StartInput = z.infer<typeof startSchema>
type ResumeInput = z.infer<typeof resumeSchema>

interface RunnerLike {
  execute(options?: LongMemEvalV2ExecuteOptions): Promise<BuildAwareRunCheckpoint>
}

interface ActiveRun {
  controller: AbortController
  status: "running" | "stopping"
  startedAt: string
}

interface DatasetCandidate {
  path: string
  source: "env" | "repo" | "sibling"
}

export interface LongMemEvalV2ControlEvent {
  action: "start" | "resume" | "stop-request" | "completed" | "failed" | "stopped"
  at: string
  through?: LongMemEvalV2RunThrough
  message?: string
  provider?: ProviderName
  forceBuild?: boolean
  freshQuery?: boolean
}

export interface LongMemEvalV2ControlHistory {
  schemaVersion: 1
  runId: string
  events: LongMemEvalV2ControlEvent[]
}

export interface LongMemEvalV2ControlRouteOptions {
  runsRoot?: string
  buildsRoot?: string
  artifactsRoot?: string
  preflightRoot?: string
  serviceBaseUrl?: string
  datasetCandidates?: DatasetCandidate[]
  runnerFactory?: (options: LongMemEvalV2RunnerOptions) => RunnerLike | Promise<RunnerLike>
  preflightRunner?: (input: { topK: number }) => Promise<SupermemoryPreflightReport>
  broadcast?: (message: Record<string, unknown>) => void
  isLegacyRunActive?: (runId: string) => boolean
  now?: () => number
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function redact(message: string): string {
  return message.replace(/\b(?:sk|sm)_[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
}

function errorMessage(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error))
}

function safeDecodeRunId(raw: string): string | null {
  try {
    const decoded = decodeURIComponent(raw)
    return SAFE_RUN_ID.test(decoded) ? decoded : null
  } catch {
    return null
  }
}

function validLocalOrigin(request: Request): boolean {
  const raw = request.headers.get("origin")
  if (!raw) return true
  try {
    const origin = new URL(raw)
    return (
      origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
    )
  } catch {
    return false
  }
}

async function parseBody<T extends z.ZodTypeAny>(
  request: Request,
  schema: T
): Promise<z.output<T>> {
  let value: unknown
  try {
    value = await request.json()
  } catch {
    throw new Error("Request body must be valid JSON")
  }
  const result = schema.safeParse(value)
  if (!result.success) {
    const issue = result.error.issues[0]
    const field = issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""
    throw new Error(`Invalid request body: ${field}${issue.message}`)
  }
  return result.data
}

async function parseOptionalEmptyBody(request: Request): Promise<void> {
  const text = await request.text()
  if (!text.trim()) return
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error("Request body must be valid JSON")
  }
  const result = emptyBodySchema.safeParse(value)
  if (!result.success) throw new Error("Stop request body must be empty")
}

function nativeThrough(value: (typeof RUN_THROUGH_VALUES)[number]): LongMemEvalV2RunThrough {
  return value === "run" ? "report" : value
}

function readerBudgets(model: string): {
  maxCompletionTokens: number
  maxContextTokens: number
} {
  if (/^gpt-4o(?:-|$)/i.test(model)) {
    return { maxCompletionTokens: 8_000, maxContextTokens: 120_000 }
  }
  if (/^gpt-4(?:\.|-|$)/i.test(model)) {
    return { maxCompletionTokens: 16_000, maxContextTokens: 200_000 }
  }
  return { maxCompletionTokens: 20_000, maxContextTokens: 200_000 }
}

function retrievalProfile(provider: ProviderName): {
  searchMode: "hybrid" | "memories"
  rerank: boolean
} {
  if (provider === "filesystem" || provider === "mem0" || provider === "zep") {
    return { searchMode: "memories", rerank: provider === "zep" }
  }
  return { searchMode: "hybrid", rerank: provider === "supermemory" }
}

function configFrom(input: StartInput, serviceBaseUrl: string): BuildAwareRunConfig {
  const budgets = readerBudgets(input.readerModel)
  const retrieval = retrievalProfile(input.provider)
  return {
    provider: input.provider,
    benchmark: "longmemeval-v2",
    mode: input.mode,
    datasetPath: resolve(input.datasetPath),
    datasetRevision: LONGMEMEVAL_V2_PINNED_REVISION,
    tier: input.tier,
    domain: input.domain,
    questionIds: input.questionIds,
    limit: input.limit,
    perCategory: input.perCategory,
    haystackLimit: input.haystackLimit,
    seed: input.seed,
    retrieval: {
      topK: input.topK,
      threshold: input.threshold,
      searchMode: retrieval.searchMode,
      rerank: retrieval.rerank,
      rewriteQuery: false,
      includeSummaries: true,
      includeChunks: true,
      includeDocuments: true,
      includeRelatedMemories: true,
      metadataFilter: {},
    },
    reader: {
      model: input.readerModel,
      reasoningEffort: input.reasoningEffort,
      maxCompletionTokens: budgets.maxCompletionTokens,
      maxContextTokens: budgets.maxContextTokens,
      evidenceTopK: input.evidenceTopK,
      maxImages: 100,
      maxImageBytes: 20 * 1024 * 1024,
      malformedResponseAttempts: 3,
    },
    evaluator: {
      model: input.evaluatorModel,
      reasoningEffort: input.evaluatorReasoningEffort,
      maxCompletionTokens: 4096,
    },
    build: {
      serviceBaseUrl,
      dreaming: "instant",
      rootFilterMode: "self",
      maxDocumentChars: 200_000,
      trajectoryConcurrency: input.trajectoryConcurrency,
      maxInFlightRequests: input.maxInFlightRequests,
      maxTrajectoryAttempts: input.maxTrajectoryAttempts,
      indexingTimeoutMs: input.indexingTimeoutMs,
      pollIntervalMs: 2_000,
      preflightMaxAgeMs: DEFAULT_PREFLIGHT_MAX_AGE_MS,
      continueOnIndexingTimeout: !input.strictIngestion,
    },
    execution: {
      buildConcurrency: input.buildConcurrency,
      questionConcurrency: input.questionConcurrency,
    },
  }
}

async function checkpointStatus(store: BuildAwareRunStore, active: boolean, uiManaged: boolean) {
  try {
    const checkpoint = await store.load()
    const interrupted = checkpoint.status === "running" && !active && uiManaged
    return {
      status: interrupted ? "failed" : checkpoint.status,
      currentStage: checkpoint.currentStage,
      updatedAt: checkpoint.updatedAt,
      ...(interrupted
        ? { error: "Run process is no longer active; resume from the durable checkpoint" }
        : checkpoint.error
          ? { error: redact(checkpoint.error) }
          : {}),
    }
  } catch {
    return null
  }
}

async function pathKind(path: string): Promise<"file" | "directory" | "missing"> {
  try {
    const metadata = await lstat(path)
    if (metadata.isFile()) return "file"
    if (metadata.isDirectory()) return "directory"
    return "missing"
  } catch {
    return "missing"
  }
}

async function inspectDataset(candidate: DatasetCandidate) {
  const path = resolve(candidate.path)
  const markerPath = resolve(path, LONGMEMEVAL_V2_COMPLETION_MARKER)
  let pinnedMarker = false
  try {
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>
    pinnedMarker = marker.schemaVersion === 1 && marker.revision === LONGMEMEVAL_V2_PINNED_REVISION
  } catch {
    // A marker is an optimization signal; the loader still performs authoritative validation.
  }
  const [rootKind, questions, trajectories, haystack, screenshots] = await Promise.all([
    pathKind(path),
    pathKind(resolve(path, "questions.jsonl")),
    pathKind(resolve(path, "trajectories.jsonl")),
    pathKind(resolve(path, "haystacks/lme_v2_small.json")),
    pathKind(resolve(path, "screenshots")),
  ])
  const coreFiles = questions === "file" && trajectories === "file" && haystack === "file"
  const hasScreenshots = screenshots === "directory"
  return {
    path,
    source: candidate.source,
    exists: rootKind === "directory",
    coreFiles,
    pinnedMarker,
    screenshots: hasScreenshots,
    prepared: coreFiles && hasScreenshots,
  }
}

async function inspectPreflight(input: { root: string; baseUrl: string; now: number }): Promise<{
  status: "passing" | "missing" | "invalid" | "expired"
  baseUrl: string
  generatedAt?: string
  expiresAt?: string
  testedTopK?: number
  blockers?: string[]
}> {
  const path = supermemoryPreflightGatePath(input.root, input.baseUrl)
  let report: SupermemoryPreflightReport
  try {
    report = JSON.parse(await readFile(path, "utf8")) as SupermemoryPreflightReport
  } catch {
    return { status: "missing", baseUrl: input.baseUrl }
  }
  const generated = Date.parse(report.generatedAt)
  const expiresAt = Number.isFinite(generated)
    ? new Date(generated + DEFAULT_PREFLIGHT_MAX_AGE_MS).toISOString()
    : undefined
  const common = {
    baseUrl: input.baseUrl,
    ...(typeof report.generatedAt === "string" ? { generatedAt: report.generatedAt } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(typeof report.searchContract?.requestedTopK === "number"
      ? { testedTopK: report.searchContract.requestedTopK }
      : {}),
    ...(Array.isArray(report.blockers) ? { blockers: report.blockers.map(String) } : {}),
  }
  if (
    Number.isFinite(generated) &&
    (input.now < generated || input.now - generated > DEFAULT_PREFLIGHT_MAX_AGE_MS)
  ) {
    return { status: "expired", ...common }
  }
  try {
    validateSupermemoryPreflightReport(report, {
      baseUrl: input.baseUrl,
      requiredTopK: 20,
      maxAgeMs: DEFAULT_PREFLIGHT_MAX_AGE_MS,
      now: input.now,
    })
    return { status: "passing", ...common }
  } catch {
    return { status: "invalid", ...common }
  }
}

function configuredDatasetCandidates(): DatasetCandidate[] {
  const candidates: DatasetCandidate[] = []
  const environmentPath = process.env.LONGMEMEVAL_V2_DATASET_PATH?.trim()
  if (environmentPath && !environmentPath.includes("\0")) {
    candidates.push({ path: environmentPath, source: "env" })
  }
  candidates.push(
    { path: "data/benchmarks/longmemeval-v2", source: "repo" },
    { path: "../LongMemEval-V2/data/longmemeval-v2", source: "sibling" }
  )
  const unique = new Set<string>()
  return candidates.filter((candidate) => {
    const path = resolve(candidate.path)
    if (unique.has(path)) return false
    unique.add(path)
    return true
  })
}

export function createLongMemEvalV2ControlHandler(options: LongMemEvalV2ControlRouteOptions = {}) {
  const runsRoot = resolve(options.runsRoot ?? "data/runs-v2")
  const buildsRoot = resolve(options.buildsRoot ?? "data/memory-builds-v2")
  const artifactsRoot = resolve(options.artifactsRoot ?? "data/artifacts-v2")
  const preflightRoot = resolve(options.preflightRoot ?? "data/preflights-v2")
  const serviceBaseUrl = options.serviceBaseUrl ?? serverConfig.supermemoryBaseUrl
  const runnerFactory = options.runnerFactory
  const broadcast = options.broadcast ?? (() => {})
  const legacyActive = options.isLegacyRunActive ?? isLegacyRunActive
  const now = options.now ?? Date.now
  const activeRuns = new Map<string, ActiveRun>()
  const controlQueues = new Map<string, Promise<void>>()

  const createRunner = async (
    runnerOptions: LongMemEvalV2RunnerOptions,
    through: LongMemEvalV2RunThrough
  ): Promise<RunnerLike> => {
    if (through === "plan") {
      return runnerFactory ? runnerFactory(runnerOptions) : new LongMemEvalV2Runner(runnerOptions)
    }
    if (!isLongMemEvalV2BuildProviderName(runnerOptions.config.provider)) {
      throw new Error(
        `${runnerOptions.config.provider} does not yet have a safe LongMemEval-V2 adapter; use Plan only`
      )
    }
    if (runnerFactory) return runnerFactory(runnerOptions)
    const provider = await createLongMemEvalV2BuildProvider({
      provider: runnerOptions.config.provider,
      serviceBaseUrl: runnerOptions.config.build.serviceBaseUrl,
      maxInFlightRequests: runnerOptions.config.build.maxInFlightRequests,
      operationTimeoutMs: runnerOptions.config.build.indexingTimeoutMs,
      signal: runnerOptions.signal,
    })
    return new LongMemEvalV2Runner({
      ...runnerOptions,
      provider,
      requirePreflight: runnerOptions.config.provider === "supermemory",
    })
  }
  let preflightActivity:
    | { status: "idle" }
    | { status: "running"; startedAt: string; topK: number }
    | { status: "passed"; startedAt: string; completedAt: string; topK: number }
    | { status: "failed"; startedAt: string; completedAt: string; topK: number; error: string } = {
    status: "idle",
  }
  const runPreflight =
    options.preflightRunner ??
    (async ({ topK }: { topK: number }) => {
      const apiKey = process.env.SUPERMEMORY_API_KEY?.trim()
      if (!apiKey) throw new Error("SUPERMEMORY_API_KEY is required for preflight")
      const provider = new AdvancedSupermemoryProvider({
        apiKey,
        baseUrl: serviceBaseUrl,
        maxInFlightRequests: 20,
      })
      return provider.preflight({
        searchTopK: topK,
        readinessTimeoutMs: 5 * 60_000,
        searchVisibilityTimeoutMs: 2 * 60_000,
        searchPollMs: 5_000,
        keepDocuments: false,
      })
    })

  const readControlHistory = async (runId: string): Promise<LongMemEvalV2ControlHistory> => {
    const store = new BuildAwareRunStore(runId, runsRoot)
    try {
      const history = JSON.parse(
        await readFile(resolve(store.runRoot, "control.json"), "utf8")
      ) as LongMemEvalV2ControlHistory
      if (history.schemaVersion === 1 && history.runId === runId && Array.isArray(history.events)) {
        return history
      }
    } catch {
      // A control history is supplementary to the durable benchmark checkpoint.
    }
    return { schemaVersion: 1, runId, events: [] }
  }

  const appendControlEvent = async (
    runId: string,
    event: LongMemEvalV2ControlEvent
  ): Promise<void> => {
    const previous = controlQueues.get(runId) ?? Promise.resolve()
    const next = previous.then(async () => {
      const store = new BuildAwareRunStore(runId, runsRoot)
      await mkdir(store.runRoot, { recursive: true })
      const history = await readControlHistory(runId)
      history.events = [...history.events, event].slice(-100)
      await atomicWriteJson(resolve(store.runRoot, "control.json"), history)
    })
    controlQueues.set(runId, next)
    try {
      await next
    } finally {
      if (controlQueues.get(runId) === next) controlQueues.delete(runId)
    }
  }

  const release = (runId: string, controller: AbortController): void => {
    if (activeRuns.get(runId)?.controller === controller) {
      activeRuns.delete(runId)
      unregisterSharedRun(runId)
    }
  }

  const reserve = (runId: string, controller: AbortController): void => {
    activeRuns.set(runId, {
      controller,
      status: "running",
      startedAt: new Date(now()).toISOString(),
    })
    registerSharedRun(runId, "longmemeval-v2", controller)
  }

  const execute = (
    runId: string,
    controller: AbortController,
    runner: RunnerLike,
    executeOptions: LongMemEvalV2ExecuteOptions,
    through: LongMemEvalV2RunThrough
  ): void => {
    void Promise.resolve()
      .then(() => runner.execute(executeOptions))
      .then(async () => {
        await appendControlEvent(runId, {
          action: "completed",
          at: new Date(now()).toISOString(),
          through,
        })
        broadcast({ type: "run_complete", runId })
      })
      .catch(async (error) => {
        const stopped = controller.signal.aborted
        await appendControlEvent(runId, {
          action: stopped ? "stopped" : "failed",
          at: new Date(now()).toISOString(),
          through,
          message: stopped ? "Run stopped by user" : errorMessage(error),
        })
        broadcast({
          type: stopped ? "run_stopped" : "error",
          runId,
          message: stopped ? "Run stopped by user" : errorMessage(error),
        })
      })
      .finally(() => release(runId, controller))
  }

  return async function handleLongMemEvalV2ControlRoutes(
    request: Request,
    url: URL
  ): Promise<Response | null> {
    const method = request.method
    const pathname = url.pathname

    if (method === "GET" && pathname === "/api/runs-v2/options") {
      const candidates = options.datasetCandidates ?? configuredDatasetCandidates()
      const datasets = await Promise.all(candidates.map(inspectDataset))
      const selected = datasets.find((candidate) => candidate.prepared) ?? datasets[0]
      const preflight = await inspectPreflight({
        root: preflightRoot,
        baseUrl: serviceBaseUrl,
        now: now(),
      })
      const supermemoryConfigured = Boolean(process.env.SUPERMEMORY_API_KEY?.trim())
      const openAIConfigured = Boolean(process.env.OPENAI_API_KEY?.trim())
      const mem0Configured = Boolean(process.env.MEM0_API_KEY?.trim())
      const zepConfigured = Boolean(process.env.ZEP_API_KEY?.trim())
      const providerReady = supermemoryConfigured && preflight.status === "passing"
      const providerDescriptors = [
        {
          name: "supermemory",
          displayName: "Supermemory",
          adapterAvailable: true,
          configured: supermemoryConfigured,
          requiresPreflight: true,
          searchMode: "hybrid",
          rerank: true,
          note: "Reference V2 adapter with remote reconciliation and verified screenshot provenance.",
          capabilities: {
            plan: true,
            build: providerReady,
            query: providerReady,
            read: providerReady && openAIConfigured,
            evaluate: providerReady && openAIConfigured,
            report: providerReady && openAIConfigured,
          },
        },
        ...[
          ["filesystem", "Filesystem", "memories"],
          ["rag", "Local RAG", "hybrid"],
        ].map(([name, displayName, searchMode]) => ({
          name,
          displayName,
          adapterAvailable: true,
          configured: openAIConfigured,
          requiresPreflight: false,
          searchMode,
          rerank: false,
          note:
            name === "filesystem"
              ? "Durable MEMORY.md-style extraction with exact sidecar reconciliation."
              : "Durable hybrid retrieval backed by a per-build SQLite/WAL index.",
          capabilities: {
            plan: true,
            build: openAIConfigured,
            query: openAIConfigured,
            read: openAIConfigured,
            evaluate: openAIConfigured,
            report: openAIConfigured,
          },
        })),
        {
          name: "mem0",
          displayName: "Mem0",
          adapterAvailable: false,
          configured: mem0Configured,
          requiresPreflight: false,
          searchMode: "memories",
          rerank: false,
          note: "Plan only: async event identity and exact interrupted-ingestion cleanup still need a live contract adapter.",
          capabilities: {
            plan: true,
            build: false,
            query: false,
            read: false,
            evaluate: false,
            report: false,
          },
        },
        {
          name: "zep",
          displayName: "Zep",
          adapterAvailable: false,
          configured: zepConfigured,
          requiresPreflight: false,
          searchMode: "memories",
          rerank: true,
          note: "Plan only: exact episode reconciliation, provenance, and individual cleanup are not yet proven.",
          capabilities: {
            plan: true,
            build: false,
            query: false,
            read: false,
            evaluate: false,
            report: false,
          },
        },
      ]
      return json({
        defaults: {
          provider: "supermemory",
          datasetPath: selected?.path ?? null,
          tier: "small",
          domain: "all",
          mode: "benchmark",
          topK: 20,
          evidenceTopK: 20,
          reasoningEffort: "high",
          readerModel: "gpt-5",
          evaluatorModel: "gpt-5",
          buildConcurrency: 2,
          questionConcurrency: 5,
          trajectoryConcurrency: 4,
          maxInFlightRequests: 20,
          maxTrajectoryAttempts: 4,
          indexingTimeoutMs: 30 * 60_000,
          strictIngestion: false,
          runThrough: "plan",
        },
        haystacks: {
          small: { all: 2, web: 1, enterprise: 1, trajectoriesPerBuild: 100 },
          medium: { all: 447, web: 236, enterprise: 211 },
        },
        datasets,
        providers: providerDescriptors,
        credentials: {
          supermemoryConfigured,
          openAIConfigured,
          mem0Configured,
          zepConfigured,
        },
        preflight,
        preflightActivity,
        capabilities: {
          plan: true,
          build: providerReady,
          query: providerReady,
          read: providerReady && openAIConfigured,
          evaluate: providerReady && openAIConfigured,
          report: providerReady && openAIConfigured,
        },
      })
    }

    if (method === "POST" && pathname === "/api/runs-v2/preflight") {
      if (!validLocalOrigin(request)) return json({ error: "Origin is not allowed" }, 403)
      let input: z.infer<typeof preflightSchema>
      try {
        input = await parseBody(request, preflightSchema)
      } catch (error) {
        return json({ error: errorMessage(error) }, 400)
      }
      if (preflightActivity.status === "running") {
        return json({ error: "A Supermemory preflight is already running" }, 409)
      }
      if (!options.preflightRunner && !process.env.SUPERMEMORY_API_KEY?.trim()) {
        return json({ error: "SUPERMEMORY_API_KEY is not configured on the server" }, 400)
      }
      const startedAt = new Date(now()).toISOString()
      preflightActivity = { status: "running", startedAt, topK: input.topK }
      void runPreflight({ topK: input.topK })
        .then(async (report) => {
          if (!report.allPassed) {
            throw new Error(
              `Supermemory preflight failed${report.blockers.length ? `: ${report.blockers.join(", ")}` : ""}`
            )
          }
          await atomicWriteJson(supermemoryPreflightGatePath(preflightRoot, serviceBaseUrl), report)
          preflightActivity = {
            status: "passed",
            startedAt,
            completedAt: new Date(now()).toISOString(),
            topK: input.topK,
          }
          broadcast({ type: "longmemeval_v2_preflight_complete", topK: input.topK })
        })
        .catch((error) => {
          preflightActivity = {
            status: "failed",
            startedAt,
            completedAt: new Date(now()).toISOString(),
            topK: input.topK,
            error: errorMessage(error),
          }
          broadcast({
            type: "error",
            scope: "longmemeval-v2-preflight",
            message: errorMessage(error),
          })
        })
      return json(
        {
          message: "Supermemory preflight started",
          statusUrl: "/api/runs-v2/options",
        },
        202
      )
    }

    if (method === "POST" && pathname === "/api/runs-v2/start") {
      if (!validLocalOrigin(request)) return json({ error: "Origin is not allowed" }, 403)
      let input: StartInput
      try {
        input = await parseBody(request, startSchema)
      } catch (error) {
        return json({ error: errorMessage(error) }, 400)
      }
      if (activeRuns.has(input.runId) || legacyActive(input.runId)) {
        return json({ error: "Run is already active" }, 409)
      }
      const controller = new AbortController()
      reserve(input.runId, controller)
      const store = new BuildAwareRunStore(input.runId, runsRoot)
      if (await store.exists()) {
        release(input.runId, controller)
        return json({ error: `Run ${input.runId} already exists; use resume` }, 409)
      }
      const config = configFrom(input, serviceBaseUrl)
      const requestedThrough = nativeThrough(input.runThrough)
      let runner: RunnerLike
      try {
        runner = await createRunner(
          {
            runId: input.runId,
            config,
            runRoot: runsRoot,
            buildRoot: buildsRoot,
            cacheRoot: artifactsRoot,
            preflightRoot,
            signal: controller.signal,
          },
          requestedThrough
        )
      } catch (error) {
        release(input.runId, controller)
        return json({ error: errorMessage(error) }, 400)
      }
      try {
        // The UI redirects as soon as this endpoint returns. Persist the initial
        // checkpoint first so the run-detail route is immediately inspectable.
        await store.createOrLoad(config)
      } catch (error) {
        release(input.runId, controller)
        return json({ error: errorMessage(error) }, 500)
      }
      try {
        await appendControlEvent(input.runId, {
          action: "start",
          at: new Date(now()).toISOString(),
          through: requestedThrough,
          provider: config.provider,
          forceBuild: input.forceBuild,
          freshQuery: input.freshQuery || input.forceBuild,
        })
      } catch (error) {
        try {
          const checkpoint = await store.load()
          await store.fail(checkpoint, error)
        } catch {
          // Preserve the original control-history error in the response.
        }
        release(input.runId, controller)
        return json({ error: errorMessage(error) }, 500)
      }
      broadcast({
        type: "run_started",
        runId: input.runId,
        provider: config.provider,
        benchmark: "longmemeval-v2",
      })
      execute(
        input.runId,
        controller,
        runner,
        {
          through: requestedThrough,
          forceBuild: input.forceBuild,
          freshQuery: input.freshQuery || input.forceBuild,
        },
        requestedThrough
      )
      return json(
        {
          message: "Run started",
          runId: input.runId,
          statusUrl: `/api/runs-v2/${encodeURIComponent(input.runId)}/status`,
          runUrl: `/api/runs/${encodeURIComponent(input.runId)}`,
        },
        202
      )
    }

    const resumeMatch = pathname.match(/^\/api\/runs-v2\/([^/]+)\/resume$/)
    if (method === "POST" && resumeMatch) {
      if (!validLocalOrigin(request)) return json({ error: "Origin is not allowed" }, 403)
      const runId = safeDecodeRunId(resumeMatch[1])
      if (!runId) return json({ error: "Invalid run ID" }, 400)
      let input: ResumeInput
      try {
        input = await parseBody(request, resumeSchema)
      } catch (error) {
        return json({ error: errorMessage(error) }, 400)
      }
      if (activeRuns.has(runId) || legacyActive(runId)) {
        return json({ error: "Run is already active" }, 409)
      }
      const controller = new AbortController()
      reserve(runId, controller)
      const store = new BuildAwareRunStore(runId, runsRoot)
      let checkpoint: BuildAwareRunCheckpoint
      try {
        checkpoint = await store.load()
      } catch {
        release(runId, controller)
        return json({ error: "Run not found" }, 404)
      }
      const control = await readControlHistory(runId)
      const priorTarget = [...control.events]
        .reverse()
        .find(
          (event) =>
            (event.action === "start" || event.action === "resume") && event.through !== undefined
        )?.through
      const requestedThrough = nativeThrough(
        input.runThrough ?? priorTarget ?? checkpoint.currentStage
      )
      if (
        checkpoint.config.mode === "one-trajectory-canary" &&
        !["plan", "build", "query"].includes(requestedThrough)
      ) {
        release(runId, controller)
        return json({ error: "Canary may only plan, build, or query" }, 400)
      }
      const stageOrder: LongMemEvalV2RunThrough[] = [
        "plan",
        "build",
        "query",
        "read",
        "evaluate",
        "report",
      ]
      if (checkpoint.status === "completed" && checkpoint.currentStage === "report") {
        release(runId, controller)
        return json({ error: "Completed report runs cannot be resumed" }, 409)
      }
      if (stageOrder.indexOf(requestedThrough) < stageOrder.indexOf(checkpoint.currentStage)) {
        release(runId, controller)
        return json(
          {
            error: `Resume target ${requestedThrough} cannot be earlier than checkpoint stage ${checkpoint.currentStage}`,
          },
          400
        )
      }
      if (
        checkpoint.status === "completed" &&
        stageOrder.indexOf(requestedThrough) === stageOrder.indexOf(checkpoint.currentStage)
      ) {
        release(runId, controller)
        return json({ error: `Stage ${checkpoint.currentStage} is already completed` }, 409)
      }
      const fullScope =
        checkpoint.config.questionIds === undefined &&
        checkpoint.config.limit === undefined &&
        checkpoint.config.perCategory === undefined &&
        checkpoint.config.haystackLimit === undefined
      if (fullScope && requestedThrough !== "plan" && !input.allowFullRun) {
        release(runId, controller)
        return json(
          {
            error:
              "allowFullRun must be true to resume or continue a complete-tier selection beyond Plan",
          },
          400
        )
      }
      let runner: RunnerLike
      try {
        runner = await createRunner(
          {
            runId,
            config: checkpoint.config,
            runRoot: runsRoot,
            buildRoot: buildsRoot,
            cacheRoot: artifactsRoot,
            preflightRoot,
            signal: controller.signal,
          },
          requestedThrough
        )
      } catch (error) {
        release(runId, controller)
        return json({ error: errorMessage(error) }, 400)
      }
      try {
        await appendControlEvent(runId, {
          action: "resume",
          at: new Date(now()).toISOString(),
          through: requestedThrough,
          provider: checkpoint.config.provider,
          forceBuild: input.forceBuild,
          freshQuery: input.freshQuery || input.forceBuild,
        })
      } catch (error) {
        release(runId, controller)
        return json({ error: errorMessage(error) }, 500)
      }
      broadcast({
        type: "run_started",
        runId,
        provider: checkpoint.config.provider,
        benchmark: "longmemeval-v2",
        resumed: true,
      })
      execute(
        runId,
        controller,
        runner,
        {
          through: requestedThrough,
          forceBuild: input.forceBuild,
          freshQuery: input.freshQuery || input.forceBuild,
        },
        requestedThrough
      )
      return json(
        {
          message: "Run resumed",
          runId,
          statusUrl: `/api/runs-v2/${encodeURIComponent(runId)}/status`,
          runUrl: `/api/runs/${encodeURIComponent(runId)}`,
        },
        202
      )
    }

    const stopMatch = pathname.match(/^\/api\/runs-v2\/([^/]+)\/stop$/)
    if (method === "POST" && stopMatch) {
      if (!validLocalOrigin(request)) return json({ error: "Origin is not allowed" }, 403)
      try {
        await parseOptionalEmptyBody(request)
      } catch (error) {
        return json({ error: errorMessage(error) }, 400)
      }
      const runId = safeDecodeRunId(stopMatch[1])
      if (!runId) return json({ error: "Invalid run ID" }, 400)
      const active = activeRuns.get(runId)
      if (!active) return json({ error: "Run is not active" }, 404)
      active.status = "stopping"
      requestSharedStop(runId)
      await appendControlEvent(runId, {
        action: "stop-request",
        at: new Date(now()).toISOString(),
      })
      broadcast({ type: "run_stopping", runId })
      return json({ message: "Stop requested", runId }, 202)
    }

    const statusMatch = pathname.match(/^\/api\/runs-v2\/([^/]+)\/status$/)
    if (method === "GET" && statusMatch) {
      const runId = safeDecodeRunId(statusMatch[1])
      if (!runId) return json({ error: "Invalid run ID" }, 400)
      const active = activeRuns.get(runId)
      const control = await readControlHistory(runId)
      const uiManaged = control.events.some(
        (event) => event.action === "start" || event.action === "resume"
      )
      const checkpoint = await checkpointStatus(
        new BuildAwareRunStore(runId, runsRoot),
        Boolean(active),
        uiManaged
      )
      if (!active && !checkpoint && control.events.length === 0) {
        return json({ error: "Run not found" }, 404)
      }
      return json({
        runId,
        active: Boolean(active),
        stopping: active?.status === "stopping" || active?.controller.signal.aborted === true,
        checkpoint,
        control,
      })
    }

    return null
  }
}
