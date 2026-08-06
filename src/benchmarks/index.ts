import type { Benchmark, BenchmarkName } from "../types/benchmark"
import { LoCoMoBenchmark } from "./locomo"
import { LongMemEvalBenchmark } from "./longmemeval"
import { ConvoMemBenchmark } from "./convomem"
import { Beam1MBenchmark, Beam10MBenchmark, Beam1M10MBenchmark } from "./beam"

const benchmarks: Record<BenchmarkName, new () => Benchmark> = {
  locomo: LoCoMoBenchmark,
  longmemeval: LongMemEvalBenchmark,
  convomem: ConvoMemBenchmark,
  "beam-1m": Beam1MBenchmark,
  "beam-10m": Beam10MBenchmark,
  "beam-1m-10m": Beam1M10MBenchmark,
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

export {
  LoCoMoBenchmark,
  LongMemEvalBenchmark,
  ConvoMemBenchmark,
  Beam1MBenchmark,
  Beam10MBenchmark,
  Beam1M10MBenchmark,
}
