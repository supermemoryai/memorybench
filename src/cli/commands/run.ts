import type { ProviderName } from "../../types/provider"
import type { BenchmarkName } from "../../types/benchmark"
import type { PhaseId, SamplingConfig, SampleType } from "../../types/checkpoint"
import type { ConcurrencyConfig } from "../../types/concurrency"
import { PHASE_ORDER, getPhasesFromPhase } from "../../types/checkpoint"
import { orchestrator, CheckpointManager } from "../../orchestrator"
import { getAvailableProviders } from "../../providers"
import { getAvailableBenchmarks } from "../../benchmarks"
import { listAvailableModels, DEFAULT_ANSWERING_MODEL } from "../../utils/models"
import { logger } from "../../utils/logger"

const DEFAULT_JUDGE_MODEL = "gpt-4o"

interface RunArgs {
  provider?: string
  benchmark?: string
  judgeModel?: string
  runId: string
  answeringModel?: string
  limit?: number
  sample?: number
  sampleType?: SampleType
  force?: boolean
  fromPhase?: PhaseId
  concurrency?: ConcurrencyConfig
}

function generateRunId(): string {
  const now = new Date()
  const date = now.toISOString().slice(0, 10).replace(/-/g, "")
  const time = now.toISOString().slice(11, 19).replace(/:/g, "")
  return `run-${date}-${time}`
}

export function parseRunArgs(args: string[]): RunArgs | null {
  const parsed: Partial<RunArgs> = {}
  const concurrency: Partial<ConcurrencyConfig> = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "-p" || arg === "--provider") {
      parsed.provider = args[++i]
    } else if (arg === "-b" || arg === "--benchmark") {
      parsed.benchmark = args[++i]
    } else if (arg === "-j" || arg === "--judge") {
      parsed.judgeModel = args[++i]
    } else if (arg === "-r" || arg === "--run-id") {
      parsed.runId = args[++i]
    } else if (arg === "-m" || arg === "--answering-model") {
      parsed.answeringModel = args[++i]
    } else if (arg === "-l" || arg === "--limit") {
      parsed.limit = parseInt(args[++i], 10)
    } else if (arg === "-s" || arg === "--sample") {
      parsed.sample = parseInt(args[++i], 10)
    } else if (arg === "--sample-type") {
      const type = args[++i] as SampleType
      if (type === "consecutive" || type === "random") {
        parsed.sampleType = type
      } else {
        logger.error(`Invalid sample type: ${type}. Valid types: consecutive, random`)
        return null
      }
    } else if (arg === "-f" || arg === "--from-phase") {
      const phase = args[++i] as PhaseId
      if (PHASE_ORDER.includes(phase)) {
        parsed.fromPhase = phase
      } else {
        logger.error(`Invalid phase: ${phase}. Valid phases: ${PHASE_ORDER.join(", ")}`)
        return null
      }
    } else if (arg === "--concurrency") {
      concurrency.default = parseInt(args[++i], 10)
    } else if (arg === "--concurrency-ingest") {
      concurrency.ingest = parseInt(args[++i], 10)
    } else if (arg === "--concurrency-indexing") {
      concurrency.indexing = parseInt(args[++i], 10)
    } else if (arg === "--concurrency-search") {
      concurrency.search = parseInt(args[++i], 10)
    } else if (arg === "--concurrency-answer") {
      concurrency.answer = parseInt(args[++i], 10)
    } else if (arg === "--concurrency-evaluate") {
      concurrency.evaluate = parseInt(args[++i], 10)
    } else if (arg === "--force") {
      parsed.force = true
    }
  }

  if (!parsed.runId && (!parsed.provider || !parsed.benchmark)) {
    return null
  }

  if (!parsed.runId) {
    parsed.runId = generateRunId()
  }

  if (Object.keys(concurrency).length > 0) {
    parsed.concurrency = concurrency as ConcurrencyConfig
  }

  return parsed as RunArgs
}

