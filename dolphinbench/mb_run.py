"""Runs DolphinBench through memorybench's driver.

Stages wrap DolphinBench's own runner (DolphinBench's evidence, grading and packaging, unchanged):
  setup                      clone DolphinBench at the pinned commit and build its Python environment
  prepare CONFIG --name N    create data/dolphinbench/runs/N and validate the driver (no model or memory calls)
  estimate CONFIG            time and cost estimate from the release data (no calls)
  pilot CONFIG --name N      small paid run to measure real time and cost (--window N: first N messages per
                             persona and the tests answerable from them)
  ingest RUN                 process the full history (paid)
  evaluate RUN               run and grade the 600 tests (paid)
  package RUN                build the submission ZIP (no calls)
  status RUN                 progress, cost and health so far (runs and pilots)
  reconcile RUN              clear interactions interrupted mid-flight so a resume reruns them
  hermes-image --source DIR  build the Hermes agent image (committed Supermemory plugin) for mb_hermes configs

The run config's optional "adapter" picks the agent: mb_harness:MemorybenchHarness (default, memorybench's own loop)
or mb_hermes:HermesSupermemoryHarness (DolphinBench's reference Hermes harness with the Supermemory plugin).

The judge is DolphinBench's (gpt-5.6-sol, medium). With AZURE_OPENAI_ENDPOINT set it goes to Azure, as in DolphinBench;
otherwise the same request goes to OpenAI with OPENAI_API_KEY.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
MB_ROOT = HERE.parent
DATA = MB_ROOT / "data" / "dolphinbench"
RELEASE = Path(os.environ.get("DOLPHINBENCH_ROOT", DATA / "release"))
RUNS = DATA / "runs"
REPO = "https://github.com/mem0ai/dolphinbench.git"
PINNED = "81cb6f8405b40a9e76089cef650806a80af06ea2"
# What the driver adds to DolphinBench's own requirements (mb_memory talks to Supermemory through the SDK)
DRIVER_REQUIREMENTS = ("supermemory==5.0.0",)
PERSONAS = ("morgan", "alex", "riley")
ADAPTER = "mb_harness:MemorybenchHarness"
ADAPTERS = {ADAPTER, "mb_hermes:HermesSupermemoryHarness"}

sys.path.insert(0, str(HERE))
from mb_judge import JUDGE_PRICES_PER_1M, judge_transport  # noqa: E402


# ---- setup ----

def setup(_args):
    if not (RELEASE / ".git").exists():
        RELEASE.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "clone", REPO, str(RELEASE)], check=True)
    subprocess.run(["git", "-C", str(RELEASE), "checkout", "--quiet", PINNED], check=True)
    venv = DATA / ".venv"
    if not venv.exists():
        subprocess.run(["uv", "venv", str(venv), "--python", "3.12"], check=True)
    subprocess.run(["uv", "pip", "install", "--python", str(venv / "bin/python"), "-r",
                    str(RELEASE / "requirements.txt"), *DRIVER_REQUIREMENTS], check=True)
    print(f"DolphinBench {PINNED[:8]} at {RELEASE}\nPython: {venv / 'bin/python'}")


# ---- run directories ----

def write_run(directory: Path, config: dict, name: str, output="output"):
    import yaml
    options = {**config, "run_name": name}
    adapter = options.pop("adapter", ADAPTER)
    if adapter not in ADAPTERS:
        raise SystemExit(f"Unknown adapter {adapter}; use one of {sorted(ADAPTERS)}")
    directory.mkdir(parents=True, exist_ok=True)
    run_yaml = directory / "run.yaml"
    run_yaml.write_text(yaml.safe_dump({
        "release": os.path.relpath(RELEASE, directory), "output": output,
        "adapter": adapter, "options": options}, sort_keys=False))
    sha = subprocess.run(["git", "-C", str(MB_ROOT), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    (directory / "provenance.json").write_text(json.dumps(
        {"memorybench_git_sha": sha, "dolphinbench_commit": PINNED, "judge_transport": judge_transport(),
         "created": time.strftime("%Y-%m-%dT%H:%M:%S%z")},
        indent=2))
    return run_yaml


def load_config(path):
    return json.loads(Path(path).read_text())


def official(stage, run_yaml, paid=False):
    """DolphinBench's own runner stage, unchanged (prepare, package, --sequential)."""
    return runner_module().main([stage, "--config", str(run_yaml)] + (["--confirm-paid-calls"] if paid else []))


