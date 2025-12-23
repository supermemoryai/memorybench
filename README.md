# MemoryBench

A unified benchmarking platform for evaluating memory providers. Test and compare different AI memory systems (SuperMemory, Mem0, Zep, LangChain, etc.) against standardized benchmarks.

## Features

- **Multiple Benchmarks**: NoLiMa (needle-in-haystack), LongMemEval (long-term memory), LoCoMo (conversational memory)
- **Extensible Providers**: Easy to add new memory providers
- **Unified CLI**: Single interface for all benchmarks and providers
- **Checkpointing**: Resume interrupted runs automatically
- **Visualization Dashboard**: Compare results across providers

## Quick Start

### 1. Install Bun

MemoryBench uses [Bun](https://bun.sh/) as its runtime. Install it first:

```bash
# macOS / Linux / WSL
curl -fsSL https://bun.sh/install | bash

# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"

# Verify installation
bun --version
```

### 2. Install Dependencies

```bash
cd memorybench
bun install
```

### 3. Configure Environment Variables

Create a `.env` file in the root directory:

```bash
# Provider API Keys (add the ones you need)
SUPERMEMORY_API_KEY=your_supermemory_key
SUPERMEMORY_API_URL=https://api.supermemory.ai

MEM0_API_KEY=your_mem0_key
MEM0_API_URL=https://api.mem0.ai/v1

ZEP_API_KEY=your_zep_key
ZEP_API_URL=https://api.getzep.com

# Required for evaluation (LLM-as-a-judge)
OPENAI_API_KEY=your_openai_key

# Optional: For Gemini models
GOOGLE_VERTEX_PROJECT_ID=your_project_id
GOOGLE_CLIENT_EMAIL=your_service_account@project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

### 4. Prepare Datasets

**For LongMemEval:**
```bash
# Download dataset from HuggingFace
# https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned

mkdir -p benchmarks/LongMemEval/datasets
mv ~/Downloads/longmemeval_s_cleaned.json benchmarks/LongMemEval/datasets/

# Split into individual questions
cd benchmarks/LongMemEval
bun run scripts/setup/split_questions.ts
cd ../..
```

**For NoLiMa:**
The NoLiMa datasets should be in `benchmarks/NoLiMa/datasets/`.

**For LoCoMo:**
Dataset is included at `benchmarks/LoCoMo/locomo10.json`.

## Running Benchmarks

### Basic Usage

```bash
bun run benchmark <benchmark-name> <provider-name> [options]
```

### Available Benchmarks

| Benchmark | Description | Questions |
|-----------|-------------|-----------|
| `NoLiMa` | Needle-in-a-haystack across context lengths | ~100+ tests |
| `LongMemEval` | Long-term memory (6 question types) | 500 questions |
| `LoCoMo` | Conversational memory | ~2000 questions |

### Available Providers

| Provider | Description | API Key Required |
|----------|-------------|------------------|
| `supermemory` | SuperMemory API | `SUPERMEMORY_API_KEY` |
| `mem0` | Mem0 memory system | `MEM0_API_KEY` |
| `zep` | Zep long-term memory | `ZEP_API_KEY` |
| `langchain` | In-memory vector store | `OPENAI_API_KEY` |
| `fullcontext` | Baseline (returns all context) | None |

### Examples

```bash
# Quick test with 5 samples
bun run benchmark NoLiMa supermemory --limit=5

# Full benchmark run
bun run benchmark LongMemEval mem0

# Custom models for answering and judging
bun run benchmark LoCoMo supermemory --answeringModel=gpt-4o --judgeModel=gpt-4o

# Skip phases (useful for resuming or re-evaluating)
bun run benchmark LongMemEval supermemory --skipIngest --skipSearch

# Mark as formal run (for dashboard visualization)
bun run benchmark NoLiMa supermemory --formal --limit=50
```

### CLI Options

| Option | Description |
|--------|-------------|
| `--limit=<N>` | Limit number of test cases to process |
| `--skipIngest` | Skip ingestion phase |
| `--skipSearch` | Skip search phase |
| `--skipEvaluate` | Skip evaluation phase |
| `--answeringModel=<model>` | Model for generating answers (default: `gpt-4o`) |
| `--judgeModel=<model>` | Model for judging answers (default: `gpt-4o`) |
| `--runId=<id>` | Custom run ID (auto-generated if not provided) |
| `--formal` | Mark run for inclusion in visualization dashboard |
| `--topK=<N>` | Number of results to retrieve (benchmark-specific) |

### Run ID Format

Run IDs are auto-generated as: `{Benchmark}_{provider}_{YYYYMMDD}_{HHMMSS}[_formal]`

Example: `NoLiMa_supermemory_20251223_143022`

## Visualization Dashboard

View and compare benchmark results in an interactive web dashboard.

### Start the Dashboard

```bash
bun run viz
```

Open [http://localhost:3001](http://localhost:3001) in your browser.

### Dashboard Features

- **Multi-Benchmark Tabs**: Switch between NoLiMa, LongMemEval, and LoCoMo results
- **Provider Filtering**: Toggle providers on/off with checkboxes
- **Interactive Charts**: Bar charts for accuracy, retrieval rates, and metrics
- **Summary Statistics**: Quick overview cards with key metrics

### Results Location

All benchmark results are saved to `results/{runId}/`:

```
results/{runId}/
├── checkpoints/           # Progress checkpoints (for resuming)
│   ├── ingest/
│   └── search/
├── search/                # Raw search results
└── evaluation-summary.json # Final evaluation metrics
```

## Adding New Providers

1. Create `providers/your-provider/Provider.ts`:

```typescript
import { BaseProvider, type ProviderConfig, type IngestOptions, 
         type SearchOptions, type SearchResult } from '../../core/providers/BaseProvider';

export default class YourProvider extends BaseProvider {
    constructor() {
        super({
            name: 'your-provider',
            requiresApiKey: true,
            apiKeyEnvVar: 'YOUR_PROVIDER_API_KEY',
            supportsMetadata: true,
        });
    }

    public async ingest(content: string, containerTag: string, options?: IngestOptions): Promise<void> {
        // Implement ingestion logic
    }

    public async search(query: string, containerTag: string, options?: SearchOptions): Promise<SearchResult[]> {
        // Implement search logic
        return [];
    }
}
```

2. The provider is automatically discovered - no other files need to be modified!

## Adding New Benchmarks

1. Create `benchmarks/YourBenchmark/runner/index.ts`:

```typescript
export async function runYourBenchmark(providerName: string, args: string[]) {
    // Implement benchmark phases:
    // 1. Ingest data
    // 2. Run searches
    // 3. Evaluate results
}
```

2. Add to `cli/run-benchmark.ts`:
   - Add to `AVAILABLE_BENCHMARKS` array
   - Add case in switch statement

## Troubleshooting

### "Provider not found"
Ensure `providers/{name}/Provider.ts` exists and exports a default class.

### "API key missing"
Add the required environment variable to your `.env` file.

### "Dataset not found"
Follow the dataset preparation steps for the specific benchmark.

### Rate Limiting
The system includes delays between API calls. If you hit rate limits, the checkpoint system allows resuming where you left off.

### Resume Failed Runs
Simply re-run the same command with the same `--runId` to resume from the last checkpoint.

## Project Structure

```
memorybench/
├── core/                  # Framework infrastructure
│   ├── providers/         # BaseProvider, Registry, Loader
│   └── runners/           # BenchmarkRunner base class
├── providers/             # Provider implementations
├── benchmarks/            # Benchmark implementations
├── cli/                   # CLI tools
├── results/               # Benchmark results
└── viz/                   # Visualization dashboard
```

## License

MIT
