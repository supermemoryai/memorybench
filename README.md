# MemoryBench

A pluggable benchmarking framework for evaluating memory and context systems.

<img width="3584" height="2154" alt="original" src="https://github.com/user-attachments/assets/7fe49b7e-ed0b-4861-92a5-fa5d199cfc72" />


## Features

- 🔌 Interoperable: mix and match any provider with any benchmark
- 🧩 Bring your own benchmarks: plug in custom datasets and tasks
- ♻️ Checkpointed runs: resume from any pipeline stage (ingest → index → search → answer → evaluate)
- 🆚 Multi‑provider comparison: run the same benchmark across providers side‑by‑side
- 🧪 Judge‑agnostic: swap GPT‑4o, Claude, Gemini, etc. without code changes
- 📊 Structured reports: export run status, failures, and metrics for analysis
- 🖥️ Web UI: inspect runs, questions, and failures interactively, in real-time!


```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  Benchmarks │    │  Providers  │    │   Judges    │
│  (LoCoMo,   │    │ (Supermem,  │    │  (GPT-4o,   │
│  LongMem..) │    │  Mem0, Zep, │    │  Claude..)  │
│             │    │  Memento)   │    │             │
└──────┬──────┘    └──────┬──────┘    └──────┬──────┘
       └──────────────────┼──────────────────┘
                         ▼
             ┌───────────────────────┐
             │      MemoryBench      │
             └───────────┬───────────┘
                         ▼
   ┌────────┬─────────┬────────┬──────────┬────────┐
   │ Ingest │ Indexing│ Search │  Answer  │Evaluate│
   └────────┴─────────┴────────┴──────────┴────────┘
```

## Quick Start

```bash
bun install
cp .env.example .env.local  # Add your API keys
bun run src/index.ts run -p supermemory -b locomo
```

## Configuration

```bash
# Providers (at least one)
SUPERMEMORY_API_KEY=
MEM0_API_KEY=
ZEP_API_KEY=
# Memento: no API key — runs as a local stdio subprocess. The provider
# distils each session through an LLM (the configured answering model
# by default) before writing to Memento. Optional knobs:
#   MEMENTO_BIN=<command>           (default: "npx -y @psraghuveer/memento")
#   MEMENTO_BENCH_DB=<path>         (default: /tmp/memento-bench-<ts>.db)
#   MEMENTO_DISTILL_MODEL=<alias>   (default: memorybench answering model)
#   MEMENTO_BENCH_SEARCH_LIMIT=<n>  (default: 30)
#   MEMENTO_AWAIT_INDEXING_MS=<ms>  (default: 180000)

# Judges (at least one)
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GOOGLE_API_KEY=
```

## Commands

| Command | Description |
|---------|-------------|
| `run` | Full pipeline: ingest → index → search → answer → evaluate → report |
| `compare` | Run benchmark across multiple providers simultaneously |
| `ingest` | Ingest benchmark data into provider |
| `search` | Run search phase only |
| `test` | Test single question |
| `status` | Check run progress |
| `list-questions` | Browse benchmark questions |
| `show-failures` | Debug failed questions |
| `serve` | Start web UI |
| `help` | Show help (`help providers`, `help models`, `help benchmarks`) |

## Options

```
-p, --provider         Memory provider (supermemory, mem0, zep, memento)
-b, --benchmark        Benchmark (locomo, longmemeval, convomem)
-j, --judge            Judge model (gpt-4o, sonnet-4, gemini-2.5-flash, etc.)
-r, --run-id           Run identifier (auto-generated if omitted)
-m, --answering-model  Model for answer generation (default: gpt-4o)
-l, --limit            Limit number of questions
-q, --question-id      Specific question (for test command)
--force                Clear checkpoint and restart
```

## Examples

```bash
# Full run
bun run src/index.ts run -p mem0 -b locomo

# With custom run ID
bun run src/index.ts run -p mem0 -b locomo -r my-test

# Resume existing run
bun run src/index.ts run -r my-test

# Limited questions
bun run src/index.ts run -p supermemory -b locomo -l 10

# Different models
bun run src/index.ts run -p zep -b longmemeval -j sonnet-4 -m gemini-2.5-flash

# Compare multiple providers
bun run src/index.ts compare -p supermemory,mem0,zep -b locomo -s 5

# Test single question
bun run src/index.ts test -r my-test -q question_42

# Debug
bun run src/index.ts status -r my-test
bun run src/index.ts show-failures -r my-test
```

## Pipeline

```
1. INGEST    Load benchmark sessions → Push to provider
2. INDEX     Wait for provider indexing
3. SEARCH    Query provider → Retrieve context
4. ANSWER    Build prompt → Generate answer via LLM
5. EVALUATE  Compare to ground truth → Score via judge
6. REPORT    Aggregate scores → Output accuracy + latency
```

Each phase checkpoints independently. Failed runs resume from last successful point.

## MemScore

MemScore is a composite metric that captures three dimensions of provider performance in a single line:

```
accuracy% / latencyMs / contextTokens
```

| Component | What it measures |
|-----------|-----------------|
| **Quality** | Answer accuracy — `(correct / total) * 100` from judge evaluations |
| **Latency** | Average search response time in milliseconds |
| **Tokens** | Average context tokens sent to the answering model (counted client-side) |

After a run completes, MemScore appears in the CLI summary:

```
Summary:
  Total Questions: 50
  Correct: 43
  Accuracy: 86.00%
  MemScore: 86% / 145ms / 1823tok
```

MemScore is intentionally a triple, not a single number — collapsing quality, latency, and cost into one score hides important tradeoffs. Use it to compare providers side-by-side on the same benchmark:

```bash
bun run src/index.ts compare -p supermemory,mem0,zep -b locomo -j gpt-4o
```

The `report.json` includes both a display string and structured `memscoreComponents` for programmatic use.

> **[Full MemScore documentation →](https://supermemory.ai/docs/memorybench/memscore)**

## Checkpointing

Runs persist to `data/runs/{runId}/`:
- `checkpoint.json` - Run state and progress
- `results/` - Search results per question
- `report.json` - Final report

Re-running same ID resumes. Use `--force` to restart.

## Extending

| Component | Guide |
|-----------|-------|
| Add Provider | [src/providers/README.md](src/providers/README.md) |
| Add Benchmark | [src/benchmarks/README.md](src/benchmarks/README.md) |
| Add Judge | [src/judges/README.md](src/judges/README.md) |
| Project Structure | [src/README.md](src/README.md) |

## License

MIT