def runner_module():
    """DolphinBench's runner, imported from the pinned checkout with this driver importable."""
    for path in (str(HERE), str(RELEASE)):
        if path not in sys.path:
            sys.path.insert(0, path)
    os.chdir(RELEASE)
    from harness import runner
    from graders import llm_judge
    from mb_judge import openai_judge
    if judge_transport() == "openai":
        llm_judge._call_azure = openai_judge(llm_judge)
    return runner


def load_harness(run_yaml: Path, output: Path):
    """The run's adapter, constructed as DolphinBench's runner does (local-only, no model or memory calls)."""
    import yaml
    from importlib import import_module
    runner_module()
    config = yaml.safe_load(run_yaml.read_text())
    module, _, name = config["adapter"].partition(":")
    return getattr(import_module(module), name)(config["options"], output)


# ---- parallel stages (same evidence files as the official sequential loop) ----

def install_parallel(R, workers, grade=True):
    def ingest(self):
        def one(persona):
            checkpoint = self.directory / "checkpoints" / f"{persona}.json"
            if checkpoint.exists():
                self.adapter.verify_checkpoint(persona, R.load_json(checkpoint.read_bytes()))
                return
            sessions = self.release[persona]["sessions"]
            for index, spec in enumerate(sessions, 1):
                self._execute("ingestion", persona, spec)
                if index % 100 == 0 or index == len(sessions):
                    print(f"[{persona}] ingested {index}/{len(sessions)}", flush=True)
            R.save(checkpoint, self.adapter.freeze(persona))
        with ThreadPoolExecutor(len(self.release)) as pool:
            list(pool.map(one, self.release))
        self._collect_cost("ingestion")

    def evaluate(self):
        for persona in self.release:
            path = self.directory / "checkpoints" / f"{persona}.json"
            if not path.exists():
                raise ValueError(f"Complete ingestion first: {persona}")
            self.adapter.verify_checkpoint(persona, R.load_json(path.read_bytes()))
        self._saved_cost("ingestion")
        items = [(p, spec) for p in self.release for spec in self.release[p]["tests"]]
        done, failed = [0], []

        def one(item):
            persona, spec = item
            try:
                evidence = self._execute("tests", persona, spec)
                grade_path = self._path("grades", persona, str(spec["id"]).zfill(3))
                if grade and not grade_path.exists():
                    R.save(grade_path, self._grade(spec, evidence))
            except Exception as error:  # one broken test must not cancel the others
                failed.append(f"{persona}/{spec['id']}")
                print(f"test {persona}/{spec['id']} failed: {type(error).__name__}: {error!r}"[:4000], flush=True)
                return
            done[0] += 1
            if done[0] % 25 == 0 or done[0] == len(items):
                print(f"tests {done[0]}/{len(items)}", flush=True)
        with ThreadPoolExecutor(workers) as pool:
            list(pool.map(one, items))
        if failed:
            raise ValueError(f"{len(failed)} tests failed ({', '.join(failed[:10])}); run reconcile, then evaluate again")
        self._collect_cost("tests")

    R.Runner.ingest = ingest
    R.Runner.evaluate = evaluate


def run_dir(name):
    for path in (RUNS / name, DATA / "pilots" / name):
        if (path / "run.yaml").exists():
            return path
    raise SystemExit(f"No prepared run or pilot named {name}; run prepare first")


def prepare(args):
    directory = RUNS / args.name
    if (directory / "run.yaml").exists():
        raise SystemExit(f"{directory} already exists; pick a new --name")
    run_yaml = write_run(directory, load_config(args.config), args.name)
    return official("prepare", run_yaml)


