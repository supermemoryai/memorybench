import type { Benchmark, BenchmarkName } from "../types/benchmark"
import { LoCoMoBenchmark } from "./locomo"
import { LongMemEvalBenchmark } from "./longmemeval"
import { ConvoMemBenchmark } from "./convomem"

const benchmarks: Record<BenchmarkName, new () => Benchmark> = {
  locomo: LoCoMoBenchmark,
  longmemeval: LongMemEvalBenchmark,
  convomem: ConvoMemBenchmark,
}

export function createBenchmark(name: BenchmarkName): Benchmark {
  const BenchmarkClass = benchmarks[name]
  if (!BenchmarkClass) {
    throw new Error(`Unknown benchmark: ${name}. Available: ${Object.keys(benchmarks).join(", ")}`)
  }
  return new BenchmarkClass()
}

export function getAvailableBenchmarks(): BenchmarkName[] {
  return Object.keys(benchmarks) as BenchmarkName[]
}

export { LoCoMoBenchmark, LongMemEvalBenchmark, ConvoMemBenchmark }
