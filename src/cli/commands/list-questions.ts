import type { BenchmarkName } from "../../types/benchmark"
import { createBenchmark, getAvailableBenchmarks } from "../../benchmarks"

interface ListQuestionsArgs {
  benchmark: string
  offset: number
  limit: number
  type?: string
}

export function parseListQuestionsArgs(args: string[]): ListQuestionsArgs | null {
  const parsed: Partial<ListQuestionsArgs> = {
    offset: 0,
    limit: 50,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "-b" || arg === "--benchmark") {
      parsed.benchmark = args[++i]
    } else if (arg === "-o" || arg === "--offset") {
      parsed.offset = parseInt(args[++i], 10)
    } else if (arg === "-l" || arg === "--limit") {
      parsed.limit = parseInt(args[++i], 10)
    } else if (arg === "-t" || arg === "--type") {
      parsed.type = args[++i]
    }
  }

  if (!parsed.benchmark) {
    return null
  }

  return parsed as ListQuestionsArgs
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen - 3) + "..."
}

export async function listQuestionsCommand(args: string[]): Promise<void> {
  const parsed = parseListQuestionsArgs(args)

  if (!parsed) {
    console.log(
      "Usage: bun run src/index.ts list-questions -b <benchmark> [-o <offset>] [-l <limit>] [-t <type>]"
    )
    console.log("")
    console.log("Options:")
    console.log(`  -b, --benchmark  Benchmark: ${getAvailableBenchmarks().join(", ")}`)
    console.log("  -o, --offset     Start from question number (default: 0)")
    console.log("  -l, --limit      Number of questions to show (default: 50)")
    console.log("  -t, --type       Filter by question type")
    console.log("")
    console.log("Examples:")
    console.log("  bun run src/index.ts list-questions -b locomo")
    console.log("  bun run src/index.ts list-questions -b locomo -o 50 -l 50")
    console.log("  bun run src/index.ts list-questions -b locomo -t temporal")
    return
  }

  if (!getAvailableBenchmarks().includes(parsed.benchmark as BenchmarkName)) {
    console.error(`Invalid benchmark: ${parsed.benchmark}`)
    console.error(`Available: ${getAvailableBenchmarks().join(", ")}`)
    return
  }

  const benchmark = createBenchmark(parsed.benchmark as BenchmarkName)

  try {
    await benchmark.load()
  } catch (e: any) {
    console.error(`Failed to load benchmark: ${e.message}`)
    return
  }

  let questions = benchmark.getQuestions()
  const totalQuestions = questions.length

  if (parsed.type) {
    questions = questions.filter((q) => q.questionType.includes(parsed.type!.toLowerCase()))
  }

  const filteredTotal = questions.length
  const start = parsed.offset
  const end = Math.min(start + parsed.limit, filteredTotal)
  const pageQuestions = questions.slice(start, end)

  console.log("")
  console.log(`Benchmark: ${parsed.benchmark}`)
  console.log(
    `Total questions: ${totalQuestions}${parsed.type ? ` (${filteredTotal} matching type "${parsed.type}")` : ""}`
  )
  console.log(`Showing: ${start + 1}-${end} of ${filteredTotal}`)
  console.log("")
  console.log("─".repeat(100))
  console.log(`${"ID".padEnd(25)} ${"Type".padEnd(18)} Question`)
  console.log("─".repeat(100))

  for (const q of pageQuestions) {
    const id = q.questionId.padEnd(25)
    const type = q.questionType.padEnd(18)
    const question = truncate(q.question, 50)
    console.log(`${id} ${type} ${question}`)
  }

  console.log("─".repeat(100))
  console.log("")

  if (end < filteredTotal) {
    console.log(
      `Next page: bun run src/index.ts list-questions -b ${parsed.benchmark} -o ${end} -l ${parsed.limit}${parsed.type ? ` -t ${parsed.type}` : ""}`
    )
  }

  console.log("")
  console.log("To test a specific question:")
  console.log(
    `  bun run src/index.ts test -p <provider> -b ${parsed.benchmark} -j <model> -r <run-id> -q <question-id>`
  )
  console.log("")
}