def ingest(args):
    run_yaml = run_dir(args.run) / "run.yaml"
    if args.sequential:
        return official("ingest", run_yaml, args.confirm_paid_calls)
    R = runner_module()
    install_parallel(R, args.workers)
    return R.main(["ingest", "--config", str(run_yaml)] + (["--confirm-paid-calls"] if args.confirm_paid_calls else []))


def evaluate(args):
    run_yaml = run_dir(args.run) / "run.yaml"
    if args.sequential:
        return official("evaluate", run_yaml, args.confirm_paid_calls)
    R = runner_module()
    install_parallel(R, args.workers)
    return R.main(["evaluate", "--config", str(run_yaml)] + (["--confirm-paid-calls"] if args.confirm_paid_calls else []))


def package(args):
    return official("package", run_dir(args.run) / "run.yaml")


# ---- pilot: measure real time and cost on a slice ----
# With --window, the release's fact sources pick which tests run, before anything starts. The agent and memory get the
# same requests as in a full run and never see facts or grading data.

def pilot(args):
    directory = DATA / "pilots" / args.name
    personas = PERSONAS if args.persona == "all" else (args.persona,)
    plan = {"personas": list(personas), "window": args.window,
            "sessions": None if args.window else args.sessions, "tests": None if args.window else args.tests}
    if (directory / "run.yaml").exists():
        if json.loads((directory / "pilot.json").read_text()) != plan:
            raise SystemExit(f"{directory} exists with a different slice; pick a new --name")
        print(f"Resuming pilot {args.name}")
        run_yaml = directory / "run.yaml"
    else:
        run_yaml = write_run(directory, load_config(args.config), f"pilot-{args.name}")
        (directory / "pilot.json").write_text(json.dumps(plan))
    R = runner_module()
    full = R.read_release

    def sliced(root):
        release = full(root)
        out = {}
        for persona in personas:
            part = dict(release[persona])
            if args.window:
                part["sessions"] = part["sessions"][:args.window]
                kept = {spec["id"] for spec in part["sessions"]}
                facts = part["facts"]
                part["tests"] = [t for t in part["tests"] if t["load_bearing_facts"] and all(
                    set(facts[f]["source_session_ids"]) <= kept for f in t["load_bearing_facts"])]
            else:
                part["sessions"] = part["sessions"][:args.sessions]
                part["tests"] = part["tests"][:args.tests]
            out[persona] = part
        print(", ".join(f"{p}: {len(v['sessions'])} messages, {len(v['tests'])} tests" for p, v in out.items()),
              flush=True)
        return out
    R.read_release = sliced
    install_parallel(R, args.workers, grade=args.grade)
    paid = ["--confirm-paid-calls"] if args.confirm_paid_calls else []
    stages = ("ingest", "evaluate") if (directory / "output" / "run.json").exists() else ("prepare", "ingest", "evaluate")
    for stage in stages:
        code = R.main([stage, "--config", str(run_yaml)] + paid)
        if code:
            return code
    report(directory / "output", directory / "run.yaml", extrapolate=True)


# ---- reconcile ----

def reconcile(args):
    """DolphinBench refuses to resume past an interaction that was interrupted mid-flight. Its agent work is
    lost either way; a partial ingestion capture is deleted so the rerun stores the conversation exactly once."""
    directory = run_dir(args.run)
    output = directory / "output"
    markers = sorted(output.glob("*/*/*.inflight"))
    if not markers:
        print("Nothing to reconcile")
        return 0
    harness = load_harness(directory / "run.yaml", output)
    for marker in markers:
        phase, persona, item = marker.parent.parent.name, marker.parent.name, marker.stem
        note = ""
        if hasattr(harness, "reconcile"):
            done = harness.reconcile(phase, persona, item)
            note = f" ({done})" if done else ""
        elif phase == "ingestion" and harness.provider == "supermemory":
            if harness._memory(persona, writable=True, phase="ingestion").delete_document(f"{persona}-{item}"):
                note = " (deleted its partial capture)"
        for suffix in (".inflight", ".returned"):
            marker.with_suffix(suffix).unlink(missing_ok=True)
        print(f"{phase}/{persona}/{item}: cleared, reruns on resume{note}")


