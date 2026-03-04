import type { ProviderName } from "../../types/provider"
import type { BenchmarkName } from "../../types/benchmark"
import { orchestrator, CheckpointManager } from "../../orchestrator"
import { getAvailableProviders } from "../../providers"
import { getAvailableBenchmarks } from "../../benchmarks"
import { logger } from "../../utils/logger"

interface SearchArgs {
  provider?: string
  benchmark?: string
  runId: string
}

export function parseSearchArgs(args: string[]): SearchArgs | null {
  const parsed: Partial<SearchArgs> = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "-p" || arg === "--provider") {
      parsed.provider = args[++i]
    } else if (arg === "-b" || arg === "--benchmark") {
      parsed.benchmark = args[++i]
    } else if (arg === "-r" || arg === "--run-id") {
      parsed.runId = args[++i]
    }
  }

  // runId is required for search (must have ingested first)
  if (!parsed.runId) {
    return null
  }

  return parsed as SearchArgs
}

export async function searchCommand(args: string[]): Promise<void> {
  const parsed = parseSearchArgs(args)

  if (!parsed) {
    console.log("Usage: bun run src/index.ts search -r <runId>")
    console.log("")
    console.log("Options:")
    console.log("  -r, --run-id   Run identifier (must have completed ingest phase)")
    return
  }

  const checkpointManager = new CheckpointManager()

  if (!checkpointManager.exists(parsed.runId)) {
    logger.error(`No run found: ${parsed.runId}`)
    logger.error("Run ingest phase first before searching")
    return
  }

  const checkpoint = checkpointManager.load(parsed.runId)!
  parsed.provider = checkpoint.provider
  parsed.benchmark = checkpoint.benchmark

  if (!getAvailableProviders().includes(parsed.provider as ProviderName)) {
    console.error(`Invalid provider in checkpoint: ${parsed.provider}`)
    return
  }

  if (!getAvailableBenchmarks().includes(parsed.benchmark as BenchmarkName)) {
    console.error(`Invalid benchmark in checkpoint: ${parsed.benchmark}`)
    return
  }

  await orchestrator.search({
    provider: parsed.provider as ProviderName,
    benchmark: parsed.benchmark as BenchmarkName,
    runId: parsed.runId,
  })
}
