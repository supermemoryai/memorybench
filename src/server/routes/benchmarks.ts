import { existsSync } from "fs"
import { join } from "path"
import { getAvailableProviders, getProviderInfo } from "../../providers"
import { getAvailableBenchmarks, createBenchmark } from "../../benchmarks"
import { MODEL_ALIASES, listModelsByProvider } from "../../utils/models"
import { getActiveRunsWithBenchmarks } from "../runState"

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

export async function handleBenchmarksRoutes(req: Request, url: URL): Promise<Response | null> {
  const method = req.method
  const pathname = url.pathname

  // GET /api/providers - List available providers
  if (method === "GET" && pathname === "/api/providers") {
    const providers = getAvailableProviders()
    return json({
      providers: providers.map((name) => getProviderInfo(name)),
    })
  }

  // GET /api/benchmarks - List available benchmarks
  if (method === "GET" && pathname === "/api/benchmarks") {
    const benchmarks = getAvailableBenchmarks()
    return json({
      benchmarks: benchmarks.map((name) => ({
        name,
        displayName: getBenchmarkDisplayName(name),
        description: getBenchmarkDescription(name),
      })),
    })
  }

  // GET /api/downloads - Check for active downloads by observing filesystem
  if (method === "GET" && pathname === "/api/downloads") {
    const benchmarkDatasets: Record<string, { path: string; displayName: string }> = {
      longmemeval: {
        path: "./data/benchmarks/longmemeval/datasets/longmemeval_s_cleaned.json",
        displayName: "LongMemEval",
      },
      locomo: {
        path: "./data/benchmarks/locomo/locomo10.json",
        displayName: "LoCoMo",
      },
      convomem: {
        path: "./data/benchmarks/convomem/convomem_data.json",
        displayName: "ConvoMem",
      },
    }

    const activeRuns = getActiveRunsWithBenchmarks()
    const downloads: Array<{ benchmark: string; displayName: string; runId: string }> = []
    const seenBenchmarks = new Set<string>()

    for (const { runId, benchmark } of activeRuns) {
      if (seenBenchmarks.has(benchmark)) continue

      const datasetInfo = benchmarkDatasets[benchmark]
      if (datasetInfo) {
        const fullPath = join(process.cwd(), datasetInfo.path)
        if (!existsSync(fullPath)) {
          downloads.push({
            benchmark,
            displayName: datasetInfo.displayName,
            runId,
          })
          seenBenchmarks.add(benchmark)
        }
      }
    }

    return json({
      hasActive: downloads.length > 0,
      downloads,
    })
  }

  // GET /api/benchmarks/:name/questions - Preview benchmark questions
  const questionsMatch = pathname.match(/^\/api\/benchmarks\/([^/]+)\/questions$/)
  if (method === "GET" && questionsMatch) {
    const benchmarkName = questionsMatch[1]

    try {
      const benchmark = createBenchmark(benchmarkName as any)
      await benchmark.load()
      const questions = benchmark.getQuestions()

      // Support pagination
      const page = parseInt(url.searchParams.get("page") || "1")
      const limit = parseInt(url.searchParams.get("limit") || "20")
      const type = url.searchParams.get("type")

      let filtered = questions
      if (type) {
        filtered = questions.filter((q) => q.questionType === type)
      }

      const total = filtered.length
      const start = (page - 1) * limit
      const paged = filtered.slice(start, start + limit)

      const questionTypeRegistry = benchmark.getQuestionTypes()
      const questionTypes = Object.keys(questionTypeRegistry)

      return json({
        questions: paged.map((q) => ({
          questionId: q.questionId,
          question: q.question,
          questionType: q.questionType,
          groundTruth: q.groundTruth,
        })),
        questionTypes,
        questionTypeRegistry,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      })
    } catch (e) {
      return json({ error: `Benchmark not found: ${benchmarkName}` }, 404)
    }
  }

  // GET /api/models - List available models
  if (method === "GET" && pathname === "/api/models") {
    const openai = listModelsByProvider("openai").map((alias) => ({
      alias,
      ...MODEL_ALIASES[alias],
      provider: "openai",
    }))
    const anthropic = listModelsByProvider("anthropic").map((alias) => ({
      alias,
      ...MODEL_ALIASES[alias],
      provider: "anthropic",
    }))
    const google = listModelsByProvider("google").map((alias) => ({
      alias,
      ...MODEL_ALIASES[alias],
      provider: "google",
    }))

    return json({
      models: {
        openai,
        anthropic,
        google,
      },
    })
  }

  return null
}

function getBenchmarkDisplayName(name: string): string {
  const names: Record<string, string> = {
    locomo: "LoCoMo",
    longmemeval: "LongMemEval",
    convomem: "ConvoMem",
  }
  return names[name] || name
}

function getBenchmarkDescription(name: string): string {
  const descriptions: Record<string, string> = {
    locomo: "Long Context Memory - Tests fact recall, temporal reasoning, multi-hop inference",
    longmemeval:
      "Long-term memory evaluation - Single/multi-session, temporal reasoning, knowledge update",
    convomem: "Conversational memory - User facts, preferences, implicit connections",
  }
  return descriptions[name] || ""
}