# ---- Hermes agent image (mb_hermes) ----

def hermes_image(args):
    """Builds DolphinBench's Hermes agent image (reference.execution.build_agent_image --memory supermemory) from one
    commit of a Hermes checkout. It builds from a fresh clone, so only committed files go in, and records the Hermes
    and plugin commits under data/dolphinbench/hermes-images/ for the run identity."""
    import yaml
    source = Path(args.source).resolve()

    def git(*command):
        return subprocess.run(["git", "-C", str(source), *command], check=True, capture_output=True,
                              text=True).stdout.strip()
    commit = git("rev-parse", f"{args.ref}^{{commit}}")
    plugin = "plugins/memory/supermemory"
    left_out = git("status", "--porcelain", "--", plugin)
    with tempfile.TemporaryDirectory(prefix="mb-hermes-src-") as raw:
        clone = Path(raw) / "hermes"
        subprocess.run(["git", "clone", "--quiet", "--no-hardlinks", "--no-checkout", str(source), str(clone)],
                       check=True)
        subprocess.run(["git", "-C", str(clone), "checkout", "--quiet", commit], check=True)
        subprocess.run([sys.executable, "-m", "reference.execution.build_agent_image", "--source", str(clone),
                        "--memory", "supermemory", "--tag", args.tag], cwd=RELEASE, check=True)
    image = subprocess.run(["docker", "--context", "default", "image", "inspect", "--format", "{{.Id}}", args.tag],
                           check=True, capture_output=True, text=True).stdout.strip()
    record = DATA / "hermes-images" / f"{image.removeprefix('sha256:')}.json"
    if not record.exists():
        record.parent.mkdir(parents=True, exist_ok=True)
        record.write_text(json.dumps({
            "image": image, "tag": args.tag, "source": str(source), "ref": args.ref, "commit": commit,
            "subject": git("log", "-1", "--format=%s", commit),
            "plugin_commit": git("log", "-1", "--format=%H", commit, "--", plugin),
            "plugin_tree": git("rev-parse", f"{commit}:{plugin}"),
            "plugin_version": yaml.safe_load(git("show", f"{commit}:{plugin}/plugin.yaml")).get("version"),
            "memory": "supermemory", "dolphinbench_commit": PINNED,
            "built": time.strftime("%Y-%m-%dT%H:%M:%S%z")}, indent=2))
    if left_out:
        print(f"Note: uncommitted changes in {plugin} were left out:\n{left_out}")
    print(f"Hermes {commit[:10]} (plugin {json.loads(record.read_text())['plugin_commit'][:10]})\n"
          f"export DOLPHINBENCH_AGENT_IMAGE={image}")


# ---- status / estimate ----

