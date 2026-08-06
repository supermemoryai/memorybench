# Benchmarks

Benchmark dataset adapters. Each benchmark implements the `Benchmark` interface.

## Interface

```typescript
interface Benchmark {
    name: string
    scope: BenchmarkScope
    protocol: BenchmarkProtocol
    load(config?: BenchmarkConfig): Promise<void>
    getQuestions(filter?: QuestionFilter): UnifiedQuestion[]
    getHaystackSessions(questionId: string): UnifiedSession[]
    getGroundTruth(questionId: string): string
    getQuestionTypes(): QuestionTypeRegistry
    getIngestionGroupId?(questionId: string): string
    getDatasetIdentity?(): DatasetIdentity | undefined
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
- `protocol` - Own ingestion formatting, retrieval, answer formatting, evaluation, and aggregation
- `getIngestionGroupId()` - Optional shared-build hint; the orchestrator independently fingerprints
  every member's ordered provider-visible haystack before accepting the group

## Existing Benchmarks

| Benchmark | Source | Description |
|-----------|--------|-------------|
| `locomo` | GitHub snap-research/locomo | Long context memory benchmark |
| `longmemeval` | HuggingFace xiaowu0162/longmemeval-cleaned | Long-term memory evaluation |
| `convomem` | HuggingFace Salesforce/ConvoMem | Conversational memory benchmark |
| `beam-1m` / `beam-10m` / `beam-1m-10m` | Pinned Hugging Face BEAM repositories | Supported BEAM public 1M/10M tiers |

## Question Types

### LoCoMo
| Type | Alias | Description |
|------|-------|-------------|
| `single-hop` | single | Single-hop fact recall |
| `multi-hop` | multi | Multi-hop reasoning |
| `temporal` | temporal | Temporal reasoning |
| `world-knowledge` | world | Commonsense knowledge |
| `adversarial` | adversarial | Unanswerable questions |

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

### BEAM 1M/10M

BEAM does not download silently during a run. Prepare an immutable, hashed snapshot first:

```bash
bun run src/index.ts beam prepare --tiers 1M,10M
```

The converter verifies the pinned Parquet hashes, validates 35 chats / 700 questions for 1M and
10 chats / 200 questions for 10M, requires 20 questions and all ten abilities per chat, and fails
closed on missing or malformed data. Use `--dataset-revision <fingerprint>` for a pinned run.

The pinned 10M rows store each `turns[]` item as a variable-length alternating message block, not
as one message pair. The converter deterministically splits every complete block into strict
user/assistant sessions. The reviewed revision also contains exactly two incomplete blocks:
`10M:1:plan-7:batch-10:source-turn-19` and
`10M:2:plan-7:batch-8:source-turn-51`. Each ends with a literal `followup_question` user message
whose assistant response is absent. Matching the authors' pinned `pair_chunk` behavior in
`src/answer_probing_questions/long_term_memory_methods.py`, only those two stable source identities
receive an `ASSISTANT: N/A` placeholder. Canonical sessions mark the padding and the manifest records
its per-tier count. Any other odd, non-alternating, or identity-mismatched block fails closed.

The supported scope is explicitly BEAM 1M/10M, not every smaller tier in the paper. The paper score
and the additional `>= 0.5` pass accuracy are both reported; they are not interchangeable.
Only a complete validated tier is labeled with the official `beamScore` and is leaderboard-eligible.
Question-limited or sampled runs remain useful diagnostics but are labeled `beamScorePartial`.

BEAM ingestion is causal within each conversation: add one ordered user/assistant session, wait for
both document processing and memory dreaming/indexing to complete, durably checkpoint it, and only
then add the next session. Independent conversations still build concurrently. Supermemory requests
top-level `dreaming: "instant"`; readiness requires both `status` and `dreamingStatus` to be `done`.

For a deliberately non-paper comparison, `--evaluation-profile mem0-nugget` selects a separate
versioned protocol. It supports direct Top-K values through 100, a distinct answer cutoff, GPT-5 as
judge, mem0's nugget clamp, and nugget-average scoring for event-ordering questions. Reports use
`mem0NuggetAverage`, not `beamScore`. Its GPT-5 calls use Chat Completions with 4,096 completion
tokens, no temperature or reasoning-effort override, five outer attempts, and a 120-second per-attempt
deadline. Each outer attempt allows two inner transport retries. A direct K50 run is an ablation;
mem0's published Top-50 setup
retrieves 200 before applying cutoff 50, which is outside the current direct-search limit.
After five answer attempts exhaust without non-empty text, this profile alone checkpoints and
evaluates the empty answer, matching the pinned Mem0 runner; the paper and default protocols continue
to fail closed.

| Type | Alias | Description |
|------|-------|-------------|
| `abstention` | abstain | Withhold answers when evidence is missing |
| `contradiction_resolution` | contradict | Detect and reconcile inconsistent statements |
| `event_ordering` | order | Reconstruct event or information order |
| `information_extraction` | extract | Recall entities and factual details |
| `instruction_following` | instruction | Follow sustained user instructions |
| `knowledge_update` | update | Retain updated facts over stale facts |
| `multi_session_reasoning` | multi | Reason across non-adjacent dialogue segments |
| `preference_following` | preference | Adapt to evolving user preferences |
| `summarization` | summary | Summarize dialogue content |
| `temporal_reasoning` | temporal | Reason about explicit and implicit time relations |
