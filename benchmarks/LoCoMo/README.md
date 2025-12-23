# LoCoMo Benchmark

LoCoMo (Long-Term Conversational Memory) is a large-scale, multimodal benchmark designed to evaluate the long-term conversational memory capabilities of LLMs and memory-augmented agents.

## Overview

LoCoMo tests a system's ability to remember and reason about information across very long conversations spanning multiple sessions. Each conversation contains:

- **~300 turns** across **up to 35 sessions**
- **~9K tokens** on average per conversation
- Questions spanning three categories:
  - **Category 1: Factual** - Direct fact retrieval
  - **Category 2: Temporal** - Time-based reasoning
  - **Category 3: Reasoning** - Inference and deduction

## Dataset

The benchmark uses `locomo10.json`, which contains 10 conversation samples with a total of ~2000 questions.

### Data Structure

Each sample includes:
- `sample_id`: Unique identifier
- `conversation`: Multi-session dialogue history
  - `speaker_a`, `speaker_b`: Participant names
  - `session_N`: Array of conversation messages
  - `session_N_date_time`: Timestamp for each session
- `qa`: Array of question-answer pairs with:
  - `question`: The question text
  - `answer`: Ground truth answer
  - `category`: Question category (1, 2, or 3)
  - `evidence`: Reference to source in conversation

## Running LoCoMo

### Basic Usage

```bash
bun run benchmark LoCoMo <provider> --runId=<run-id>
```

### Examples

**Test with first sample:**
```bash
bun run benchmark LoCoMo supermemory --runId=test --limit=1
```

**Run all 10 samples:**
```bash
bun run benchmark LoCoMo supermemory --runId=full-run
```

**Use different evaluation methods:**
```bash
# Default: exact match (fast, no LLM judge needed)
bun run benchmark LoCoMo supermemory --runId=test --evalMethod=exact

# F1 score (token overlap)
bun run benchmark LoCoMo supermemory --runId=test --evalMethod=f1

# LLM-as-a-judge (slower, more expensive)
bun run benchmark LoCoMo supermemory --runId=test --evalMethod=llm --judgeModel=gpt-4o
```

**Use different answering models:**
```bash
bun run benchmark LoCoMo supermemory --runId=test --answeringModel=gpt-4o
bun run benchmark LoCoMo supermemory --runId=test --answeringModel=claude-3-5-sonnet-20241022
```

**Skip phases:**
```bash
# Skip ingestion (use existing data)
bun run benchmark LoCoMo supermemory --runId=test --skipIngest

# Only evaluate (requires previous search results)
bun run benchmark LoCoMo supermemory --runId=test --skipIngest --skipSearch
```

## Available Options

| Option | Description | Default |
|--------|-------------|---------|
| `--runId=<id>` | Unique identifier for this run | `locomo-{timestamp}` |
| `--limit=<N>` | Process only first N samples | All samples (10) |
| `--startPosition=<N>` | Start at sample N | 1 |
| `--endPosition=<N>` | End at sample N | 10 |
| `--answeringModel=<model>` | LLM for generating answers | `gpt-4o` |
| `--evalMethod=<method>` | Evaluation method: `exact`, `f1`, or `llm` | `exact` |
| `--judgeModel=<model>` | LLM for judging (only used when evalMethod=llm) | `gpt-4o` |
| `--topK=<N>` | Number of context chunks to retrieve | 5 |
| `--sessionDelay=<ms>` | Delay between session ingestions | 10000 |
| `--skipIngest` | Skip ingestion phase | false |
| `--skipSearch` | Skip search phase | false |
| `--skipEvaluate` | Skip evaluation phase | false |

## Supported Providers

- **supermemory** - Supermemory API provider
- **mem0** - Mem0 memory system provider
- **zep** - Zep long-term memory store provider

## Pipeline Phases

### Phase 1: Ingestion
Uploads conversation sessions to the memory provider. Each session is formatted with:
- Date/time metadata
- Participant names
- Full conversation text with speaker labels
- Image metadata (if present)

**Checkpoint:** `benchmarks/LoCoMo/checkpoints/ingest/session/checkpoint-{sampleId}-{runId}.json`

### Phase 2: Search
For each question, retrieves the top-K most relevant context chunks from the memory provider.

**Checkpoint:** `benchmarks/LoCoMo/checkpoints/search/search-{sampleId}-{runId}.json`

### Phase 3: Evaluation
Uses LLM-as-a-judge to evaluate answer quality:
1. **Answering Model** generates an answer from retrieved context
2. **Judge Model** compares generated answer to ground truth

**Output:** `benchmarks/LoCoMo/evaluations/eval-{runId}-{model}.json`

## Evaluation Results

Results are saved in JSON format with:

```json
{
  "metadata": {
    "runId": "test",
    "model": "gpt-4o",
    "evaluatedAt": "2025-12-21T...",
    "totalQuestions": 199,
    "correctAnswers": 150,
    "accuracy": "75.38%"
  },
  "byCategory": [
    {
      "category": 1,
      "categoryName": "Factual",
      "correct": 80,
      "total": 100,
      "accuracy": "80.00%"
    },
    ...
  ],
  "evaluations": [...]
}
```

## Checkpointing

All phases support automatic checkpointing, allowing you to resume from failures:

- **Session-level** (ingest): Each conversation session tracked separately
- **Question-level** (search): Each question search saved incrementally
- **Evaluation-level** (evaluate): Each answer evaluation saved incrementally

To resume a failed run, simply re-run with the same `--runId`.

## Research Background

LoCoMo was introduced by Snap Research to evaluate very long-term conversational memory of LLM agents. The benchmark focuses on:

- Multi-session temporal reasoning
- Long-range fact retention
- Causal understanding across sessions
- Multimodal dialogue comprehension

For more details, see the [official paper](https://arxiv.org/abs/2402.17753) and [project page](https://snap-research.github.io/locomo/).

## Performance Tips

1. **Start small**: Use `--limit=1` to test with a single sample first
2. **Use checkpointing**: If a run fails, restart with the same `runId`
3. **Adjust delays**: Reduce `--sessionDelay` if your API allows higher rate limits
4. **Monitor costs**: Each sample has ~199 questions, requiring ~199 API calls per phase
