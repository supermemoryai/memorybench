# BABILong

This benchmark adapter loads the BABILong evaluation dataset from local JSON files and feeds it into the standard MemoryBench pipeline.

## Data layout

Download the BABILong dataset from Hugging Face:

https://huggingface.co/datasets/RMT-team/babilong

Extract the dataset so the directory structure looks like:

```text
data/benchmarks/babilong/
  qa1/
    0k.json
  qa2/
    0k.json
  qa3/
    0k.json
  ...
  qa20/
    0k.json
```

The adapter currently loads the `0k.json` evaluation split from every `qa1`–`qa20` task.

Each task contains 100 evaluation samples.

## Dataset format

Each sample follows the native BABILong format:

```json
{
  "input": "John travelled to the hallway. Mary journeyed to the bathroom...",
  "question": "Where is Mary?",
  "target": "bathroom"
}
```

The adapter maps each sample to:

- one `UnifiedSession` containing the document (`input`)
- one benchmark question (`question`)
- one ground-truth answer (`target`)

## List questions

```bash
bun run src/index.ts list-questions -b babilong -l 10
```

Filter by task:

```bash
bun run src/index.ts list-questions -b babilong -t qa7 -l 10
```

## Ingest into a provider

Example using Supermemory:

PowerShell:

```powershell
$env:SUPERMEMORY_API_KEY = "sm_xxx"
bun run src/index.ts ingest -p supermemory -b babilong -r babilong-smoke --force
```

Bash:

```bash
SUPERMEMORY_API_KEY=sm_xxx \
bun run src/index.ts ingest \
  -p supermemory \
  -b babilong \
  -r babilong-smoke \
  --force
```

## Search after ingest

```bash
bun run src/index.ts search -r babilong-smoke
```

Search results are written to:

```text
data/runs/babilong-smoke/results/
```

## What gets ingested

For every BABILong sample, the adapter creates:

- one session containing the complete document (`input`)
- one benchmark question (`question`)
- one ground-truth answer (`target`)

This preserves the original long-context retrieval task while using the standard MemoryBench evaluation pipeline.

## Benchmark

BABILong evaluates long-context retrieval and reasoning by embedding a small set of supporting facts inside large amounts of irrelevant text.

The benchmark contains 20 reasoning tasks (`qa1`–`qa20`) covering skills such as:

- single supporting fact
- multi-hop reasoning
- counting
- negation
- coreference
- deduction
- induction
- positional reasoning
- path finding

The adapter keeps the original task names as MemoryBench question types, allowing individual reasoning capabilities to be benchmarked independently.