# LongMemEval Benchmark

## Configuration

The benchmark requires the following environment variables to be set:

- `SUPERMEMORY_API_KEY`: Your Supermemory API key.
- `SUPERMEMORY_API_URL`: (Optional) API base URL, defaults to `https://api.supermemory.ai`.
- `GOOGLE_VERTEX_PROJECT_ID`: Project ID for Google Vertex AI (required for evaluation).
- `GOOGLE_CLIENT_EMAIL`: Google Service Account email (required for evaluation).
- `GOOGLE_PRIVATE_KEY`: Google Service Account private key (required for evaluation).

You can set these in your shell or environment before running the scripts.

## Setup

1.  **Download the Dataset**:
    *   Download `longmemeval_s_cleaned.json` from [HuggingFace](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned).
    *   Place it in `memorybench/benchmarks/LongMemEval/datasets/`.

2.  **Generate Questions**:
    *   Run the split script to generate individual question files:
    ```bash
    bun run scripts/setup/split_questions.ts
    ```
    This will populate `datasets/questions/`.

3.  **Install Dependencies**:
    *   Ensure all project dependencies are installed via `bun install`.

## Ingestion

To ingest questions, use the scripts in `scripts/ingest/`.

### Single Question

From `memorybench/benchmarks/LongMemEval`:
```bash
bun run scripts/ingest/ingest.ts <questionId> <runId>
```

### Batch Ingestion

From `memorybench/benchmarks/LongMemEval`:
```bash
./scripts/ingest/ingest-batch.sh --runId=<runId> --questionType=<questionType> --startPosition=<startPos> --endPosition=<endPos>
```

## Search

To search questions, use the scripts in `scripts/search/`.

### Single Question

From `memorybench/benchmarks/LongMemEval`:
```bash
bun run scripts/search/search.ts <questionId> <runId>
```

### Batch Search

From `memorybench/benchmarks/LongMemEval`:
```bash
./scripts/search/search-batch.sh --runId=<runId> [--questionType=<questionType>] [--startPosition=<startPos>] [--endPosition=<endPos>]
```

## Evaluation

To evaluate results, use the scripts in `scripts/evaluate/`.

### Single Run Evaluation

From `memorybench/benchmarks/LongMemEval`:

```bash
bun run scripts/evaluate/evaluate.ts <runId> [answeringModel]
```

Examples:
```bash
bun run scripts/evaluate/evaluate.ts run1 gpt-4o
bun run scripts/evaluate/evaluate.ts run1 gpt-5
bun run scripts/evaluate/evaluate.ts run1 gemini-3-pro-preview
```

All evaluations use `gpt-4o` as the fixed "gold standard" judge.

### Batch Evaluation

From `memorybench/benchmarks/LongMemEval`:

```bash
./scripts/evaluate/evaluate-batch.sh --runId=<runId> --answeringModel=<model> [--questionType=<questionType>] [--startPosition=<startPos>] [--endPosition=<endPos>]
```

## Available Question Types

- single-session-user
- single-session-assistant
- single-session-preference
- knowledge-update
- temporal-reasoning
- multi-session

## Directory Structure

- `datasets/longmemeval_s_cleaned.json`: The raw dataset (download from HF).
- `datasets/questions/`: Individual question JSON files (generated).
- `scripts/`: Scripts for ingestion, search, and evaluation.
- `scripts/utils/`: Shared utilities (config, checkpointing).
- `checkpoints/ingest/session/`: Session-level ingestion checkpoints.
- `checkpoints/ingest/batch/`: Batch ingestion checkpoints.
- `checkpoints/search/batch/`: Batch search checkpoints.
- `results/`: Search results.
- `evaluations/`: Evaluation results.
