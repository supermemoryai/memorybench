import type { ProviderName } from "../../types/provider"
import type { BenchmarkName } from "../../types/benchmark"
import type { SamplingConfig, SampleType } from "../../types/checkpoint"
import { batchManager } from "../../orchestrator/batch"
import { getAvailableProviders } from "../../providers"
import { getAvailableBenchmarks } from "../../benchmarks"
import { DEFAULT_ANSWERING_MODEL } from "../../utils/models"
import { logger } from "../../utils/logger"

const DEFAULT_JUDGE_MODEL = "gpt-4o"

interface CompareArgs {
  providers?: string[]
  benchmark?: string
  judgeModel: string
  answeringModel: string
  compareId?: string
  sample?: number
  sampleType?: SampleType
  limit?: number
  force?: boolean
}

export function parseCompareArgs(args: string[]): CompareArgs | null {
  const parsed: Partial<CompareArgs> = {
    judgeModel: DEFAULT_JUDGE_MODEL,
    answeringModel: DEFAULT_ANSWERING_MODEL,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "-p" || arg === "--providers") {
      const providersStr = args[++i]
      parsed.providers = providersStr.split(",").map((p) => p.trim())
    } else if (arg === "-b" || arg === "--benchmark") {
      parsed.benchmark = args[++i]
    } else if (arg === "-j" || arg === "--judge") {
      parsed.judgeModel = args[++i]
    } else if (arg === "-m" || arg === "--answering-model") {
      parsed.answeringModel = args[++i]
    } else if (arg === "--compare-id") {
      parsed.compareId = args[++i]
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
    } else if (arg === "-l" || arg === "--limit") {
      parsed.limit = parseInt(args[++i], 10)
    } else if (arg === "--force") {
      parsed.force = true
    }
  }

  if (!parsed.compareId && (!parsed.providers || !parsed.benchmark)) {
    return null
  }

  return parsed as CompareArgs
}

export async function compareCommand(args: string[]): Promise<void> {
  const parsed = parseCompareArgs(args)

  if (!parsed) {
    console.log("Usage:")
    console.log(
      "  New comparison:    bun run src/index.ts compare -p <providers> -b <benchmark> [options]"
    )
    console.log("  Resume:            bun run src/index.ts compare --compare-id <id>")
    console.log("")
    console.log("Options:")
    console.log(
      `  -p, --providers       Comma-separated providers: ${getAvailableProviders().join(", ")}`
    )
    console.log(`  -b, --benchmark       Benchmark: ${getAvailableBenchmarks().join(", ")}`)
    console.log(`  -j, --judge           Judge model (default: ${DEFAULT_JUDGE_MODEL})`)
    console.log(`  -m, --answering-model Answering model (default: ${DEFAULT_ANSWERING_MODEL})`)
    console.log("  -s, --sample          Sample N questions per category")
    console.log("  --sample-type         Sample type: consecutive (default), random")
    console.log("  -l, --limit           Limit total number of questions")
    console.log("  --compare-id          Compare ID (for resuming)")
    console.log("  --force               Clear existing comparison and start fresh")
    console.log("")
    console.log("Examples:")
    console.log("  bun run src/index.ts compare -p supermemory,mem0,zep -b locomo -s 5")
    console.log("  bun run src/index.ts compare -p supermemory,filesystem,rag -b locomo -s 5")
    console.log("  bun run src/index.ts compare --compare-id compare-20251222-103045")
    return
  }

  try {
    let result

    if (parsed.compareId) {
      result = await batchManager.resume(parsed.compareId, parsed.force)
    } else {
      for (const provider of parsed.providers!) {
        if (!getAvailableProviders().includes(provider as ProviderName)) {
          logger.error(
            `Invalid provider: ${provider}. Available: ${getAvailableProviders().join(", ")}`
          )
          return
        }
      }

      if (!getAvailableBenchmarks().includes(parsed.benchmark as BenchmarkName)) {
        logger.error(
          `Invalid benchmark: ${parsed.benchmark}. Available: ${getAvailableBenchmarks().join(", ")}`
        )
        return
      }

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

      result = await batchManager.compare({
        providers: parsed.providers as ProviderName[],
        benchmark: parsed.benchmark as BenchmarkName,
        judgeModel: parsed.judgeModel,
        answeringModel: parsed.answeringModel,
        sampling,
        force: parsed.force,
      })
    }

    if (result.successes > 0) {
      batchManager.printComparisonReport(result.manifest)
    }
  } catch (error) {
    logger.error(`${error}`)
  }
}
