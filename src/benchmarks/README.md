# Benchmarks

Benchmark dataset adapters. Each benchmark implements the `Benchmark` interface.

## Interface

```typescript
interface Benchmark {
    name: string
    load(config?: BenchmarkConfig): Promise<void>
    getQuestions(filter?: QuestionFilter): UnifiedQuestion[]
    getHaystackSessions(questionId: string): UnifiedSession[]
    getGroundTruth(questionId: string): string
    getQuestionTypes(): QuestionTypeRegistry
    // Optional
    getContainerKey?(questionId: string): string   // questions sharing a haystack share a container
    headlineExcludedTypes?: string[]                 // left out of the comparable headline score
    searchLimit?: number                             // results per search (default 10)
    buildAnswerPrompt?(question, context): string    // standard answer prompt, overrides provider prompts
    buildJudgePrompt?({ question, hypothesis }): string
}
```

## Adding a Benchmark

1. Create `src/benchmarks/mybenchmark/index.ts`
2. Implement `Benchmark` interface
3. Register in `src/benchmarks/index.ts`
4. Add to `BenchmarkName` type in `src/types/benchmark.ts`

**Required returns:**
- `load()` - Parse data, populate internal maps
- `getQuestions()` - Return `UnifiedQuestion[]` with filtering support
- `getHaystackSessions()` - Return `UnifiedSession[]` for a question
- `getGroundTruth()` - Return expected answer string
- `getQuestionTypes()` - Return `{ [id]: { id, alias, description } }`

## Existing Benchmarks

| Benchmark | Source | Description |
|-----------|--------|-------------|
| `locomo` | GitHub snap-research/locomo | Long context memory benchmark |
| `longmemeval` | HuggingFace xiaowu0162/longmemeval-cleaned | Long-term memory evaluation |
| `convomem` | HuggingFace Salesforce/ConvoMem | Conversational memory benchmark |
| `beam` | HuggingFace Mohammadta/BEAM (1M) | Long chats with 10 memory abilities, oracle evidence |

## Question Types

### LoCoMo
Category ids follow the dataset (snap-research/locomo): 1 multi-hop, 2 temporal, 3 open-domain, 4 single-hop, 5 adversarial.

| Type | Alias | Description |
|------|-------|-------------|
| `multi-hop` | multi | Answer spread across sessions (cat 1, 282 questions) |
| `temporal` | temporal | Temporal reasoning (cat 2, 321) |
| `open-domain` | open | Needs commonsense/world knowledge (cat 3, 96) |
| `single-hop` | single | Single-hop fact recall (cat 4, 841) |
| `adversarial` | adversarial | False premise; gold is "Not mentioned in the conversation" (cat 5, 446) |

Comparable protocol (Mem0 paper harness, reused by Zep, Memobase, MemOS, LangMem):
- Answer and judge prompts are Mem0's, verbatim (`locomo/prompts.ts`), for every provider; providers only format their search results.
- Run with `-m gpt-5 -j gpt-5` (answering and judging).
- 30 results per search for every provider.
- The headline score leaves out adversarial (1,540 questions); adversarial is still scored and reported per type.
- Each conversation is ingested once into one container shared by its questions. Photo captions are part of the message text, as in LoCoMo's own evaluation.

### LongMemEval
| Type | Alias | Description |
|------|-------|-------------|
| `single-session-user` | ss-user | Single-session user facts |
| `single-session-assistant` | ss-asst | Single-session assistant facts |
| `single-session-preference` | ss-pref | Single-session preferences |
| `multi-session` | multi | Multi-session reasoning |
| `temporal-reasoning` | temporal | Temporal reasoning |
| `knowledge-update` | update | Knowledge update tracking |

### ConvoMem
| Type | Alias | Description |
|------|-------|-------------|
| `user_evidence` | user | User-stated facts |
| `assistant_facts_evidence` | asst | Assistant-stated facts |
| `preference_evidence` | pref | User preferences |
| `changing_evidence` | change | Information updates |
| `implicit_connection_evidence` | implicit | Implicit reasoning |
| `abstention_evidence` | abstain | Unanswerable questions |

### BEAM
| Type | Alias | Description |
|------|-------|-------------|
| `abstention` | ab | The chat never says |
| `contradiction_resolution` | cr | Conflicting statements |
| `event_ordering` | eo | Order of events |
| `information_extraction` | ie | Specific facts |
| `instruction_following` | if | Standing instructions |
| `knowledge_update` | ku | Changed facts |
| `multi_session_reasoning` | msr | Facts across sessions |
| `preference_following` | pf | Stated preferences |
| `summarization` | sum | Summaries |
| `temporal_reasoning` | tr | Dates and durations |

Oracle setup: a question's haystack is only the chat turns BEAM cites as its evidence (`source_chat_ids`). Build the data once from the BEAM 1M parquet:

```
uv run --with pyarrow scripts/prepare-beam-oracle.py --parquet <BEAM 1M parquet>
uv run --with pyarrow scripts/prepare-beam-oracle.py --parquet <BEAM 1M parquet> --chats 5,6,13 --per-type 5 --out data/benchmarks/beam/1M/oracle-shared-c5-6-13.json
```

- The first writes `data/benchmarks/beam/1M/oracle.json`: one container per question. The second writes a subset whose questions share one container holding all their evidence; point `BEAM_DATA_PATH` at it.
- Each session is one user/assistant turn pair, ingested with its real date. Questions carry the date of the chat's last session as their question date.
- Some chats restart message ids partway through; evidence ids map to the first occurrence.
- Scoring follows the BEAM paper (Appendix H): each rubric item is judged 0, 0.5 or 1 (Listing 20) and the question score is the mean; event ordering is the normalized Kendall tau-b of the predicted order (Listing 21 matches events). The report's `macroMeanScore` averages the 10 type means. A question passes at 0.5. Use `-j gpt-4.1-mini`, the paper's judge.
- The answer prompt is the one Mem0's BEAM runner uses (evidence sorted oldest first, with dates), plus a one-event-per-line rule for event ordering.

Related run options:
- `run --source-run <ingested run> -r <new run>` reuses another run's ingested containers and redoes search onwards, so search settings (`--provider-config '{"searchMode":"memories","limit":20}'`) can be compared on the same memories.
- `run --answer-mode agentic` lets the answering model search through tools (search with its own settings, plus the profile); `agentic-memories` limits it to memories and the profile.
- `MEMORYBENCH_INDEXING_TIMEOUT_MINUTES` counts documents still not ready after that long as failed, so one stuck document can't hold up a run.
