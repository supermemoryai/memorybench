import type { ProviderName } from "../../types/provider"
import type { BenchmarkName } from "../../types/benchmark"
import { orchestrator, CheckpointManager } from "../../orchestrator"
import { getAvailableProviders } from "../../providers"
import { getAvailableBenchmarks } from "../../benchmarks"
import { logger } from "../../utils/logger"

interface IngestArgs {
  provider?: string
  benchmark?: string
  runId: string
  force?: boolean
}

function generateRunId(): string {
  const now = new Date()
  const date = now.toISOString().slice(0, 10).replace(/-/g, "")
  const time = now.toISOString().slice(11, 19).replace(/:/g, "")
  return `run-${date}-${time}`
}

export function parseIngestArgs(args: string[]): IngestArgs | null {
  const parsed: Partial<IngestArgs> = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "-p" || arg === "--provider") {
      parsed.provider = args[++i]
    } else if (arg === "-b" || arg === "--benchmark") {
      parsed.benchmark = args[++i]
    } else if (arg === "-r" || arg === "--run-id") {
      parsed.runId = args[++i]
    } else if (arg === "--force") {
      parsed.force = true
    }
  }

  // Either runId alone (for continuation) or provider+benchmark (for new run)
  if (!parsed.runId && (!parsed.provider || !parsed.benchmark)) {
    return null
  }

  if (!parsed.runId) {
    parsed.runId = generateRunId()
  }

  return parsed as IngestArgs
}

export async function ingestCommand(args: string[]): Promise<void> {
  const parsed = parseIngestArgs(args)

  if (!parsed) {
    console.log("Usage:")
    console.log(
      "  New run:      bun run src/index.ts ingest -p <provider> -b <benchmark> [-r <runId>] [--force]"
    )
    console.log("  Continue run: bun run src/index.ts ingest -r <runId>")
    console.log("")
    console.log("Options:")
    console.log(`  -p, --provider   Provider: ${getAvailableProviders().join(", ")}`)
    console.log(`  -b, --benchmark  Benchmark: ${getAvailableBenchmarks().join(", ")}`)
    console.log("  -r, --run-id     Run identifier")
    console.log("  --force          Clear existing checkpoint and start fresh")
    return
  }

  const checkpointManager = new CheckpointManager()

  if (checkpointManager.exists(parsed.runId)) {
    const checkpoint = checkpointManager.load(parsed.runId)!

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

    parsed.provider = checkpoint.provider
    parsed.benchmark = checkpoint.benchmark
    logger.info(
      `Continuing ingest for ${parsed.runId} (${checkpoint.provider}/${checkpoint.benchmark})`
    )
  } else {
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
  }

  await orchestrator.ingest({
    provider: parsed.provider as ProviderName,
    benchmark: parsed.benchmark as BenchmarkName,
    runId: parsed.runId,
    force: parsed.force,
  })
}
