# InfiniteBench

This benchmark adapter loads the InfiniteBench evaluation dataset from local JSONL files and feeds it into the standard MemoryBench pipeline.

## Data layout

Download the InfiniteBench dataset from Hugging Face:

https://huggingface.co/datasets/xinrongzhang2022/InfiniteBench

Place the dataset files under:

```text
data/benchmarks/infinitebench/
  passkey.jsonl
  kv_retrieval.jsonl
  number_string.jsonl
  code_run.jsonl
  code_debug.jsonl
  math_find.jsonl
  math_calc.jsonl
  longdialogue_qa_eng.jsonl
  longbook_qa_eng.jsonl
  longbook_sum_eng.jsonl
  longbook_choice_eng.jsonl
  longbook_qa_chn.jsonl
```

The adapter automatically loads every supported task.

## Dataset format

Every sample follows the same schema:

```json
{
  "id": 0,
  "context": "...",
  "input": "...",
  "answer": ["..."],
  "options": []
}
```

The adapter maps each sample to:

- one `UnifiedSession` containing the long context (`context`)
- one benchmark question (`input`)
- one ground-truth answer (`answer[0]`)

Multiple-choice options (when present) are preserved as metadata.

## Supported tasks

The adapter currently supports:

- passkey
- kv_retrieval
- number_string
- code_run
- code_debug
- math_find
- math_calc
- longdialogue_qa_eng
- longbook_qa_eng
- longbook_sum_eng
- longbook_choice_eng
- longbook_qa_chn

Each task is exposed as a native MemoryBench question type.

## List questions

```bash
bun run src/index.ts list-questions -b infinitebench -l 10
```

Filter by task:

```bash
bun run src/index.ts list-questions -b infinitebench -t passkey -l 10
```

Example:

```bash
bun run src/index.ts list-questions -b infinitebench -t code_debug -l 5
```

## Ingest into a provider

Example using Supermemory.

PowerShell:

```powershell
$env:SUPERMEMORY_API_KEY = "sm_xxx"
bun run src/index.ts ingest -p supermemory -b infinitebench -r infinitebench-smoke --force
```

Bash:

```bash
SUPERMEMORY_API_KEY=sm_xxx \
bun run src/index.ts ingest \
  -p supermemory \
  -b infinitebench \
  -r infinitebench-smoke \
  --force
```

## Search after ingest

```bash
bun run src/index.ts search -r infinitebench-smoke
```

Search results are written to:

```text
data/runs/infinitebench-smoke/results/
```

## What gets ingested

For every InfiniteBench sample, the adapter creates:

- one session containing the complete context (`context`)
- one benchmark question (`input`)
- one ground-truth answer (`answer[0]`)

This preserves the original long-context evaluation task while using the standard MemoryBench evaluation pipeline.

## Benchmark

InfiniteBench is a long-context benchmark designed to evaluate language models on contexts averaging over 100K tokens.

The benchmark contains a diverse collection of retrieval, reasoning, mathematical, code understanding, dialogue, and long-document comprehension tasks, including:

- passkey retrieval
- key-value retrieval
- number string retrieval
- code execution
- code debugging
- mathematical reasoning
- long dialogue question answering
- long book question answering
- long book summarization
- multiple-choice book comprehension
- Chinese long book question answering

The adapter preserves the original task names as MemoryBench question types, allowing each long-context capability to be evaluated independently.