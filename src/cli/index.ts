import { runCommand } from "./commands/run"
import { compareCommand } from "./commands/compare"
import { ingestCommand } from "./commands/ingest"
import { searchCommand } from "./commands/search"
import { testQuestionCommand } from "./commands/test-question"
import { statusCommand } from "./commands/status"
import { listQuestionsCommand } from "./commands/list-questions"
import { showFailuresCommand } from "./commands/show-failures"
import { serveCommand } from "./commands/serve"
import { getAvailableProviders } from "../providers"
import { getAvailableBenchmarks } from "../benchmarks"
import { listModelsByProvider, MODEL_ALIASES, DEFAULT_ANSWERING_MODEL } from "../utils/models"

function printHelp(): void {
  console.log(`
MemoryBench - Benchmarking Framework for Memory Layer Providers

Usage: bun run src/index.ts <command> [options]

Commands:
  run             Run full benchmark pipeline (ingest → search → answer → evaluate → report)
  compare         Compare multiple providers against same benchmark concurrently
  ingest          Ingest benchmark data into provider
  search          Search provider for questions
  test            Test a single question (search → answer → evaluate)
  list-questions  List all questions in a benchmark (with pagination)
  show-failures   Show failed questions from a run with full debugging data
  status          Check run status
  serve           Start the web UI server
  help            Show help (use 'help providers', 'help models', 'help benchmarks' for details)

Examples:
  bun run src/index.ts run -p supermemory -b locomo -j gpt-4o -r run1
  bun run src/index.ts run -p supermemory -b locomo -j gpt-4o -r run1 -m sonnet-4.5
  bun run src/index.ts run -p mem0 -b longmemeval -j gemini-2.5-flash -r run2 -m opus-4.5
  bun run src/index.ts run -p filesystem -b locomo -j gpt-4o -r run-fs
  bun run src/index.ts run -p rag -b locomo -j gpt-4o -r run-rag
  bun run src/index.ts compare -p supermemory,filesystem,rag -b locomo -j gpt-4o -r compare1

Options:
  -p, --provider         Memory provider (see 'help providers')
  -b, --benchmark        Benchmark dataset (see 'help benchmarks')
  -j, --judge            Judge model (see 'help models')
  -r, --run-id           Run identifier
  -m, --answering-model  Answering model (default: ${DEFAULT_ANSWERING_MODEL})
  -q, --question-id      Question ID (for test command)
  --force                Clear checkpoint and start fresh

Run 'bun run src/index.ts help <topic>' for more details:
  help providers   - List all memory providers
  help models      - List all available models
  help benchmarks  - List all benchmarks
`)
}

function printProvidersHelp(): void {
  console.log(`
Memory Providers
================

Available providers for storing and retrieving memories:

  supermemory    Supermemory.ai - Cloud-based memory layer
                 Requires: SUPERMEMORY_API_KEY

  mem0           Mem0.ai - Memory layer for AI applications
                 Requires: MEM0_API_KEY

  zep            Zep - Long-term memory for AI assistants
                 Requires: ZEP_API_KEY

  filesystem     File-based memory (Claude MEMORY.md / CLAUDE.md style)
                 Extracts structured memories via LLM, stores as Markdown files, text-based search.
                 Requires: OPENAI_API_KEY (for memory extraction via gpt-4o-mini)

  rag            Hybrid RAG memory (OpenClaw/QMD style)
                 Extracts memories via LLM, chunks + embeds extracted content, hybrid BM25 + vector search.
                 Requires: OPENAI_API_KEY (for memory extraction via gpt-4o-mini + embeddings)

Usage:
  -p supermemory    Use Supermemory as the memory provider
  -p mem0           Use Mem0 as the memory provider
  -p zep            Use Zep as the memory provider
  -p filesystem     Use file-based memory (CLAUDE.md style)
  -p rag            Use hybrid RAG memory (OpenClaw/QMD style)
`)
}

function printModelsHelp(): void {
  const openaiModels = listModelsByProvider("openai")
  const anthropicModels = listModelsByProvider("anthropic")
  const googleModels = listModelsByProvider("google")

  console.log(`
Available Models
================

Models can be used for both -j (judge) and -m (answering model).
Provider is auto-detected from the model name.

OpenAI Models:
`)
  for (const alias of openaiModels) {
    const info = MODEL_ALIASES[alias]
    console.log(`  ${alias.padEnd(20)} ${info.displayName} (${info.id})`)
  }

  console.log(`
Anthropic Models:
`)
  for (const alias of anthropicModels) {
    const info = MODEL_ALIASES[alias]
    console.log(`  ${alias.padEnd(20)} ${info.displayName} (${info.id})`)
  }

  console.log(`
Google Models:
`)
  for (const alias of googleModels) {
    const info = MODEL_ALIASES[alias]
    console.log(`  ${alias.padEnd(20)} ${info.displayName} (${info.id})`)
  }

  console.log(`
Examples:
  -j gpt-4o              Use GPT-4o as judge
  -j sonnet-4.5          Use Claude Sonnet 4.5 as judge
  -m gemini-2.5-flash    Use Gemini 2.5 Flash for answering
  -m opus-4.5            Use Claude Opus 4.5 for answering

Default answering model: ${DEFAULT_ANSWERING_MODEL}
`)
}

function printBenchmarksHelp(): void {
  console.log(`
Benchmarks
==========

Available benchmark datasets for evaluation:

  locomo         LoCoMo - Long Context Memory benchmark
                 Tests: fact recall, temporal reasoning, multi-hop, inference, abstention
                 Source: GitHub snap-research/locomo (downloaded on first use)

  longmemeval    LongMemEval - Long-term memory evaluation
                 Tests: single-session, multi-session, temporal reasoning, knowledge update
                 Source: HuggingFace xiaowu0162/longmemeval-cleaned (downloaded on first use)

  convomem       ConvoMem - Conversational memory benchmark
                 Tests: user facts, assistant facts, preferences, implicit connections
                 Source: HuggingFace Salesforce/ConvoMem (downloaded on first use)

Usage:
  -b locomo        Run LoCoMo benchmark
  -b longmemeval   Run LongMemEval benchmark
  -b convomem      Run ConvoMem benchmark
`)
}

export async function cli(args: string[]): Promise<void> {
  const command = args[0]
  const commandArgs = args.slice(1)

  switch (command) {
    case "run":
      await runCommand(commandArgs)
      break
    case "compare":
      await compareCommand(commandArgs)
      break
    case "ingest":
      await ingestCommand(commandArgs)
      break
    case "search":
      await searchCommand(commandArgs)
      break
    case "test":
      await testQuestionCommand(commandArgs)
      break
    case "status":
      await statusCommand(commandArgs)
      break
    case "list-questions":
      await listQuestionsCommand(commandArgs)
      break
    case "show-failures":
      await showFailuresCommand(commandArgs)
      break
    case "serve":
      await serveCommand(commandArgs)
      break
    case "help":
    case "--help":
    case "-h":
      const topic = commandArgs[0]
      if (topic === "providers") {
        printProvidersHelp()
      } else if (topic === "models") {
        printModelsHelp()
      } else if (topic === "benchmarks") {
        printBenchmarksHelp()
      } else {
        printHelp()
      }
      break
    default:
      printHelp()
      break
  }
}
