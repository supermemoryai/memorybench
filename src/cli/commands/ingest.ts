import type { ProviderName } from "../../types/provider"
import type { BenchmarkName } from "../../types/benchmark"
import type { ConcurrencyConfig } from "../../types/concurrency"
import { orchestrator, CheckpointManager } from "../../orchestrator"
import { getAvailableProviders } from "../../providers"
import { getAvailableBenchmarks } from "../../benchmarks"
import { logger } from "../../utils/logger"

interface IngestArgs {
  provider?: string
  benchmark?: string
  runId: string
  force?: boolean
  dataPath?: string
  datasetRevision?: string
  retrievalTopK?: number
  judgeModel?: string
  answeringModel?: string
  concurrency?: ConcurrencyConfig
  ingestBatchSize?: number
  ingestReadinessTimeoutMs?: number
}

function generateRunId(): string {
  const now = new Date()
  const date = now.toISOString().slice(0, 10).replace(/-/g, "")
  const time = now.toISOString().slice(11, 19).replace(/:/g, "")
  return `run-${date}-${time}`
}

export function parseIngestArgs(args: string[]): IngestArgs | null {
  const parsed: Partial<IngestArgs> = {}
  const concurrency: Partial<ConcurrencyConfig> = {}

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
    } else if (arg === "--data-path") {
      parsed.dataPath = args[++i]
    } else if (arg === "--dataset-revision") {
      parsed.datasetRevision = args[++i]
    } else if (arg === "--top-k" || arg === "--retrieval-top-k") {
      parsed.retrievalTopK = parseInt(args[++i], 10)
    } else if (arg === "--concurrency") {
      concurrency.default = parseInt(args[++i], 10)
    } else if (arg === "--concurrency-ingest") {
      concurrency.ingest = parseInt(args[++i], 10)
    } else if (arg === "--concurrency-indexing") {
      concurrency.indexing = parseInt(args[++i], 10)
    } else if (arg === "--ingest-batch-size") {
      const value = Number(args[++i])
      if (!Number.isInteger(value) || value < 1 || value > 600) {
        throw new Error("--ingest-batch-size must be an integer between 1 and 600")
      }
      parsed.ingestBatchSize = value
    } else if (arg === "--ingest-timeout-seconds") {
      const value = Number(args[++i])
      if (!Number.isInteger(value) || value < 1) {
        throw new Error("--ingest-timeout-seconds must be a positive integer")
      }
      parsed.ingestReadinessTimeoutMs = value * 1000
    }
  }

  // Either runId alone (for continuation) or provider+benchmark (for new run)
  if (!parsed.runId && (!parsed.provider || !parsed.benchmark)) {
    return null
  }

  if (!parsed.runId) {
    parsed.runId = generateRunId()
  }

  if (Object.keys(concurrency).length > 0) {
    parsed.concurrency = concurrency as ConcurrencyConfig
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
    console.log("  --data-path PATH       Prepared dataset snapshot root")
    console.log("  --dataset-revision ID  Expected dataset fingerprint")
    console.log("  --concurrency N         Concurrency for conversation builds")
    console.log("  --concurrency-ingest N  Concurrency for document submission")
    console.log("  --concurrency-indexing N  Concurrency for readiness polling")
    console.log("  --ingest-batch-size N     Ordered sessions per provider batch (1-600)")
    console.log("  --ingest-timeout-seconds N  Per-readiness-call timeout (default: 300)")
    console.log(
      "  --retrieval-top-k K    Retrieval configuration recorded in the run protocol identity"
    )
    console.log("  --top-k N              Benchmark retrieval Top-K")
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
    parsed.dataPath = parsed.dataPath || checkpoint.dataPath
    parsed.datasetRevision = parsed.datasetRevision || checkpoint.datasetRevision
    parsed.retrievalTopK = parsed.retrievalTopK ?? checkpoint.retrievalTopK
    parsed.judgeModel = checkpoint.judge
    parsed.answeringModel = checkpoint.answeringModel
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
    dataPath: parsed.dataPath,
    datasetRevision: parsed.datasetRevision,
    retrievalTopK: parsed.retrievalTopK,
    judgeModel: parsed.judgeModel,
    answeringModel: parsed.answeringModel,
    concurrency: parsed.concurrency,
    ingestBatchSize: parsed.ingestBatchSize,
    ingestReadinessTimeoutMs: parsed.ingestReadinessTimeoutMs,
  })
}
