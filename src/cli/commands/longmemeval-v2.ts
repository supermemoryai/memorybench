import { resolve } from "node:path"
import { atomicWriteJson } from "../../core/canonical"
import {
  LongMemEvalV2Runner,
  inspectLongMemEvalV2Run,
  type LongMemEvalV2RunThrough,
} from "../../orchestrator/longmemeval-v2"
import { BuildAwareRunStore } from "../../orchestrator/build-aware-run-store"
import {
  AdvancedSupermemoryProvider,
  supermemoryPreflightGatePath,
} from "../../providers/supermemory/advanced"
import type { BuildAwareRunConfig } from "../../types/build-aware"
import { downloadLongMemEvalV2Dataset } from "../../benchmarks/longmemeval-v2/download"
import {
  prepareLongMemEvalV2Screenshots,
  type ScreenshotPreparationMode,
} from "../../benchmarks/longmemeval-v2/prepare"

const PINNED_DATASET_REVISION = "f152293e235517d504809563c833d7190b8c713b"

type Action =
  | "download"
  | "prepare"
  | "preflight"
  | "dry-run"
  | "canary"
  | "build"
  | "query"
  | "evaluate"
  | "run"
  | "resume"
  | "inspect"

interface ParsedArgs {
  action: Action
  runId?: string
  datasetPath: string
  revision: string
  tier: "small" | "medium"
  allowMedium: boolean
  domain: "web" | "enterprise" | "all"
  questionIds?: string[]
  limit?: number
  perCategory?: number
  seed: string
  topK: number
  evidenceTopK: number
  threshold: number
  readerModel: string
  evaluatorModel: string
  reasoningEffort: BuildAwareRunConfig["reader"]["reasoningEffort"]
  evaluatorReasoningEffort: string
  questionConcurrency: number
  buildConcurrency: number
  trajectoryConcurrency: number
  maxInFlightRequests: number
  maxTrajectoryAttempts: number
  indexingTimeoutMs: number
  serviceBaseUrl: string
  forceBuild: boolean
  freshQuery: boolean
  keepPreflightDocuments: boolean
  prepareMode: ScreenshotPreparationMode
  preflightReadinessTimeoutMs: number
  preflightSearchTimeoutMs: number
  preflightPollMs: number
  preflightMaxAgeMs: number
  continueOnIndexingTimeout: boolean
}

function help(): void {
  console.log(`
LongMemEval-V2 build-aware workflow

Usage:
  bun run src/index.ts lme-v2 <action> [options]

Actions:
  download   Download the exact pinned snapshot atomically and verify checksums
  prepare    Safely extract archives and build the common screenshots view
  preflight  Probe the live Supermemory V3/V4 service contract and clean probes
  dry-run    Validate dataset, selection, assets, conversion, and build plans
  canary     Build and query exactly one trajectory (not an official score)
  build      Create or resume reusable Memory Builds
  query      Build if needed, then retrieve with immutable artifacts
  evaluate   Build, query, read with GPT-5, and run official evaluation
  run        Execute the complete official pipeline and report
  resume     Resume an existing run from its durable checkpoints
  inspect    Print an existing checkpoint/report without network calls

Important options:
  -r, --run-id ID              Stable run identifier
  --dataset PATH               Prepared dataset root
  --revision SHA               Exact dataset revision
  --tier small|medium          Medium additionally requires --allow-medium
  --domain web|enterprise|all
  --question-id ID[,ID...]     Exact question selection
  --limit N                    Deterministic prefix selection
  --per-category N             Deterministic category sample
  --seed VALUE                 Replayable sample seed
  --top-k N                    Authoritative retrieval top-K
  --evidence-top-k N           Reader evidence limit (must be <= top-K)
  --reader-model MODEL         Default: gpt-5
  --reasoning-effort LEVEL     Default: high
  --evaluator-model MODEL      Default: gpt-5
  --force-build                Explicitly clear the exact build before rebuilding
  --fresh-query                Bypass query cache, retaining immutable old artifacts
  --max-trajectory-attempts N  Finite non-timeout retries per trajectory (default: 4)
  --indexing-timeout-ms N      Hard per-trajectory readiness deadline (default: 1800000)
  --preflight-readiness-ms N   Live readiness deadline (default: 300000)
  --preflight-search-ms N      Live search deadline (default: 120000)
  --preflight-max-age-hours N  Maximum accepted gate age (default: 24)
  --strict-ingestion           Fail instead of skipping documents that exceed the indexing deadline
`)
}

