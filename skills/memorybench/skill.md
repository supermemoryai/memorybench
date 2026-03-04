---
name: benchmark-context
description: "Automatically benchmark your custom memory implementation against established systems like Supermemory. Set up a public benchmark, or create your own. Compare solutions against quality, latency, features and cost, easily, with a simple UI and CLI."
---

# MemoryBench Integration Skill

Automatically benchmark your custom memory implementation against established systems like Supermemory, Mem0, and Zep.

## What This Skill Does

When you invoke this skill from your project, it handles the complete benchmarking process end-to-end:

1. **Asks you 5 questions** about your setup preferences
2. **Analyzes your memory code** to understand how it works
3. **Generates integration code** automatically
4. **Runs the full benchmark** comparing your system to competitors
5. **Shows you the results** with clear performance comparisons

No manual commands needed - everything runs automatically from start to finish.

## When to Use This Skill

Use this skill when you:
- Built a custom memory/context system and want to see how it performs
- Need objective metrics comparing your implementation to industry solutions
- Want to benchmark on standardized datasets (conversational memory, RAG, dialogue)
- Are considering which memory system to use and want data-driven comparison

## How It Works

### The 7 Automated Phases

**Phase 1: Setup**
- Clones memorybench from https://github.com/supermemoryai/memorybench into your project (`./memorybench`)
- Installs dependencies with bun
- Verifies environment is ready

**Phase 2: Discovery**
- Uses AI agents to analyze your memory codebase
- Identifies initialization, ingestion, and search methods
- Detects required configuration and API keys
- Understands your data formats

**Phase 3: Code Generation**
- Creates a provider adapter implementing the MemoryBench interface
- Copies and adapts your memory code into the provider
- Generates custom prompts if needed for your result format
- See [Provider Template Reference](references/provider-template.md)

**Phase 4: Registration**
- Updates `src/types/provider.ts` with your provider name
- Registers provider in `src/providers/index.ts`
- Adds configuration in `src/utils/config.ts`
- Documents environment variables

**Phase 5: Configuration**
- Creates `.env.local` with required API keys
- Asks for your provider credentials
- Asks for comparison provider keys (if selected)
- Asks for OpenAI/Anthropic key for judging

**Phase 6: Validation**
- Runs quick test with single question
- Verifies provider initialization works
- Confirms ingestion and search work correctly
- Asks if you want to continue or debug if issues arise

**Phase 7: Benchmark Execution**
- Runs full benchmark automatically
- Shows real-time progress (ingestion, indexing, search, answers, evaluation)
- Compares against selected competitors
- Presents final results with accuracy and latency metrics

## Initial Questions

The skill will ask you these questions upfront:

### 1. Provider Name
What should we call your memory provider?
- Use lowercase, no spaces (e.g., "mymemory", "contextengine")

### 2. Memory Code Location
Where is your memory implementation?
- Examples: `src/lib/memory`, `packages/memory`, `src/services/context`

### 3. Benchmark Dataset
Which dataset matches your use case?

- **LoCoMo** - Long-term conversational memory across multiple sessions spanning days/weeks
  - Best for: Chat apps, AI assistants, customer support bots

- **LongMemEval** - Memory with long documents and complex retrieval
  - Best for: RAG systems, document analysis, knowledge bases

- **ConvoMem** - Multi-turn conversation understanding and context tracking
  - Best for: Dialogue systems, interview bots, meeting assistants

See [Benchmarks Reference](references/benchmarks.md) for detailed information.

### 4. Comparison Targets (Multi-select)
Which systems to compare against?

- **Supermemory** - Fast hybrid vector + graph memory with automatic extraction
- **Mem0** - Persistent memory for AI agents with graph relationships
- **Zep** - Long-term conversation memory with automatic summarization
- **Filesystem** - Baseline vector search (no API required)
- **RAG** - Baseline RAG with LLM extraction (no API required)

### 5. Test Size
How many questions to benchmark?

- **Small** (5 questions) - Quick validation, ~2-5 minutes
- **Medium** (20 questions) - Good sample size, ~10-15 minutes
- **Full** (all questions) - Complete evaluation, ~30-60 minutes

## Working Directory Management

**Important:** You must run this skill from your project root, NOT from memorybench.

```
your-project/              ← Run skill from here
├── src/
│   └── lib/memory/        ← Your memory implementation
└── memorybench/           ← Skill clones this automatically
    └── src/providers/     ← Your provider adapter goes here
```

The skill will:
- Verify you're in your project (not in memorybench)
- Clone memorybench to `./memorybench`
- Use relative paths (`../src/lib/memory`) when analyzing your code
- Run benchmarks with `cd memorybench && bun run src/index.ts ...`

## What Gets Created

After the skill runs, you'll have:

```
your-project/
└── memorybench/
    ├── .env.local                              # Your API keys
    ├── src/
    │   ├── providers/
    │   │   └── {yourname}/
    │   │       ├── index.ts                    # Provider implementation
    │   │       └── prompts.ts                  # Custom prompts (optional)
    │   ├── types/provider.ts                   # Updated with your provider
    │   └── providers/index.ts                  # Registered
    └── data/runs/{run-id}/                     # Benchmark results
        ├── checkpoint.json                     # Run state
        ├── results/                            # Per-question results
        └── report.json                         # Final metrics
```

## After Completion

Once the benchmark finishes, the skill shows:

**Summary Scores:**
- Accuracy percentage for each provider
- Average search latency
- Success rate (questions answered vs failed)