def report(output: Path, run_yaml: Path, extrapolate=False):
    harness = load_harness(run_yaml, output)
    max_turns = harness.max_turns
    manifest = json.loads((RELEASE / "manifest.json").read_text())["sources"]
    largest = max(s["sessions"] for s in manifest.values())
    workers = 8
    for phase, full_count in (("ingestion", sum(s["sessions"] for s in manifest.values())), ("tests", 600)):
        rows = [json.loads(p.read_text())["row"] for p in sorted((output / phase).glob("*/*.json"))]
        if not rows:
            print(f"{phase}: nothing completed yet")
            continue
        durations = [r["duration_ms"] / 1000 for r in rows]
        mean = statistics.mean(durations)
        records = list(harness.ledger.records(phase))
        try:
            agent_usd = harness.total_cost_usd(phase) - harness.memory_cost(phase)
        except ValueError as error:
            agent_usd = None
            print(f"{phase}: {error}")
        print(f"{phase}: {len(rows)} done, {mean:.1f}s mean, {statistics.median(durations):.1f}s median"
              + (f", agent ${agent_usd:.4f} (${agent_usd / len(rows):.5f} each)" if agent_usd is not None else ""))

        from harness.submission import token_counts
        usages = [token_counts(r["usage"]) for r in records if r["t"] == "agent"]
        calls = [sum(1 for m in r["messages"] if m["role"] == "assistant") for r in rows]
        prompt = [u["input_tokens"] + u["cache_read_input_tokens"] + u["cache_creation_input_tokens"] for u in usages]
        cached = sum(u["cache_read_input_tokens"] for u in usages)
        reasoning = [u["reasoning_tokens"] for u in usages]
        print(f"  model calls/interaction {statistics.mean(calls):.1f} (max {max(calls)}, "
              f"{sum(c >= max_turns for c in calls)} hit the {max_turns} limit); prompt tokens/call "
              f"{statistics.mean(prompt):.0f}, cached {cached / max(sum(prompt), 1):.0%}; reasoning tokens/call "
              f"{statistics.mean(reasoning):.0f}")
        tools = {}
        for r in rows:
            for m in r["messages"]:
                for call in m.get("tool_calls") or []:
                    name = call["name"]
                    if name == "tool_call" and isinstance((call.get("arguments") or {}).get("name"), str):
                        name = call["arguments"]["name"].removeprefix("mcp__dolphinbench_apps__")  # Hermes' deferred tools
                    tools[name] = tools.get(name, 0) + 1
        if tools:
            print("  tool calls: " + ", ".join(f"{k} {v}" for k, v in sorted(tools.items(), key=lambda kv: -kv[1])))
        recalls = [r for r in records if r["t"] == "recall"]
        if recalls:
            quarter = max(len(recalls) // 4, 1)
            memories = [r["memories"] for r in recalls if "memories" in r]  # mb_hermes: the plugin doesn't mark them
            print(f"  recall: {sum(r['results'] > 0 for r in recalls) / len(recalls):.0%} returned results, "
                  f"{statistics.mean(r['results'] for r in recalls):.1f} results"
                  + (f" ({statistics.mean(memories):.1f} memories)" if memories else "") + ", "
                  f"profile items first/last quarter {statistics.mean(r['profile_items'] for r in recalls[:quarter]):.0f}"
                  f"/{statistics.mean(r['profile_items'] for r in recalls[-quarter:]):.0f}, "
                  f"{statistics.mean(r['chars'] for r in recalls):.0f} chars")
        memory_errors = [r for r in records if r["t"] == "memory_error"]
        tool_errors = [r for r in records if r["t"] == "tool_error"]
        print(f"  memory outages: {len(memory_errors)}; tool errors shown to the agent: {len(tool_errors)}"
              + (" (" + ", ".join(sorted({e['tool'] for e in tool_errors})) + ")" if tool_errors else ""))
        failures = [r for r in records if r["t"] == "memory_failure"]
        if failures:
            kinds = {}
            for r in failures:
                kinds[r["where"]] = kinds.get(r["where"], 0) + 1
            print(f"  memory failures seen by the agent's plugin: {len(failures)} ("
                  + ", ".join(f"{k} {v}" for k, v in sorted(kinds.items())) + ")")
        for kind, label in (("usage_mismatch", "sessions whose state.db call count differs from the trace"),
                            ("receipt_mismatch", "captures where the seed receipt and the proxy disagree")):
            if any(r["t"] == kind for r in records):
                print(f"  {label}: {sum(r['t'] == kind for r in records)}")
        aux = [r for r in records if r["t"] == "agent_aux"]
        if aux:
            print(f"  auxiliary model calls (in cost, not in traces): {sum(r['calls'] for r in aux)} ("
                  + ", ".join(sorted({r['task'] for r in aux})) + ")")
        denied = [r for r in records if r["t"] == "proxy_denied"]
        if denied:
            print(f"  memory requests refused by the proxy: {len(denied)} ("
                  + ", ".join(sorted({f"{r['method']} {r['path']}" for r in denied})[:5]) + ")")
        # mb_harness lists failed HTTP attempts; mb_hermes lists every Hermes attempt with driver_ok
        retries = sum(sum(1 for a in json.loads(p.read_text()).get("attempts") or [] if a.get("driver_ok") is not True)
                      for p in (output / phase).glob("*/*.json"))
        if retries:
            print(f"  model call retries: {retries}")
        if hasattr(harness, "retry_summary"):
            reasons = harness.retry_summary(phase)
            print(f"  automatic interaction retries: {sum(reasons.values())}"
                  + (" (" + ", ".join(f"{k} {v}" for k, v in sorted(reasons.items())) + ")" if reasons else ""))
        rollbacks = [r for r in records if r["t"] == "rollback"]
        if rollbacks:
            print(f"  rolled-back attempts: {len(rollbacks)} ({sum(len(r.get('doc_ids') or []) for r in rollbacks)} "
                  "documents deleted)")
        if extrapolate:
            wall = mean * (largest if phase == "ingestion" else full_count / workers) / 3600
            how = "personas in parallel" if phase == "ingestion" else f"{workers} workers"
            extra = f", agent ~${agent_usd / len(rows) * full_count:.2f}" if agent_usd is not None else ""
            print(f"  full {phase} ({full_count}): ~{wall:.1f}h with {how}{extra}")
    inflight = list(output.glob("*/*/*.inflight"))
    if inflight:
        print(f"in flight: {len(inflight)} (if nothing is running, these were interrupted: run reconcile before resuming)")
    for checkpoint in sorted((output / "checkpoints").glob("*.json")):
        c = json.loads(checkpoint.read_text())
        print(f"frozen {c['persona']}: {c.get('documents')} documents, {c.get('memories')} memories")
    grades = [json.loads(p.read_text()) for p in sorted((output / "grades").glob("*/*.json"))]
    if grades:
        passed = sum(all(c["passed"] for c in g["checks"]) for g in grades)
        judged = [m.get("usage") or {} for g in grades for c in g["checks"] for m in c.get("messages") or []
                  if m.get("role") == "assistant"]
        judge_usd = sum(((u.get("prompt_tokens", 0) - ((u.get("prompt_tokens_details") or {}).get("cached_tokens") or 0))
                         * JUDGE_PRICES_PER_1M["input"]
                         + ((u.get("prompt_tokens_details") or {}).get("cached_tokens") or 0) * JUDGE_PRICES_PER_1M["cached_input"]
                         + u.get("completion_tokens", 0) * JUDGE_PRICES_PER_1M["output"]) / 1e6 for u in judged)
        print(f"graded: {passed}/{len(grades)} passed ({passed / len(grades):.1%}); judge {len(judged)} calls, "
              f"${judge_usd:.4f} (${judge_usd / len(grades):.4f}/test"
              + (f", full 600 ~${judge_usd / len(grades) * 600:.2f})" if extrapolate else ")"))


def status(args):
    directory = run_dir(args.run)
    report(directory / "output", directory / "run.yaml")


def estimate(args):
    """Back-of-envelope numbers from the release; replace with pilot measurements before committing."""
    config = load_config(args.config)
    manifest = json.loads((RELEASE / "manifest.json").read_text())["sources"]
    sessions = sum(s["sessions"] for s in manifest.values())
    user_tokens = sum(s["user_message_tokens"] for s in manifest.values())
    largest = max(s["sessions"] for s in manifest.values())
    reply_tokens = args.reply_tokens * sessions
    capture = (config.get("memory") or {}).get("capture", "conversation")
    stored = user_tokens + (reply_tokens if capture == "conversation" else 0)
    provider = (config.get("memory") or {}).get("provider", "none")
    settings = (config.get("memory") or {}).get("settings") or {}
    sys.path.insert(0, str(HERE))
    from mb_memory import SUPERMEMORY_PRICES as P
    memory_usd = 0.0
    if provider == "supermemory":
        searches = sessions * 2 + 600 * args.searches_per_test
        operations = sessions if settings.get("dreaming") == "instant" else 0
        memory_usd = (stored / 1000 * P["memory_per_1k_tokens"] + searches / 1000 * P["search_per_1k_queries"]
                      + operations / 1000 * P["operation_per_1k"])
    prices = (config.get("agent") or {}).get("prices_per_1m") or {}
    agent_usd = None
    if all(prices.get(k) is not None for k in ("input", "cached_input", "output")):
        per_turn_in, per_turn_cached = args.input_tokens * 0.25, args.input_tokens * 0.75
        ingestion_agent = sessions * (per_turn_in * prices["input"] + per_turn_cached * prices["cached_input"]
                                      + args.output_tokens * prices["output"]) / 1e6
        tests_agent = 600 * args.test_steps * (per_turn_in * prices["input"] + per_turn_cached * prices["cached_input"]
                                               + args.output_tokens * prices["output"]) / 1e6
        agent_usd = ingestion_agent + tests_agent
    print(f"History: {sessions} messages ({user_tokens:,} user tokens), 600 tests")
    if provider == "supermemory":
        print(f"Stored in memory: ~{stored:,} tokens ({capture}) -> memory processing ~${memory_usd:.2f}")
    else:
        print("Memory: none")
    print("Agent: " + (f"~${agent_usd:.2f}" if agent_usd is not None else "set agent.prices_per_1m to estimate"))
    for seconds in (6, 12, 20):
        print(f"  at {seconds}s per ingestion turn: {sessions * seconds / 3600:.0f}h sequential, "
              f"{largest * seconds / 3600:.0f}h with personas in parallel")
    print(f"  tests at ~50s each: {600 * 50 / 3600:.1f}h sequential, {600 * 50 / 3600 / args.workers:.1f}h "
          f"with {args.workers} workers")
    print("Grading: Azure gpt-5.6-sol (medium), one call per semantic check (~1-3 per test)")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="stage", required=True)
    sub.add_parser("setup")
    p = sub.add_parser("prepare"); p.add_argument("config"); p.add_argument("--name", required=True)
    p = sub.add_parser("estimate"); p.add_argument("config")
    p.add_argument("--reply-tokens", type=int, default=190, help="mean agent reply (published Hermes runs: ~190)")
    p.add_argument("--input-tokens", type=int, default=9000, help="prompt tokens per model call")
    p.add_argument("--output-tokens", type=int, default=800, help="output incl. reasoning per model call")
    p.add_argument("--test-steps", type=int, default=5, help="model calls per test")
    p.add_argument("--searches-per-test", type=int, default=5)
    p.add_argument("--workers", type=int, default=8)
    for stage in ("ingest", "evaluate"):
        p = sub.add_parser(stage); p.add_argument("run")
        p.add_argument("--confirm-paid-calls", action="store_true")
        p.add_argument("--sequential", action="store_true", help="DolphinBench's own one-at-a-time loop")
        p.add_argument("--workers", type=int, default=8, help="parallel tests (ingestion runs one thread per persona)")
    p = sub.add_parser("package"); p.add_argument("run")
    p = sub.add_parser("status"); p.add_argument("run")
    p = sub.add_parser("reconcile"); p.add_argument("run")
    p = sub.add_parser("hermes-image"); p.add_argument("--source", required=True, help="Hermes git checkout")
    p.add_argument("--ref", default="HEAD", help="commit, branch or tag to build (committed files only)")
    p.add_argument("--tag", default="memorybench-hermes-supermemory:local")
    p = sub.add_parser("pilot"); p.add_argument("config"); p.add_argument("--name", required=True)
    p.add_argument("--persona", choices=PERSONAS + ("all",), default="morgan")
    p.add_argument("--sessions", type=int, default=100); p.add_argument("--tests", type=int, default=10)
    p.add_argument("--window", type=int, help="first N messages per persona, and only tests answerable from them")
    p.add_argument("--workers", type=int, default=4)
    p.add_argument("--grade", action="store_true", help="also grade (needs Azure gpt-5.6-sol)")
    p.add_argument("--confirm-paid-calls", action="store_true")
    args = parser.parse_args(argv)
    if args.stage != "setup" and not (RELEASE / "manifest.json").exists():
        raise SystemExit(f"DolphinBench not found at {RELEASE}; run setup first")
    return {"setup": setup, "prepare": prepare, "estimate": estimate, "pilot": pilot, "ingest": ingest,
            "evaluate": evaluate, "package": package, "status": status, "reconcile": reconcile,
            "hermes-image": hermes_image}[args.stage](args)


if __name__ == "__main__":
    raise SystemExit(main())
