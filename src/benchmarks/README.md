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
