import { CheckpointManager } from "../../orchestrator/checkpoint"

interface ShowFailuresArgs {
  runId: string
  limit?: number
}

function parseArgs(args: string[]): ShowFailuresArgs | null {
  const parsed: Partial<ShowFailuresArgs> = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "-r" || arg === "--run-id") {
      parsed.runId = args[++i]
    } else if (arg === "-l" || arg === "--limit") {
      parsed.limit = parseInt(args[++i], 10)
    }
  }

  if (!parsed.runId) {
    return null
  }

  return parsed as ShowFailuresArgs
}

export async function showFailuresCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args)

  if (!parsed) {
    console.log("Usage: bun run src/index.ts show-failures -r <runId> [-l <limit>]")
    console.log("")
    console.log("Options:")
    console.log("  -r, --run-id   Run identifier")
    console.log("  -l, --limit    Limit number of failures to show")
    return
  }

  const checkpointManager = new CheckpointManager()
  const checkpoint = checkpointManager.load(parsed.runId)

  if (!checkpoint) {
    console.error(`No run found: ${parsed.runId}`)
    return
  }

  const failures = Object.values(checkpoint.questions).filter(
    (q) => q.phases.evaluate.label === "incorrect"
  )

  if (failures.length === 0) {
    console.log("\nNo failures found!")
    console.log(`All evaluated questions passed for run: ${parsed.runId}`)
    return
  }

  const toShow = parsed.limit ? failures.slice(0, parsed.limit) : failures

  console.log("")
  console.log("=".repeat(80))
  console.log(`FAILURES: ${checkpoint.provider} + ${checkpoint.benchmark} (run: ${parsed.runId})`)
  console.log("=".repeat(80))
  console.log(`Showing ${toShow.length} of ${failures.length} failures`)
  console.log("")

  for (let i = 0; i < toShow.length; i++) {
    const q = toShow[i]
    const searchResults = q.phases.search.results || []

    console.log(`[${i + 1}/${toShow.length}] ${q.questionId}`)
    console.log("-".repeat(80))
    console.log(`Type: ${q.questionType}`)
    console.log(`Question: ${q.question}`)
    console.log(`Ground Truth: ${q.groundTruth}`)
    console.log(`Generated Answer: ${q.phases.answer.hypothesis || "(no answer)"}`)
    console.log(`Judge Verdict: ${q.phases.evaluate.label}`)
    if (q.phases.evaluate.explanation) {
      console.log(`Explanation: ${q.phases.evaluate.explanation}`)
    }

    if (q.phases.search.durationMs || q.phases.answer.durationMs) {
      console.log(
        `Latency: search=${q.phases.search.durationMs || 0}ms, answer=${q.phases.answer.durationMs || 0}ms`
      )
    }
    console.log("")

    if (searchResults.length > 0) {
      console.log(`Search Results (${searchResults.length}):`)
      for (let j = 0; j < Math.min(searchResults.length, 3); j++) {
        const r = searchResults[j] as Record<string, unknown>
        const content = String(r.content || r.text || r.memory || JSON.stringify(r)).slice(0, 100)
        const score = typeof r.score === "number" ? r.score.toFixed(2) : "N/A"
        console.log(`  ${j + 1}. [${score}] "${content}${content.length >= 100 ? "..." : ""}"`)
      }
      if (searchResults.length > 3) {
        console.log(`  ... and ${searchResults.length - 3} more results`)
      }
    } else {
      console.log("Search Results: (none)")
    }

    console.log("-".repeat(80))
    console.log("")
  }
}
