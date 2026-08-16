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
  limit?: number
  trajectoryLimit?: number
  trajectoryDocument?: string
  trajectoryFormat?: string
  containerTag?: string
  questionId?: string
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
    } else if (arg === "-l" || arg === "--limit") {
      parsed.limit = parseInt(args[++i], 10)
    } else if (arg === "--trajectory-limit") {
      parsed.trajectoryLimit = parseInt(args[++i], 10)
    } else if (arg === "--document") {
      parsed.trajectoryDocument = args[++i]
    } else if (arg === "--trajectory-format") {
      parsed.trajectoryFormat = args[++i]
    } else if (arg === "--container-tag") {
      parsed.containerTag = args[++i]
    } else if (arg === "-q" || arg === "--question-id") {
      parsed.questionId = args[++i]
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
      "  New run:      bun run src/index.ts ingest -p <provider> -b <benchmark> [-r <runId>] [-l <limit> | -q <questionId>] [--force]"
    )
    console.log("  Continue run: bun run src/index.ts ingest -r <runId>")
    console.log("")
    console.log("Options:")
    console.log(`  -p, --provider    Provider: ${getAvailableProviders().join(", ")}`)
    console.log(`  -b, --benchmark   Benchmark: ${getAvailableBenchmarks().join(", ")}`)
    console.log("  -r, --run-id      Run identifier")
    console.log("  -l, --limit       Limit number of questions for a new run")
    console.log(
      "  --trajectory-limit Limit ordered trajectories per selected LongMemEval-V2 question"
    )
    console.log("  --document         LongMemEval-V2 document: overview, state:<index>, or result")
    console.log("  --trajectory-format LongMemEval-V2 payload format: raw, clean, or clean-tree")
    console.log("  --container-tag    Explicit provider container tag (requires one question)")
    console.log("  -q, --question-id Ingest a specific question for a new run")
    console.log("  --force           Clear existing checkpoint and start fresh")
    return
  }

  if (parsed.limit && parsed.questionId) {
    logger.error("Use either --limit or --question-id, not both")
    return
  }

  if (
    parsed.trajectoryLimit !== undefined &&
    (!Number.isInteger(parsed.trajectoryLimit) || parsed.trajectoryLimit < 1)
  ) {
    logger.error("--trajectory-limit must be a positive integer")
    return
  }

  if (
    parsed.trajectoryDocument !== undefined &&
    !/^(overview|state:(0|[1-9]\d*)|result)$/.test(parsed.trajectoryDocument)
  ) {
    logger.error("--document must be overview, state:<non-negative index>, or result")
    return
  }

  if (
    parsed.trajectoryFormat !== undefined &&
    !/^(raw|clean|clean-tree)$/.test(parsed.trajectoryFormat)
  ) {
    logger.error("--trajectory-format must be raw, clean, or clean-tree")
    return
  }

  if (parsed.containerTag !== undefined && !parsed.containerTag.trim()) {
    logger.error("--container-tag cannot be empty")
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
    if (
      parsed.trajectoryLimit !== undefined &&
      checkpoint.trajectoryLimit !== undefined &&
      parsed.trajectoryLimit !== checkpoint.trajectoryLimit
    ) {
      logger.error(
        `Run ${parsed.runId} uses trajectory limit ${checkpoint.trajectoryLimit}, not ${parsed.trajectoryLimit}`
      )
      return
    }
    if (
      parsed.trajectoryDocument !== undefined &&
      checkpoint.trajectoryDocument !== undefined &&
      parsed.trajectoryDocument !== checkpoint.trajectoryDocument
    ) {
      logger.error(
        `Run ${parsed.runId} uses trajectory document ${checkpoint.trajectoryDocument}, not ${parsed.trajectoryDocument}`
      )
      return
    }
    if (
      parsed.trajectoryFormat !== undefined &&
      checkpoint.trajectoryFormat !== undefined &&
      parsed.trajectoryFormat !== checkpoint.trajectoryFormat
    ) {
      logger.error(
        `Run ${parsed.runId} uses trajectory format ${checkpoint.trajectoryFormat}, not ${parsed.trajectoryFormat}`
      )
      return
    }
    if (parsed.containerTag !== undefined) {
      const existingTags = new Set(
        Object.values(checkpoint.questions).map((question) => question.containerTag)
      )
      if (existingTags.size > 0 && !existingTags.has(parsed.containerTag)) {
        logger.error(`Run ${parsed.runId} does not use container tag ${parsed.containerTag}`)
        return
      }
    }

    parsed.provider = checkpoint.provider
    parsed.benchmark = checkpoint.benchmark
    parsed.trajectoryLimit = checkpoint.trajectoryLimit ?? parsed.trajectoryLimit
    parsed.trajectoryDocument = checkpoint.trajectoryDocument ?? parsed.trajectoryDocument
    parsed.trajectoryFormat = checkpoint.trajectoryFormat ?? parsed.trajectoryFormat
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

  if (parsed.trajectoryLimit !== undefined && parsed.benchmark !== "longmemeval-v2") {
    logger.error("--trajectory-limit is currently supported only for longmemeval-v2")
    return
  }

  if (parsed.trajectoryDocument !== undefined && parsed.benchmark !== "longmemeval-v2") {
    logger.error("--document is currently supported only for longmemeval-v2")
    return
  }

  if (parsed.trajectoryFormat !== undefined && parsed.benchmark !== "longmemeval-v2") {
    logger.error("--trajectory-format is currently supported only for longmemeval-v2")
    return
  }

  if (
    parsed.containerTag !== undefined &&
    !parsed.questionId &&
    !checkpointManager.exists(parsed.runId)
  ) {
    logger.error("--container-tag requires -q/--question-id for a new run")
    return
  }

  await orchestrator.ingest({
    provider: parsed.provider as ProviderName,
    benchmark: parsed.benchmark as BenchmarkName,
    runId: parsed.runId,
    limit: parsed.limit,
    trajectoryLimit: parsed.trajectoryLimit,
    trajectoryDocument: parsed.trajectoryDocument,
    trajectoryFormat: parsed.trajectoryFormat,
    containerTag: parsed.containerTag,
    questionIds: parsed.questionId ? [parsed.questionId] : undefined,
    force: parsed.force,
  })
}
