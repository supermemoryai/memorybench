# DolphinBench

[DolphinBench](https://github.com/mem0ai/dolphinbench) tests memory through actions: an agent reads ~13.5k dated messages from three personas, then completes 600 tasks in simulated apps (email, calendar, ordering, etc.) that only succeed if it remembered the right things.

memorybench runs it with DolphinBench's own runner, simulated apps, grader and submission format (pinned to `81cb6f84`), and supplies the agent and the memory backend. There are two agents:

- **memorybench's own loop** (`mb_harness`): a plain tool-calling loop, the same for every memory provider, so results compare memory systems under one harness. Faster and cheaper to run.
- **Hermes** (`mb_hermes`): DolphinBench's reference agent, which its published results use, with the provider's Hermes plugin. Use this to compare against those results.

## How it works

| Phase | What happens |
| --- | --- |
| Ingestion | Each history message goes, unchanged, to the agent in a fresh conversation. Memory recall runs before the agent replies. The conversation is then saved to memory as one document dated with the message's own date. Personas run in parallel, each one's history in order. |
| Freeze | Waits until every saved document has finished memory processing, then fingerprints the stored documents and memories. |
| Tests | Fresh conversation and fresh app state per test. Memory is read-only: write calls raise in code, and evaluation refuses to start if the fingerprint changed. |
| Grading | DolphinBench's grader: deterministic checks plus Azure `gpt-5.6-sol` (medium) for semantic checks. A test passes only if every check passes. |

The agent is a plain tool-calling loop over OpenAI's Responses API (`"api": "responses"`, needed for gpt-5.6 reasoning with tools on OpenAI) or any Chat Completions endpoint (`"api": "chat"`, OpenAI or Azure), up to 60 model calls per conversation. Every response is recorded with its API-reported token usage.

### Supermemory configuration

- Hosted API (v5), one namespace per persona per run: `<namespace_prefix>-<run>-<persona>`.
- `profileBuckets` (name → description) are set on each namespace before its first conversation. Supermemory sorts memories into buckets while it forms them and doesn't backfill, and buckets can only be set on an existing namespace, so the driver creates it with a placeholder document, sets the buckets and removes the placeholder.
- `supportingContext` is sent with every stored conversation (which also sets it on the namespace), written for this task (an assistant acting for the user later). `{persona}` is replaced with the persona's name in it and in bucket descriptions.
- Each ingestion conversation is stored with the message's timestamp in Supermemory's `date` field. `capture: "conversation"` stores the user message and the reply; `"user"` stores only the user message.
- Recall before each agent turn: the markdown profile without the sections in `recall.profile_exclude` (by default the sampled "Recent Memories"), capped at `profile_max_chars`, plus the top `limit` hybrid results.
- Agent tools: `supermemory_search`, `supermemory_profile` (the full markdown profile), `supermemory_read_document`. In memorybench's own loop there are no write tools; memory is written only by capture during ingestion. (The Hermes plugin also has write tools; see below.)
- Search settings (`searchMode`, `limit`, `threshold`, `rerank`, `rewriteQuery`, `include`) and `dreaming` use the same keys as memorybench's `--provider-config` for Supermemory.

### Agent prompt

One system prompt for ingestion and tests: DolphinBench's reference persona line, generic working habits (today's date comes from the message, act rather than ask, explicit tool values, faithful and complete write-ups, latest state unless asked about an earlier time), and how Supermemory works for the agent. It is the same for every persona and test. As the driver contract asks, the dated request is the conversation's only user message, unchanged; recalled context goes in a separate system message.

### Configs

| File | Memory |
| --- | --- |
| `configs/supermemory-instant.json` | Supermemory, `dreaming: "instant"` |
| `configs/supermemory-dynamic.json` | Supermemory, `dreaming: "dynamic"` |
| `configs/none.json` | No memory, same agent and apps. This is the floor for this agent loop. |
| `configs/hermes-supermemory.json` | Supermemory instant settings, with Hermes as the agent (below) |

The configs use `gpt-5.6-luna` on OpenAI at its list price. For another model, set `base_url` and `prices_per_1m` (USD per 1M input, cached input and output tokens); cost reporting refuses to guess.

## Hermes with the Supermemory plugin