function positiveInteger(raw: string | undefined, flag: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) throw new Error(`${flag} requires an integer >= 1`)
  return value
}

function finiteNumber(raw: string | undefined, flag: string): number {
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`${flag} requires a finite number`)
  return value
}

function generateRunId(action: Action): string {
  return `lme-v2-${action}-${new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14)}`
}

function parse(args: string[]): ParsedArgs | null {
  if (args.length === 0 || ["help", "--help", "-h"].includes(args[0])) return null
  const action = args[0] as Action
  if (
    ![
      "preflight",
      "download",
      "prepare",
      "dry-run",
      "canary",
      "build",
      "query",
      "evaluate",
      "run",
      "resume",
      "inspect",
    ].includes(action)
  ) {
    throw new Error(`Unknown lme-v2 action: ${args[0]}`)
  }
  const parsed: ParsedArgs = {
    action,
    datasetPath: "data/benchmarks/longmemeval-v2",
    revision: PINNED_DATASET_REVISION,
    tier: "small",
    allowMedium: false,
    domain: "all",
    seed: "memorybench-longmemeval-v2",
    topK: 20,
    evidenceTopK: 20,
    threshold: 0,
    readerModel: "gpt-5",
    evaluatorModel: "gpt-5",
    reasoningEffort: "high",
    evaluatorReasoningEffort: "high",
    questionConcurrency: 5,
    buildConcurrency: 2,
    trajectoryConcurrency: 4,
    maxInFlightRequests: 20,
    maxTrajectoryAttempts: 4,
    indexingTimeoutMs: 30 * 60_000,
    serviceBaseUrl: "https://api.supermemory.ai",
    forceBuild: false,
    freshQuery: false,
    keepPreflightDocuments: false,
    prepareMode: "symlink",
    preflightReadinessTimeoutMs: 300_000,
    preflightSearchTimeoutMs: 120_000,
    preflightPollMs: 5_000,
    preflightMaxAgeMs: 24 * 60 * 60_000,
    continueOnIndexingTimeout: true,
  }
  const questionIds: string[] = []
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index]
    const next = () => {
      const value = args[++index]
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`)
      return value
    }
    if (flag === "-r" || flag === "--run-id") parsed.runId = next()
    else if (flag === "--dataset") parsed.datasetPath = next()
    else if (flag === "--revision") parsed.revision = next()
    else if (flag === "--tier") {
      const value = next()
      if (value !== "small" && value !== "medium") throw new Error("Invalid --tier")
      parsed.tier = value
    } else if (flag === "--allow-medium") parsed.allowMedium = true
    else if (flag === "--domain") {
      const value = next()
      if (!["web", "enterprise", "all"].includes(value)) throw new Error("Invalid --domain")
      parsed.domain = value as ParsedArgs["domain"]
    } else if (flag === "--question-id") {
      questionIds.push(
        ...next()
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      )
    } else if (flag === "--limit") parsed.limit = positiveInteger(next(), flag)
    else if (flag === "--per-category") parsed.perCategory = positiveInteger(next(), flag)
    else if (flag === "--seed") parsed.seed = next()
    else if (flag === "--top-k") parsed.topK = positiveInteger(next(), flag)
    else if (flag === "--evidence-top-k") parsed.evidenceTopK = positiveInteger(next(), flag)
    else if (flag === "--threshold") parsed.threshold = finiteNumber(next(), flag)
    else if (flag === "--reader-model") parsed.readerModel = next()
    else if (flag === "--evaluator-model") parsed.evaluatorModel = next()
    else if (flag === "--reasoning-effort") {
      const value = next()
      if (!["none", "minimal", "low", "medium", "high", "xhigh"].includes(value)) {
        throw new Error("Invalid --reasoning-effort")
      }
      parsed.reasoningEffort = value as ParsedArgs["reasoningEffort"]
    } else if (flag === "--evaluator-reasoning-effort") {
      parsed.evaluatorReasoningEffort = next()
    } else if (flag === "--question-concurrency") {
      parsed.questionConcurrency = positiveInteger(next(), flag)
    } else if (flag === "--build-concurrency") {
      parsed.buildConcurrency = positiveInteger(next(), flag)
    } else if (flag === "--trajectory-concurrency") {
      parsed.trajectoryConcurrency = positiveInteger(next(), flag)
    } else if (flag === "--max-in-flight-requests") {
      parsed.maxInFlightRequests = positiveInteger(next(), flag)
    } else if (flag === "--max-trajectory-attempts") {
      parsed.maxTrajectoryAttempts = positiveInteger(next(), flag)
    } else if (flag === "--indexing-timeout-ms") {
      parsed.indexingTimeoutMs = positiveInteger(next(), flag)
    } else if (flag === "--base-url") parsed.serviceBaseUrl = next()
    else if (flag === "--force-build") parsed.forceBuild = true
    else if (flag === "--fresh-query") parsed.freshQuery = true
    else if (flag === "--keep-preflight-documents") parsed.keepPreflightDocuments = true
    else if (flag === "--prepare-mode") {
      const value = next()
      if (value !== "symlink" && value !== "copy") {
        throw new Error("--prepare-mode must be symlink or copy")
      }
      parsed.prepareMode = value
    } else if (flag === "--preflight-readiness-ms") {
      parsed.preflightReadinessTimeoutMs = positiveInteger(next(), flag)
    } else if (flag === "--preflight-search-ms") {
      parsed.preflightSearchTimeoutMs = positiveInteger(next(), flag)
    } else if (flag === "--preflight-poll-ms") {
      parsed.preflightPollMs = positiveInteger(next(), flag)
    } else if (flag === "--preflight-max-age-hours") {
      const hours = finiteNumber(next(), flag)
      if (hours <= 0) throw new Error(`${flag} requires a number > 0`)
      parsed.preflightMaxAgeMs = hours * 60 * 60_000
    } else if (flag === "--strict-ingestion") parsed.continueOnIndexingTimeout = false
    else throw new Error(`Unknown option: ${flag}`)
  }
  if (questionIds.length > 0) parsed.questionIds = [...new Set(questionIds)]
  if (parsed.tier === "medium" && !parsed.allowMedium) {
    throw new Error("Medium is an explicit high-cost tier; pass --allow-medium")
  }
  if (parsed.action === "canary" && parsed.questionIds?.length !== 1) {
    throw new Error("Canary requires exactly one --question-id")
  }
  if (["resume", "inspect"].includes(parsed.action) && !parsed.runId) {
    throw new Error(`${parsed.action} requires --run-id`)
  }
  return parsed
}

function configFrom(parsed: ParsedArgs): BuildAwareRunConfig {
  return {
    provider: "supermemory",
    benchmark: "longmemeval-v2",
    mode: parsed.action === "canary" ? "one-trajectory-canary" : "benchmark",
    datasetPath: resolve(parsed.datasetPath),
    datasetRevision: parsed.revision,
    tier: parsed.tier,
    domain: parsed.domain,
    questionIds: parsed.questionIds,
    limit: parsed.limit,
    perCategory: parsed.perCategory,
    seed: parsed.seed,
    retrieval: {
      topK: parsed.topK,
      threshold: parsed.threshold,
      searchMode: "hybrid",
      rerank: true,
      rewriteQuery: false,
      includeSummaries: true,
      includeChunks: true,
      includeDocuments: true,
      includeRelatedMemories: true,
      metadataFilter: {},
    },
    reader: {
      model: parsed.readerModel,
      reasoningEffort: parsed.reasoningEffort,
      maxCompletionTokens: 20_000,
      maxContextTokens: 200_000,
      evidenceTopK: parsed.evidenceTopK,
      maxImages: 100,
      maxImageBytes: 20 * 1024 * 1024,
      malformedResponseAttempts: 3,
    },
    evaluator: {
      model: parsed.evaluatorModel,
      reasoningEffort: parsed.evaluatorReasoningEffort,
      maxCompletionTokens: 4096,
    },
    build: {
      serviceBaseUrl: parsed.serviceBaseUrl,
      dreaming: "instant",
      rootFilterMode: "self",
      maxDocumentChars: 200_000,
      trajectoryConcurrency: parsed.trajectoryConcurrency,
      maxInFlightRequests: parsed.maxInFlightRequests,
      maxTrajectoryAttempts: parsed.maxTrajectoryAttempts,
      indexingTimeoutMs: parsed.indexingTimeoutMs,
      pollIntervalMs: 2_000,
      preflightMaxAgeMs: parsed.preflightMaxAgeMs,
      continueOnIndexingTimeout: parsed.continueOnIndexingTimeout,
    },
    execution: {
      buildConcurrency: parsed.buildConcurrency,
      questionConcurrency: parsed.questionConcurrency,
    },
  }
}

function throughFor(action: Action): LongMemEvalV2RunThrough {
  if (action === "dry-run") return "plan"
  if (action === "build") return "build"
  if (action === "query" || action === "canary") return "query"
  if (action === "evaluate") return "evaluate"
  return "report"
}

export async function longMemEvalV2Command(args: string[]): Promise<void> {
  const parsed = parse(args)
  if (!parsed) {
    help()
    return
  }
  if (parsed.action === "inspect") {
    console.log(JSON.stringify(await inspectLongMemEvalV2Run(parsed.runId!), null, 2))
    return
  }
  if (parsed.action === "download") {
    console.log(
      JSON.stringify(await downloadLongMemEvalV2Dataset({ dataRoot: parsed.datasetPath }), null, 2)
    )
    return
  }
  if (parsed.action === "prepare") {
    console.log(
      JSON.stringify(
        await prepareLongMemEvalV2Screenshots({
          dataRoot: parsed.datasetPath,
          mode: parsed.prepareMode,
        }),
        null,
        2
      )
    )
    return
  }
  if (parsed.action === "preflight") {
    const apiKey = process.env.SUPERMEMORY_API_KEY
    if (!apiKey) throw new Error("SUPERMEMORY_API_KEY is required for preflight")
    const provider = new AdvancedSupermemoryProvider({
      apiKey,
      baseUrl: parsed.serviceBaseUrl,
      maxInFlightRequests: parsed.maxInFlightRequests,
    })
    const report = await provider.preflight({
      searchTopK: parsed.topK,
      keepDocuments: parsed.keepPreflightDocuments,
      readinessTimeoutMs: parsed.preflightReadinessTimeoutMs,
      searchVisibilityTimeoutMs: parsed.preflightSearchTimeoutMs,
      searchPollMs: parsed.preflightPollMs,
      onCheck: (check) => {
        console.error(`[preflight] ${check.ok ? "PASS" : "FAIL"} ${check.check}`)
      },
    })
    if (parsed.runId) {
      const store = new BuildAwareRunStore(parsed.runId)
      await atomicWriteJson(resolve(store.runRoot, "preflight.json"), report)
    }
    console.log(
      JSON.stringify(
        {
          allPassed: report.allPassed,
          blockers: report.blockers,
          checks: report.checks,
          cleaned: !parsed.keepPreflightDocuments,
        },
        null,
        2
      )
    )
    if (!report.allPassed) throw new Error("Supermemory preflight failed")
    const gatePath = supermemoryPreflightGatePath("data/preflights-v2", parsed.serviceBaseUrl)
    await atomicWriteJson(gatePath, report)
    console.error(`[preflight] gate written to ${gatePath}`)
    return
  }

  let config: BuildAwareRunConfig
  const runId = parsed.runId ?? generateRunId(parsed.action)
  if (parsed.action === "resume") {
    config = (await new BuildAwareRunStore(runId).load()).config
  } else {
    config = configFrom(parsed)
  }
  const runner = new LongMemEvalV2Runner({ runId, config })
  const checkpoint = await runner.execute({
    through: parsed.action === "resume" ? "report" : throughFor(parsed.action),
    forceBuild: parsed.forceBuild,
    freshQuery: parsed.freshQuery,
  })
  console.log(
    JSON.stringify(
      {
        runId: checkpoint.runId,
        mode: checkpoint.config.mode,
        status: checkpoint.status,
        currentStage: checkpoint.currentStage,
        datasetFingerprint: checkpoint.datasetFingerprint,
        buildIds: checkpoint.buildIds,
        questionCount: checkpoint.targetQuestionIds.length,
        checkpointPath: runner.runStore.checkpointPath,
      },
      null,
      2
    )
  )
}