export async function runCommand(args: string[]): Promise<void> {
  const parsed = parseRunArgs(args)

  if (!parsed) {
    console.log("Usage:")
    console.log(
      "  New run:        bun run src/index.ts run -p <provider> -b <benchmark> [-r <runId>] [-j <judge>] [-m <model>] [-s <n>] [-l <limit>] [--force]"
    )
    console.log("  Continue run:   bun run src/index.ts run -r <runId> [-j <judge>] [-m <model>]")
    console.log("  From phase:     bun run src/index.ts run -r <runId> -f <phase>")
    console.log("")
    console.log("Options:")
    console.log(`  -p, --provider         Memory provider: ${getAvailableProviders().join(", ")}`)
    console.log(`  -b, --benchmark        Benchmark: ${getAvailableBenchmarks().join(", ")}`)
    console.log(`  -j, --judge            Judge model (default: ${DEFAULT_JUDGE_MODEL})`)
    console.log(
      "  -r, --run-id           Run identifier (required for continuation, auto-generated for new runs)"
    )
    console.log(`  -m, --answering-model  Answering model (default: ${DEFAULT_ANSWERING_MODEL})`)
    console.log("  -s, --sample           Sample N questions per category")
    console.log("  --sample-type          Sample type: consecutive (default), random")
    console.log("  -l, --limit            Limit total number of questions to process")
    console.log(`  -f, --from-phase       Start from phase: ${PHASE_ORDER.join(", ")}`)
    console.log("  --concurrency N        Default concurrency for all phases")
    console.log("  --concurrency-ingest N    Concurrency for ingest phase")
    console.log("  --concurrency-indexing N  Concurrency for indexing phase")
    console.log("  --concurrency-search N    Concurrency for search phase")
    console.log("  --concurrency-answer N    Concurrency for answer phase")
    console.log("  --concurrency-evaluate N  Concurrency for evaluate phase")
    console.log("  --force                Clear existing checkpoint and start fresh")
    console.log("")
    console.log(`Available models: ${listAvailableModels().join(", ")}`)
    return
  }

  const checkpointManager = new CheckpointManager()

  // Check if run exists
  if (checkpointManager.exists(parsed.runId)) {
    const checkpoint = checkpointManager.load(parsed.runId)!

    // If provider/benchmark provided, validate they match
    if (parsed.provider && parsed.provider !== checkpoint.provider) {
      logger.error(
        `Run ${parsed.runId} exists with provider ${checkpoint.provider}, not ${parsed.provider}`
      )
      return
    }
    if (parsed.benchmark && parsed.benchmark !== checkpoint.benchmark) {
      logger.error(
        `Run ${parsed.runId} exists with benchmark ${checkpoint.benchmark}, not ${parsed.benchmark}`
      )
      return
    }

    // Use stored values
    parsed.provider = checkpoint.provider
    parsed.benchmark = checkpoint.benchmark
    parsed.judgeModel = parsed.judgeModel || checkpoint.judge
    parsed.answeringModel = parsed.answeringModel || checkpoint.answeringModel

    logger.info(`Continuing run ${parsed.runId} (${checkpoint.provider}/${checkpoint.benchmark})`)
  } else {
    // New run - provider and benchmark required
    if (!parsed.provider || !parsed.benchmark) {
      logger.error("New run requires -p/--provider and -b/--benchmark")
      return
    }

    if (!getAvailableProviders().includes(parsed.provider as ProviderName)) {
      console.error(`Invalid provider: ${parsed.provider}`)
      return
    }

    if (!getAvailableBenchmarks().includes(parsed.benchmark as BenchmarkName)) {
      console.error(`Invalid benchmark: ${parsed.benchmark}`)
      return
    }

    // Apply defaults for new run
    parsed.judgeModel = parsed.judgeModel || DEFAULT_JUDGE_MODEL
  }

  const phases = parsed.fromPhase ? getPhasesFromPhase(parsed.fromPhase) : undefined

  let sampling: SamplingConfig | undefined
  if (parsed.sample) {
    sampling = {
      mode: "sample",
      sampleType: parsed.sampleType || "consecutive",
      perCategory: parsed.sample,
    }
  } else if (parsed.limit) {
    sampling = {
      mode: "limit",
      limit: parsed.limit,
    }
  }

  await orchestrator.run({
    provider: parsed.provider as ProviderName,
    benchmark: parsed.benchmark as BenchmarkName,
    judgeModel: parsed.judgeModel!,
    runId: parsed.runId,
    answeringModel: parsed.answeringModel,
    sampling,
    concurrency: parsed.concurrency,
    force: parsed.force,
    phases,
  })
}
