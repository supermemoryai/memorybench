# LongMemEval-V2

This benchmark adapter loads LongMemEval-V2 web-agent trajectory data from local files and feeds it into the normal MemoryBench pipeline.

## Data layout

Place the downloaded dataset here:

```text
data/benchmarks/longmemeval-v2/
  questions.jsonl
  trajectories.jsonl
  haystacks/
    lme_v2_small.json
    lme_v2_medium.json
```

If you already downloaded the dataset into the sibling scratch folder used during local testing, copy it from the MemoryBench repo root with:

```powershell
Copy-Item -Recurse ..\memory-bench\data\longmemeval-v2 data\benchmarks\longmemeval-v2
```

The adapter reads `LONGMEMEVAL_V2_TIER` or `LME_V2_TIER` to choose the haystack tier. If neither is set, it uses `small`.

## Ingest one question into Supermemory

PowerShell:

```powershell
$env:SUPERMEMORY_API_KEY = "sm_xxx"
$env:LONGMEMEVAL_V2_TIER = "small"
bun run src/index.ts ingest -p supermemory -b longmemeval-v2 -r lme-v2-01307e07 -q 01307e07 --force
```

Bash:

```bash
SUPERMEMORY_API_KEY=sm_xxx \
LONGMEMEVAL_V2_TIER=small \
bun run src/index.ts ingest \
  -p supermemory \
  -b longmemeval-v2 \
  -r lme-v2-01307e07 \
  -q 01307e07 \
  --force
```

That creates one MemoryBench checkpoint and a Supermemory container tag for the question. The container tag is stored in `data/runs/lme-v2-01307e07/checkpoint.json` and follows:

```text
<questionId>-<dataSourceRunId>
```

## Limit trajectories while preserving haystack order

Use the full official haystack while ingesting only the first ordered trajectories for each selected question:

```bash
LONGMEMEVAL_V2_TIER=small \
bun run src/index.ts ingest \
  -p supermemory \
  -b longmemeval-v2 \
  -r lme-v2-first-trajectory \
  -q 01307e07 \
  --trajectory-limit 1
```

`--trajectory-limit` limits trajectories, while `--limit` limits questions. The trajectory limit is saved in the checkpoint so resumed ingestion keeps the same selection.

## Ingest one trajectory document at a time

Use a unique run ID for each document and reuse one explicit container tag. This keeps every document independently checkpointed while accumulating them in one provider container.

Start with the first trajectory's overview only:

```bash
LONGMEMEVAL_V2_TIER=small \
bun run src/index.ts ingest \
  -p supermemory \
  -b longmemeval-v2 \
  -r lme-v2-f224a4eb-overview-v1 \
  -q 01307e07 \
  --trajectory-limit 1 \
  --document overview \
  --container-tag lme-v2-f224a4eb-sequential-v1
```

Later, ingest a single state into the same container by changing the run ID and document selector while retaining the container tag:

```bash
LONGMEMEVAL_V2_TIER=small \
bun run src/index.ts ingest \
  -p supermemory \
  -b longmemeval-v2 \
  -r lme-v2-f224a4eb-state-0-v1 \
  -q 01307e07 \
  --trajectory-limit 1 \
  --document state:0 \
  --container-tag lme-v2-f224a4eb-sequential-v1
```

`--document overview` selects only the overview session. `--document state:<index>` selects only that state. With `--trajectory-limit 1` and one question, each command ingests exactly one document.

## Clean trajectory payloads

Use `--trajectory-format clean` to create a causally separated payload:

- overview (`STATE_-1`): goal and starting context only
- states (`STATE_0` onward): URL, action, thought, and screenshot path, without the repeated goal, final outcome, compact accessibility extraction, or raw accessibility tree
- result (`RESULT`): the final trajectory outcome exactly once

Every document carries numeric `stateIndex` metadata using its real position: overview `-1`, states `0` onward, and result after the last state. To retrieve information available before state `x`, apply a numeric metadata filter of `stateIndex <= x - 1`.

Use `--trajectory-format clean-tree` for the same goal/outcome separation while including the accessibility information exactly like the raw format: a compact UI extraction plus the normally truncated accessibility-tree excerpt. This mode uses filtered writes so state `x` only receives memories sourced from state `x - 1`, waits for indexing, and then waits another 60 seconds before submitting the next document.

```bash
LONGMEMEVAL_V2_TIER=small \
bun run src/index.ts ingest \
  -p supermemory \
  -b longmemeval-v2 \
  -r lme-v2-f224a4eb-clean-v1 \
  -q 01307e07 \
  --trajectory-limit 1 \
  --trajectory-format clean \
  --container-tag test_unraw_16_07_26
```

## Search after ingest

PowerShell:

```powershell
$env:SUPERMEMORY_API_KEY = "sm_xxx"
$env:LONGMEMEVAL_V2_TIER = "small"
bun run src/index.ts search -r lme-v2-01307e07
```

Bash:

```bash
SUPERMEMORY_API_KEY=sm_xxx \
LONGMEMEVAL_V2_TIER=small \
bun run src/index.ts search -r lme-v2-01307e07
```

Search results are written under:

```text
data/runs/lme-v2-01307e07/results/<questionId>.json
```

## Ingest a smoke subset by count

PowerShell:

```powershell
$env:SUPERMEMORY_API_KEY = "sm_xxx"
$env:LONGMEMEVAL_V2_TIER = "small"
bun run src/index.ts ingest -p supermemory -b longmemeval-v2 -r lme-v2-small-1 -l 1 --force
```

## What gets ingested

For every trajectory in a question's haystack, the adapter creates:

- one trajectory overview session with the goal, outcome, start URL, and action/thought trace
- one state session per trajectory state with URL, action, thought, screenshot path, compact UI labels/options, and a bounded accessibility-tree excerpt

This keeps high-signal UI labels such as dropdown options searchable without requiring MemoryBench to store screenshots in this text-first pipeline.