`configs/hermes-supermemory.json` runs the same benchmark with a different agent: Hermes, DolphinBench's reference harness, with the Supermemory memory plugin ([hermes-supermemory](https://github.com/supermemoryai/hermes-supermemory), installed unmodified as Hermes' bundled provider `plugins/memory/supermemory`) on hosted Supermemory. Runner, apps, grader, evidence, model, profile buckets and namespace scheme are the same as above; the agent loop changes, and with it recall, capture and the memory tools (the plugin's own). A run config picks its agent with `"adapter"` (`mb_hermes:HermesSupermemoryHarness`); configs without it use memorybench's own loop (`mb_harness`).

- Each history message and test is a fresh one-turn Hermes session (`hermes chat -q`), started by DolphinBench's own Hermes driver in its disposable Docker agent container: no host mounts, an environment allowlist, the apps reached over a bridge. Its trace capture, turn status, tool checks and retry rules apply unchanged.
- Hermes built-in memory and `session_search` stay on, as in every published condition. Built-in memory is read-only during tests (DolphinBench's own read-only flags), and each persona's Hermes profile is frozen and checked together with its Supermemory namespace.
- Toolsets as in the published Hermes runs: history messages run with DolphinBench's seed toolsets (`hermes-cli,dolphinbench-apps,memory,session_search,supermemory`); tests run with `dolphinbench-apps,memory,session_search,supermemory`, without `hermes-cli`, so the test agent has the test's scoped app tools (behind Hermes' `tool_search`/`tool_describe`/`tool_call`), `session_search` and the plugin's tools, and no terminal, file, skills, web, code or delegation tools.
- The plugin runs with its product defaults except for the benchmark's choices, written into each persona profile's `supermemory.json` (the plugin's own config file):
  - `container_tag`: the persona's namespace, `<namespace_prefix>-<run>-<persona>` in the plugin's tag form (non-alphanumerics become `_`).
  - `entity_context`: `memory.settings.supportingContext` with the persona's name filled in; the plugin sends it as `supportingContext` with every write (at most 1500 characters).
  - `memory.plugin_settings`, by `supermemory.json` key: `dreaming: "instant"`, `max_recall_results: 20`, `search_mode: "hybrid"`. The plugin recalls the full markdown profile plus those results before every turn (no section exclusion, caps or threshold).
  - `base_url` is not set: the plugin reaches the proxy through `SUPERMEMORY_BASE_URL`.
- The plugin stores each conversation as one document under its own id, `hermes_<Hermes session id>`, dated when it is written; with one-turn sessions that is one document per history message. Notes from `supermemory_store` and mirrored built-in memory writes are separate documents with ids Supermemory assigns; `supermemory_forget` forgets memories. Freeze lists the namespace, checks that every document the proxy saw stored is there, and waits for all of them; `reconcile` deletes what an interrupted message's attempts stored (from the proxy's on-disk journal, plus anything created in the namespace since it started that no other message stored) and puts back the built-in memory and app state saved before it.
- The container never holds the Supermemory key. A local proxy gives each interaction its own token, swaps in the real key, and pins the persona's namespace and the phase: during ingestion the plugin may store documents, forget memories, search, read the profile and open a document; during tests only the reads pass. The plugin has no read-only mode, so in tests its automatic capture gets 405, which it logs without failing the turn. DolphinBench's driver requires test sessions to offer no memory write tools, so under DolphinBench's read-only flag the shim leaves `supermemory_store`/`supermemory_forget` (and their kebab-case aliases) out of the offered tools, as DolphinBench's evaluation build does for its bundled provider. Only the request's content headers are forwarded. A conversation counts as captured only when the proxy saw Supermemory accept its document.
- A small shim inside the container (`mb_hermes_shim.py`) covers three things the driver contract needs and the plugin doesn't do: Hermes appends recalled memory to the user message, while the contract has the dated request as the only, unchanged user message, so the shim puts the same recalled block in Hermes' system prompt instead (the recorded trace is exactly what the model was sent); it hides the write tools in tests (above); and it writes DolphinBench's seed receipt, one per history message, when it sees the plugin's write of that conversation's document accepted (it wraps the plugin client's write call from outside; the plugin is not changed). The adapter checks each receipt against the proxy.
- Recording: each conversation is exported with DolphinBench's append-only rollout and its checks. One case is handled: on the Responses API, Hermes' post-response hook can record a reply without the text the model wrote alongside its tool calls, while the next request sends that text back to the model; the recorded reply takes it from there, so the transcript matches what the model wrote and saw. Tool calls, results and app state are never changed, and any other context change fails the export.
- Retries (the driver contract leaves them to the harness, with their evidence kept): an interaction is rerun only for infrastructure failures, never because of its answer, and grading runs only on the final attempt. When DolphinBench's recorder can't export a conversation Hermes completed (a recording error, context rewritten by Hermes' empty-reply nudge, invalid JSON such as duplicate keys, invalid messages), it is rerun up to 2 times; transient Hermes failures and Supermemory outages during a test are rerun within DolphinBench's retry limits (`DOLPHINBENCH_TEST_RETRIES`, `DOLPHINBENCH_SEED_RETRIES`). A test reruns on fresh app state and a fresh copy of the frozen profile; before a history message reruns, its built-in memory files and the ingestion app state go back to their pre-attempt snapshot and the Supermemory documents the failed attempt stored are deleted. Every attempt, retry and rollback is in the attempt journal (`output/hermes/attempts/`) and counted by `status`. When retries run out, the run stops for `reconcile` as before.
- Cost: every main-loop response's API-reported usage from the trace, plus Hermes' auxiliary calls (session titles) from its usage database, priced at `prices_per_1m`; memory at Supermemory's list prices from the proxy's record (retried and rolled-back attempts included). Hermes' own price table is not used.

Build the agent image from a commit of the Hermes checkout (only committed files go in; the Hermes and plugin commits are recorded for the run identity), then select it before preparing a run:

```bash
bun run src/index.ts dolphinbench hermes-image --source /path/to/hermes-agent [--ref <branch or commit>]
export DOLPHINBENCH_AGENT_IMAGE=sha256:...   # printed by the command above
```

Rebuild after any plugin change; a new image means a new run. The image ID is part of the run identity, and its build record has the plugin directory's git tree, which equals the plugin repository commit's tree when the plugin is installed unmodified.

Docker must be the local default daemon. On macOS the container reaches the proxy and the apps through `host.docker.internal` (the apps over an authenticated TCP bridge, since macOS sockets can't be mounted into containers); on Linux the apps use DolphinBench's socket bridge and the proxy listens on the `docker0` gateway. `MB_HERMES_BIND`, `MB_HERMES_ADVERTISE` and `MB_HERMES_APP_BRIDGE` (`unix` or `tcp`) override this.

```bash
bun run src/index.ts dolphinbench pilot dolphinbench/configs/hermes-supermemory.json --name hermes-p1 \
  --persona all --window 300 --grade --confirm-paid-calls
```

Environment: `OPENAI_API_KEY`, `SUPERMEMORY_API_KEY`, `DOLPHINBENCH_AGENT_IMAGE`, and the judge variables above. Hermes run files live in the run's `output/hermes/` (profiles, attempt journals, proxy journals, traces, logs, seed receipts, rollback snapshots). `status` also reports memory failures the plugin logged (recall, capture, tools), requests the proxy refused, and Hermes' auxiliary model calls.

## Requirements

`setup` builds DolphinBench's Python environment (`data/dolphinbench/.venv`, Python 3.12) from the pinned release's `requirements.txt` plus the driver's own dependency:

| Package | Version | Used by |
| --- | --- | --- |
| `supermemory` | 5.0.0 | `mb_memory.py`: every Supermemory call (namespace setup and profile buckets, document writes and deletes, search, markdown profile, document reads, listing, namespace settings) goes through the official SDK's v5 client. The SDK's own retries are off; `mb_memory` keeps its retry policy (429/5xx/network errors, then `MemoryUnavailable`). The one v3 call, the memory-formation status read while waiting for processing (`GET /v3/documents/{id}`), has no SDK method and stays plain HTTP. |

To add it to an existing environment: `uv pip install --python data/dolphinbench/.venv/bin/python supermemory==5.0.0`.

## Running

All stages go through `bun run src/index.ts dolphinbench <stage>` (or `python dolphinbench/mb_run.py <stage>`).

```bash
bun run src/index.ts dolphinbench setup                       # clone DolphinBench @81cb6f84, build its Python env
bun run src/index.ts dolphinbench estimate dolphinbench/configs/supermemory-instant.json   # no calls
bun run src/index.ts dolphinbench prepare dolphinbench/configs/supermemory-instant.json --name sm-instant-1   # no calls

# paid from here on
bun run src/index.ts dolphinbench pilot dolphinbench/configs/supermemory-instant.json --name p1 \
  --persona all --window 300 --grade --confirm-paid-calls              # first 300 messages per persona + the tests answerable from them
bun run src/index.ts dolphinbench ingest sm-instant-1 --confirm-paid-calls
bun run src/index.ts dolphinbench evaluate sm-instant-1 --confirm-paid-calls --workers 8
bun run src/index.ts dolphinbench package sm-instant-1                 # submission ZIP
bun run src/index.ts dolphinbench status sm-instant-1                  # progress, cost, recall and error health
```

Environment: `SUPERMEMORY_API_KEY` and the agent key named in the config (`api_key_env`). Grading uses DolphinBench's judge (`gpt-5.6-sol`, medium): on Azure when `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_API_KEY` are set, otherwise the same request goes to OpenAI with `OPENAI_API_KEY`.

Runs live in `data/dolphinbench/runs/<name>/` (`run.yaml`, `provenance.json`, `output/`). Stages resume where they stopped. Completed interactions and grades are never repeated. An interaction interrupted mid-flight leaves a `.inflight` marker that DolphinBench won't resume past; `reconcile RUN` clears it (and deletes a partial ingestion capture) so the next resume reruns it.

`--sequential` uses DolphinBench's own one-at-a-time loop instead of parallel personas and tests. Both write the same evidence files.

## Time and cost

`estimate` gives a rough number from the release data, and `pilot` measures it (with `--window`, its tests are picked up front from the release's fact sources; the agent and memory never see facts or grading data). Scale is fixed by the dataset:

- Ingestion: 13,539 agent conversations (1.5M user tokens). Wall time is driven by model latency per turn and by the largest persona (5,128 messages), since personas run in parallel.
- Memory: ~4M tokens stored with `capture: "conversation"`, priced at Supermemory's public rates.
- Tests: 600 agent conversations, usually a few model calls and tool calls each.
- Grading: roughly 1–3 judge calls per test.

Every model response and memory call is written to `output/memorybench/ledger/` as it happens, so `status` reports the cost so far at any point.
