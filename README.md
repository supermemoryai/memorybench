# Memorybench

A unified benchmarking platform for memory providers. Add **providers** or **benchmarks** and run them using a unified CLI.

## Quick Start

```bash
bun install

# List available benchmarks and providers
bun run index.ts list benchmarks
bun run index.ts list providers

# Run a benchmark
bun run index.ts --benchmarks RAG-template-benchmark --providers ContextualRetrieval
```

## Available Benchmarks

| Benchmark | Description |
|-----------|-------------|
| RAG-template-benchmark | Basic RAG retrieval accuracy |
| LongMemEval | Long-term memory evaluation with 6 question types |

## Available Providers

| Provider | Description |
|----------|-------------|
| ContextualRetrieval | Contextual chunking with embeddings |
| AQRAG | Adaptive query RAG |
| quickstart-test | Simple in-memory provider for testing |

## Adding a Benchmark

Create `benchmarks/<name>/manifest.json`:

```json
{
  "manifest_version": "1",
  "name": "my-benchmark",
  "version": "1.0.0",
  "data_file": "data.jsonl",
  "ingestion": { "strategy": "simple", "content_field": "content" },
  "query": { "question_field": "question", "expected_answer_field": "answer" },
  "evaluation": { "protocol": "exact-match" },
  "metrics": ["correctness"],
  "required_capabilities": ["add_memory", "retrieve_memory"]
}
```

## Adding a Provider

Create `providers/<name>/index.ts` implementing `BaseProvider`:

```typescript
import type { BaseProvider } from "../../types/provider";

export default {
  name: "my-provider",
  async add_memory(scope, content) { /* ... */ },
  async retrieve_memory(scope, query, limit) { /* ... */ },
  async delete_memory(scope, id) { /* ... */ }
} satisfies BaseProvider;
```

## v0.1 Scope

See [docs/v0.1_scope.md](docs/v0.1_scope.md) for the v0.1 Definition of Done.
