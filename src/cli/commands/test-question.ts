import type { ProviderName } from "../../types/provider"
import type { BenchmarkName } from "../../types/benchmark"
import { orchestrator, CheckpointManager } from "../../orchestrator"
import { getAvailableProviders } from "../../providers"
import { getAvailableBenchmarks } from "../../benchmarks"
import { listAvailableModels } from "../../utils/models"
import { logger } from "../../utils/logger"

const DEFAULT_JUDGE_MODEL = "gpt-4o"

interface TestArgs {
  provider?: string
  benchmark?: string
  judgeModel?: string
  runId: string
  questionId: string
  answeringModel?: string
}

export function parseTestArgs(args: string[]): TestArgs | null {
  const parsed: Partial<TestArgs> = {}

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
    } else if (arg === "-q" || arg === "--question-id") {
      parsed.questionId = args[++i]
    } else if (arg === "-m" || arg === "--answering-model") {
      parsed.answeringModel = args[++i]
    }
  }

  // runId and questionId are always required
  if (!parsed.runId || !parsed.questionId) {
    return null
  }

  return parsed as TestArgs
}

export async function testQuestionCommand(args: string[]): Promise<void> {
  const parsed = parseTestArgs(args)

  if (!parsed) {
    console.log(
      "Usage: bun run src/index.ts test -r <runId> -q <questionId> [-j <judge-model>] [-m <model>]"
    )
    console.log("")
    console.log("Options:")
    console.log("  -r, --run-id           Run identifier (must have completed ingest phase)")
    console.log("  -q, --question-id      Question ID to test")
    console.log(`  -j, --judge            Judge model (default: ${DEFAULT_JUDGE_MODEL})`)
    console.log("  -m, --answering-model  Answering model (default: gpt-4o)")
    console.log("")
    console.log(`Available models: ${listAvailableModels().join(", ")}`)
    return
  }

  const checkpointManager = new CheckpointManager()

  if (!checkpointManager.exists(parsed.runId)) {
    logger.error(`No run found: ${parsed.runId}`)
    logger.error("Run ingest phase first before testing a question")
    return
  }

  const checkpoint = checkpointManager.load(parsed.runId)!
  parsed.provider = checkpoint.provider
  parsed.benchmark = checkpoint.benchmark
  parsed.judgeModel = parsed.judgeModel || checkpoint.judge || DEFAULT_JUDGE_MODEL
  parsed.answeringModel = parsed.answeringModel || checkpoint.answeringModel

  if (!getAvailableProviders().includes(parsed.provider as ProviderName)) {
    console.error(`Invalid provider in checkpoint: ${parsed.provider}`)
    return
  }

  if (!getAvailableBenchmarks().includes(parsed.benchmark as BenchmarkName)) {
    console.error(`Invalid benchmark in checkpoint: ${parsed.benchmark}`)
    return
  }

  await orchestrator.testQuestion({
    provider: parsed.provider as ProviderName,
    benchmark: parsed.benchmark as BenchmarkName,
    judgeModel: parsed.judgeModel,
    runId: parsed.runId,
    questionId: parsed.questionId,
    answeringModel: parsed.answeringModel,
  })
}
