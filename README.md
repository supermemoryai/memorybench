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
│  LongMem..) │    │  Mem0, Zep) │    │  Claude..)  │
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
| `beam prepare` | Download, verify, and convert pinned public BEAM data |
| `help` | Show help (`help providers`, `help models`, `help benchmarks`) |

## Options

```
-p, --provider         Memory provider (supermemory, mem0, zep)
-b, --benchmark        Benchmark (locomo, longmemeval, convomem, beam-1m, beam-10m, beam-1m-10m)
-j, --judge            Judge model (gpt-4o, sonnet-4, gemini-2.5-flash, etc.)
-r, --run-id           Run identifier (auto-generated if omitted)
-m, --answering-model  Model for answer generation (default: gpt-4o)
-l, --limit            Limit number of questions
-q, --question-id      Specific question (for test command)
--force                Clear checkpoint and restart
--data-path            Prepared BEAM snapshot root or snapshot path
--dataset-revision     Pin the prepared BEAM dataset fingerprint
--retrieval-top-k      BEAM paper cutoff (5, 10, 15, or 20; default: 5)
--answer-cutoff        Evidence shown to the answerer in the experimental mem0-nugget profile
--evaluation-profile   Experimental BEAM evaluation profile (`mem0-nugget`)
--source-run           Reuse validated completed ingest/index builds in a new run
--concurrency          Default phase/build concurrency (supported by `run` and `ingest`)
--ingest-batch-size    Ordered sessions per provider request before its readiness barrier
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

# Prepare and run the supported BEAM 1M tier
bun run src/index.ts beam prepare --tiers 1M
# Copy the dataset fingerprint printed by `beam prepare` into this command.
bun run src/index.ts run -p supermemory -b beam-1m -j gpt-4.1-mini --retrieval-top-k 5 --data-path ./data/benchmarks/beam --dataset-revision DATASET_FINGERPRINT_PRINTED_ABOVE

# Experimental direct-K50 mem0-style scoring run reusing the completed 1M build.
# This does not alter or claim parity with the BEAM paper protocol.
bun run src/index.ts run -p supermemory -b beam-1m --source-run beam-1m-ingest-c35-b5 -r beam-1m-sm-gpt5-direct-k50-mem0-nugget-v3 --from-phase search --evaluation-profile mem0-nugget --retrieval-top-k 50 --answer-cutoff 50 -m gpt-5 -j gpt-5 --concurrency-search 10 --concurrency-answer 10 --concurrency-evaluate 10

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

Build phases checkpoint once per shared haystack; search, answer, and evaluation checkpoint per
question. Failed runs resume only when the pinned dataset, protocol, provider adapter, models, and
retrieval configuration still match.

BEAM uses a per-session causal build barrier: each conversation stays ordered as
`add -> ready -> checkpoint -> next session`, while separate conversations may run concurrently.

For BEAM, the report keeps the paper score (macro-average across the ten memory abilities) separate
from pass accuracy (`question score >= 0.5`). Event-ordering questions use the published normalized
Kendall tau-b score rather than a nugget average. Combined 1M/10M runs
report each tier separately and label their cross-tier macro as a MemoryBench aggregate, not as a paper score.
Limited or sampled runs are labeled `beamScorePartial` and cannot enter the ranked leaderboard; only
the exact validated 700-question 1M or 200-question 10M cohort receives the official `beamScore` key.

The explicit `mem0-nugget` profile is an experimental comparison protocol. It uses the public mem0
answer/judge prompts, GPT-5 judge identity, mem0's numeric score clamp, and ordinary nugget averages
for all ten abilities—including event ordering. Its primary metric is `mem0NuggetAverage`, never
`beamScore`. GPT-5 answering and judging use OpenAI Chat Completions, omit temperature and reasoning
effort, allow 4,096 completion tokens, and use up to five outer attempts with a 120-second deadline
and 2/4/6/8-second backoff. Each outer attempt retains the pinned client's two inner transport
retries. The direct-K50 command above requests and answers with 50 results. It is not an exact
reproduction of mem0's published Top-50 result: the pinned public mem0 runner retrieves 200 and then
applies an answer cutoff of 50, while this harness currently permits at most 100 results per direct
provider request. If all five answering attempts exhaust without non-empty text—including transport
failures—this profile preserves Mem0's terminal behavior by checkpointing the empty hypothesis and
evaluating it; other protocols remain fail-closed. The profile also fails closed on schema-invalid judge output instead of using
mem0's raw-text `1.0`/`0.5` marker fallback. Source-build reuse validates the dataset, ordered
haystacks, ingestion policy, provider adapter/configuration, and completed indexing before retaining
the existing containers.

## MemScore

MemScore is a composite metric that captures three dimensions of provider performance in a single line:

```
accuracy% / latencyMs / contextTokens
```

| Component | What it measures |
|-----------|-----------------|
| **Quality** | The benchmark protocol's primary quality metric (legacy benchmarks use binary accuracy; BEAM uses its continuous paper score) |
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
