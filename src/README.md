# Source Structure

```
src/
├── benchmarks/      # Benchmark adapters (LoCoMo, LongMemEval, ConvoMem)
├── providers/       # Memory provider integrations (Supermemory, Mem0, Zep, Local BM25)
├── judges/          # LLM-as-judge implementations (OpenAI, Anthropic, Google)
├── orchestrator/    # Pipeline execution and checkpointing
│   └── phases/      # Individual phase runners (ingest, search, answer, evaluate)
├── prompts/         # Default judge prompts by question type
├── types/           # TypeScript interfaces
├── cli/             # CLI commands
├── server/          # Web UI server
└── utils/           # Config, logging, model utilities
```

## Key Files

| File | Purpose |
|------|---------|
| `types/provider.ts` | Provider interface |
| `types/benchmark.ts` | Benchmark interface |
| `types/judge.ts` | Judge interface |
| `types/unified.ts` | Shared data types (UnifiedSession, UnifiedQuestion) |
| `types/prompts.ts` | Prompt type definitions |
| `utils/models.ts` | Model configurations and aliases |
| `utils/config.ts` | Environment config loading |
| `prompts/defaults.ts` | Default judge prompts |
