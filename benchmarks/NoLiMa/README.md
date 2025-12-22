# NoLiMa Benchmark

NoLiMa (Long-Context Evaluation Beyond Literal Matching) is a semantic needle-in-a-haystack benchmark that tests memory providers' ability to retrieve information when questions and needles have minimal lexical overlap.

## Overview

Unlike traditional needle-in-a-haystack tests that allow models to exploit literal word matching, NoLiMa requires **genuine semantic understanding** to locate relevant information within long contexts.

### What NoLiMa Tests

- **Semantic retrieval** without lexical cues
- **Long-context understanding** (1K to 32K tokens)
- **Performance degradation** as context length increases
- **Retrieval robustness** under challenging conditions

### Key Metrics

1. **Overall Accuracy**: Percentage of correctly answered questions
2. **Base Score**: Accuracy at shortest context (1K tokens)
3. **Effective Length**: Longest context maintaining ≥85% of base score
4. **Retrieval Rate**: Percentage of times the needle was successfully retrieved

## Dataset

The benchmark includes:
- **10 needle sets** with reasoning types (world knowledge, logical inference, etc.)
- **Multiple variants**: standard, hard, multiple-choice, CoT, distractor
- **5 context lengths**: 1K, 4K, 8K, 16K, 32K tokens
- **Shuffled haystacks**: Literary texts with needles embedded at random positions

## Running NoLiMa

### Basic Usage

```bash
bun run benchmark NoLiMa <provider> --runId=<run-id>
```

### Examples

**Quick test (10 test cases):**
```bash
bun run benchmark NoLiMa supermemory --runId=test --limit=10
```

**Full run (all test cases):**
```bash
bun run benchmark NoLiMa supermemory --runId=full
```

**Different needle sets:**
```bash
# Use the hard needle set
bun run benchmark NoLiMa supermemory --runId=hard --needleSetType=hard

# Use multiple-choice format
bun run benchmark NoLiMa supermemory --runId=mc --needleSetType=mc
```

**Different models:**
```bash
bun run benchmark NoLiMa supermemory --runId=test \
  --answeringModel=gpt-4o \
  --judgeModel=gpt-4o
```

**Skip phases:**
```bash
# Skip ingestion (use existing data)
bun run benchmark NoLiMa supermemory --runId=test --skipIngest

# Only evaluate (requires previous search results)
bun run benchmark NoLiMa supermemory --runId=test --skipIngest --skipSearch
```

## Available Options

| Option | Description | Default |
|--------|-------------|---------|
| `--runId=<id>` | Unique identifier for this run | `nolima-{timestamp}` |
| `--limit=<N>` | Process only first N test cases | All test cases |
| `--needleSetType=<type>` | Needle set variant to use | `standard` |
| `--answeringModel=<model>` | LLM for generating answers | `gpt-4o` |
| `--judgeModel=<model>` | LLM for evaluating answers | `gpt-4o` |
| `--topK=<N>` | Number of context chunks to retrieve | 5 |
| `--skipIngest` | Skip ingestion phase | false |
| `--skipSearch` | Skip search phase | false |
| `--skipEvaluate` | Skip evaluation phase | false |

### Needle Set Types

- `standard` - Standard needle set (default)
- `hard` - 10 most challenging needles
- `mc` - Multiple-choice format
- `direct` - Direct questions only
- `cot` - Chain-of-thought prompts
- `distractor` - Includes distractor information

## Supported Providers

- **supermemory** - Supermemory API provider
- **mem0** - Mem0 memory system provider
- **zep** - Zep long-term memory store provider

## Pipeline Phases

### Phase 1: Ingestion
Ingests haystacks with embedded needles at various context lengths. Each test case includes:
- Target context length (1K, 4K, 8K, 16K, 32K tokens)
- Haystack text from literary sources
- Needle embedded at random position
- Question requiring semantic understanding

**Checkpoint:** `benchmarks/NoLiMa/checkpoints/ingest/ingest-{runId}.json`

### Phase 2: Search
For each test case, searches for information to answer the question. Tracks:
- Retrieved context (top-K chunks)
- Whether the needle was retrieved
- Context length of the test

**Checkpoint:** `benchmarks/NoLiMa/checkpoints/search/search-{runId}.json`

### Phase 3: Evaluation
Uses LLM-as-a-judge to evaluate answer quality and calculate NoLiMa metrics:
1. **Answering Model** generates answer from retrieved context
2. **Judge Model** determines if answer matches expected character name
3. **Metrics calculated**: Overall accuracy, base score, effective length

**Output:** `benchmarks/NoLiMa/evaluations/eval-{runId}-{model}.json`

## Evaluation Results

Results are saved in JSON format with:

```json
{
  "metadata": {
    "runId": "test",
    "providerName": "supermemory",
    "answeringModel": "gpt-4o",
    "judgeModel": "gpt-4o",
    "needleSetType": "standard",
    "evaluatedAt": "2025-12-21T..."
  },
  "summary": {
    "totalTests": 100,
    "correctAnswers": 75,
    "overallAccuracy": 75.0,
    "baseScore": 95.0,
    "effectiveLength": 16000
  },
  "byContextLength": [
    {
      "contextLength": 1000,
      "totalTests": 20,
      "correctAnswers": 19,
      "accuracy": 95.0,
      "retrievalRate": 100.0
    },
    ...
  ],
  "evaluations": [...]
}
```

### Interpreting Results

- **Base Score**: Performance at 1K tokens (baseline capability)
- **Effective Length**: Maximum context where performance stays ≥85% of baseline
  - Higher = better long-context capability
  - `null` means performance dropped below threshold at all lengths
- **Retrieval Rate**: Percentage of times the needle was found in search results
  - Low retrieval rate indicates search quality issues
  - High retrieval + low accuracy indicates answer generation issues

## Checkpointing

All phases support automatic checkpointing:
- **Ingestion**: Tracks which test cases have been ingested
- **Search**: Saves search results incrementally
- **Evaluation**: Saves evaluation results after each batch

To resume a failed run, simply re-run with the same `--runId`.

## Performance Tips

1. **Start with --limit=10**: Test with small subset first
2. **Monitor retrieval rate**: Low rate indicates provider struggles with semantic search
3. **Compare context lengths**: Identify where performance degrades
4. **Use checkpointing**: Resume from failures without losing progress

## Research Background

NoLiMa was introduced by Adobe Research (ICML 2025) to evaluate whether LLMs can retrieve relevant information from long contexts when they cannot rely on literal word matching.

**Key Findings**:
- Most LLMs show significant performance drops as context length increases
- GPT-4o: 99.3% at short contexts → 69.7% at 32K tokens
- Attention mechanisms struggle with semantic retrieval in extended contexts

## Citation

```bibtex
@inproceedings{modarressi2025nolima,
  title={NoLiMa: Long-Context Evaluation Beyond Literal Matching},
  author={Modarressi, Ali and others},
  booktitle={Proceedings of the 42nd International Conference on Machine Learning},
  pages={44554--44570},
  year={2025},
  organization={PMLR}
}
```

## Sources

- [GitHub Repository](https://github.com/adobe-research/NoLiMa)
- [HuggingFace Dataset](https://huggingface.co/datasets/amodaresi/NoLiMa)
- [ICML 2025 Paper](https://proceedings.mlr.press/v267/modarressi25a.html)
- [ArXiv](https://arxiv.org/abs/2502.05167)
