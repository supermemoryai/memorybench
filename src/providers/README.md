# Providers

Memory provider integrations. Each provider implements the `Provider` interface.

## Interface

```typescript
interface Provider {
    name: string
    prompts?: ProviderPrompts
    initialize(config: ProviderConfig): Promise<void>
    ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult>
    awaitIndexing(result: IngestResult, containerTag: string): Promise<void>
    search(query: string, options: SearchOptions): Promise<unknown[]>
    clear(containerTag: string): Promise<void>
}
```

## Adding a Provider

1. Create `src/providers/myprovider/index.ts`
2. Implement `Provider` interface
3. Register in `src/providers/index.ts`
4. Add to `ProviderName` type in `src/types/provider.ts`
5. Add config in `src/utils/config.ts`

**Required returns:**
- `initialize()` - Set up client with API key
- `ingest()` - Return `{ documentIds: string[], taskIds?: string[] }`
- `awaitIndexing()` - Wait for async indexing to complete
- `search()` - Return array of results (provider-specific format)
- `clear()` - Delete data by containerTag

## Custom Prompts

Providers can override answer generation and judge prompts via `ProviderPrompts`:

```typescript
interface ProviderPrompts {
    answerPrompt?: string | ((question: string, context: unknown[], questionDate?: string) => string)
    judgePrompt?: (question: string, groundTruth: string, hypothesis: string) => { default: string, [type: string]: string }
}
```

**Answer Prompt:** Transform search results into an LLM prompt. Function receives raw search results.

**Judge Prompt:** Return prompts keyed by question type. Must include `default`. Falls back to built-in prompts if not provided.

Example: See `src/providers/zep/prompts.ts`

## Existing Providers

| Provider | SDK | Notes |
|----------|-----|-------|
| `supermemory` | `supermemory` | Raw JSON sessions |
| `mem0` | `mem0ai` | v2 API with graph |
| `zep` | `@getzep/zep-cloud` | Graph-based, custom prompts |
| `filesystem` | OpenAI | MEMORY.md-style: LLM-extracted Markdown + text search |
| `rag` | OpenAI | OpenClaw/QMD-style: chunked + embedded, hybrid BM25 + vector |
| `basic-memory` | `bm` CLI | Local Markdown knowledge graph; hybrid FTS + semantic search |

## Basic Memory Setup

[Basic Memory](https://github.com/basicmachines-co/basic-memory) is a local-first
knowledge graph built from Markdown files. The provider drives the local `bm` CLI
(`bm tool ... --local`, JSON output) — no API key or hosted service is required.

1. **Install the CLI** (Python, via [uv](https://docs.astral.sh/uv/)):

   ```bash
   uv tool install basic-memory
   # verify
   bm --version
   ```

   If the executable is named differently or not on `PATH`, set `BASIC_MEMORY_CLI`
   to the command name or absolute path (e.g. `export BASIC_MEMORY_CLI=basic-memory`).

2. **Run the benchmark** — no key needed:

   ```bash
   bun run src/index.ts run -p basic-memory -b locomo -s 5
   ```

**How it works**

- **Isolation:** the provider points `BASIC_MEMORY_CONFIG_DIR` / `BASIC_MEMORY_HOME`
  at `data/providers/basic-memory`, and creates one throwaway BM **project per
  `containerTag`**. It never touches your real `~/.config/basic-memory` config or
  existing projects.
- **Ingest:** each session is written as a Markdown note via `bm tool write-note`.
- **Indexing:** `awaitIndexing` polls `bm status` until the project's file/db sync
  settles, then runs `bm reindex --embeddings` to build vector embeddings (these lag
  the FTS index, and are needed for semantic recall).
- **Search:** `bm tool search-notes --hybrid` combines full-text and semantic search.
- **Clear:** the BM project and its on-disk data are removed.

The first search/reindex downloads the embedding model to a local cache (one-time).