**Key Findings:**
- "Your provider achieved 76% accuracy vs 82% for Supermemory"
- "Search latency: 145ms (yours) vs 98ms (best competitor)"

**Next Steps:**
- View detailed results: `cd memorybench && bun run src/index.ts serve`
- See failures: `cd memorybench && bun run src/index.ts show-failures -r {run-id}`
- Try different benchmark: Run this skill again with another dataset
- Run manually: `cd memorybench && bun run src/index.ts run -p {name} -b {benchmark}`

## Troubleshooting

If something goes wrong:

- **"Provider not initialized"** - Check API keys in `.env.local`
- **Ingestion fails** - Check data format transformation, see [Data Formats Reference](references/data-formats.md)
- **Search returns no results** - Verify containerTag handling and indexing completion
- **Answers are wrong** - May need custom prompts for your result format

See [Debugging Reference](references/debugging.md) for detailed troubleshooting.

## Implementation Instructions for Claude

When executing this skill, follow these steps:

### Step 1: Verify Environment

Check that we're in the user's project (not in memorybench):

```bash
basename "$(pwd)" | grep -q "memorybench" && echo "ERROR" || echo "OK"
```

If ERROR, inform user to run from their project root and exit.

### Step 2: Clone MemoryBench

Check if memorybench already exists:

```bash
[ -d "memorybench" ] && echo "EXISTS" || echo "NOT_FOUND"
```

If NOT_FOUND, clone it using EXACTLY this command (do not modify the URL):

```bash
git clone https://github.com/supermemoryai/memorybench.git memorybench
```

Then install dependencies:

```bash
cd memorybench && bun install && cd ..
```

**IMPORTANT**: You MUST use the URL `https://github.com/supermemoryai/memorybench.git` - do not infer or use any other URL.

If EXISTS, use the existing installation (no action needed).

### Step 3: Gather User Input

Use AskUserQuestion tool to collect all 5 questions at once:
1. Provider name (text input suggestion)
2. Memory code location (text input suggestion)
3. Benchmark dataset (single select: locomo, longmemeval, convomem)
4. Comparison targets (multi-select: supermemory, mem0, zep, filesystem, rag)
5. Test size (single select: 5, 20, or full)

### Step 4: Analyze User's Memory Code

Use Task tool with `subagent_type=Explore` to analyze the provided memory code location. Look for initialization, add/ingest methods, search/query methods, and configuration needs.

### Step 5: Generate Provider Code

Based on discovery, create:
- `memorybench/src/providers/{providerName}/index.ts` using template from references/provider-template.md
- Optionally `memorybench/src/providers/{providerName}/prompts.ts` if custom formatting needed

### Step 6: Register Provider

Update these files in memorybench:
1. `src/types/provider.ts` - Add to ProviderName union type
2. `src/providers/index.ts` - Import and register in providers Record
3. `src/utils/config.ts` - Add case in getProviderConfig()
4. `.env.example` - Document environment variables

### Step 7: Configure Environment

Ask user for API keys (OpenAI for judging, their provider keys, comparison provider keys).
Create or update `memorybench/.env.local` with provided values.

### Step 8: Validation Test

Run quick test:

```bash
cd memorybench && bun run src/index.ts test -p {providerName} -b {benchmark} -q question_1
```

If fails, show error and ask user if they want to debug or abort.

### Step 9: Run Benchmark

Based on user selections, run the benchmark command and LET IT COMPLETE without polling.

**With comparisons:**
```bash
cd memorybench && bun run src/index.ts compare -p {providerName},{others} -b {benchmark} -l {limit}
```

**Without comparisons:**
```bash
cd memorybench && bun run src/index.ts run -p {providerName} -b {benchmark} -l {limit}
```

(Omit `-l {limit}` if user selected "full")

**IMPORTANT INSTRUCTIONS FOR RUNNING:**
1. Use Bash tool with `run_in_background: false` (or omit the parameter) so the command runs synchronously
2. Set a long timeout (e.g., `timeout: 600000` for 10 minutes)
3. DO NOT poll with BashOutput repeatedly - let the command complete on its own
4. The benchmark will show progress automatically in its output
5. Only when the command fully completes, proceed to Step 10

**Alternative if synchronous doesn't work:**
1. Use `run_in_background: true`
2. Tell the user "The benchmark is running in the background (typically takes 5-15 minutes depending on test size)"
3. Use BashOutput ONCE after an appropriate wait time to get final results
4. Do NOT repeatedly poll for progress updates

### Step 10: Present Results

When the benchmark completes, parse the final output and present:
- Accuracy scores for each provider
- Latency metrics
- Key findings and comparisons
- Suggested next steps

Look for sections in the output like:
- "COMPARISON RESULTS" or "Final Report"
- Accuracy percentages
- Average latencies
- Success rates

## Reference Documentation

- [Provider Template](references/provider-template.md) - Code templates and interface details
- [Benchmarks](references/benchmarks.md) - Dataset details and characteristics
- [Data Formats](references/data-formats.md) - UnifiedSession structure and transformations
- [Debugging](references/debugging.md) - Common issues and solutions

## Success Criteria

The skill completes successfully when:
1. ✅ Provider adapter generated and registered
2. ✅ Validation test passes (single question works)
3. ✅ Full benchmark completes without errors
4. ✅ Results displayed with comparison scores
5. ✅ You can see how your system stacks up against competitors

## Running the Skill

From your project root:

```bash
# Invoke the skill (in Claude Code CLI)
/memorybench

# Or if using skills programmatically
skill:memorybench
```

That's it! The skill handles everything else automatically.
