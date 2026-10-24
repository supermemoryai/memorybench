"""memorybench's DolphinBench driver: one agent loop, any memory backend, DolphinBench's runner and grader.

Implements the five methods of DolphinBench's DRIVER_CONTRACT. Loaded by DolphinBench's runner as
`mb_harness:MemorybenchHarness` with this directory on PYTHONPATH.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import sys
import threading
from pathlib import Path

from examples.mcp_connection import connect_apps
from harness.adapter import InteractionRecord
from harness.submission import token_counts

from mb_agent import ChatModel, final_reply, run_conversation
from mb_judge import judge_transport
from mb_memory import SUPERMEMORY_PRICES, MemoryUnavailable, NoMemory, Supermemory

HERE = Path(__file__).resolve().parent
PERSONA_NAMES = {"morgan": "Morgan", "alex": "Alex", "riley": "Riley"}

# Adapted from DolphinBench's harness/benchmark_soul.md
SOUL = """You are a direct and helpful personal assistant for {name}. Treat the supplied conversation history and current request as coming from that user. Use the available tools when they are needed to complete the request. Do not claim access to services, files, accounts, contacts, or information that are not present in the conversation or tools."""

# Generic working habits, the same for every persona and test
WORK_SECTION = """# How to work

- The date in brackets at the start of {name}'s message is today's date. Use it for "today", "tomorrow", "next Friday" and to judge what is current.
- Act, don't ask. Carry out the request with your tools. {name} often leaves out details they have told you before, such as which business, which person, which channel, or how they like something done. Fill those in yourself rather than asking. Ask only if nothing you can look up settles it, and even then make the best-supported choice if the request can still be completed.
- Do the work instead of describing it. Pass explicit, complete values to tools (full names, addresses, IDs, dates with times and time zones); tools do not understand "the usual". If a call fails or returns ok: false, fix the input and try again. Before deciding something can't be done, check which tools you have.
- When you write a document, message, comment or review about something from the past, build it from the record and put every relevant specific into the content itself: names, dates, numbers, reasons, conditions, caveats, and who said or decided what. Say only what the record supports. Keep qualifiers as they were (provisional or final, "for now", exceptions), and don't add events or outcomes from other times that the request didn't ask about.
- When something changed over time, use its latest state as of today, unless the request is about a specific earlier time; then describe it as it stood then."""

MEMORY_SECTION = """# Memory

You remember your past conversations with {name} through Supermemory.
- Every past conversation is stored in full, dated with when {name} sent it. From them Supermemory extracts dated memories (facts, preferences, people, rules, decisions) and keeps a profile of {name}: lasting facts plus sections such as preferences, people, places and services, and standing instructions.
- Before each request, the profile and the memories most related to the request are added automatically. That is a starting point, not everything you know.
- supermemory_search finds memories and excerpts of the original conversations. Search for each person, place, preference or rule the request touches, even when the request looks complete: who to involve or copy, which channel, scheduling rules, usual places, limits. Use short, specific queries built from names and key terms, include the year when you know it, and try other words if the first search misses.
- supermemory_read_document opens a full original conversation by the document id shown in results. Read it when you need exact wording, every detail of an event, or who said or decided what.
- supermemory_profile returns the full profile, including a sample of recent memories."""


class Ledger:
    """Durable JSONL usage records, one file per phase and persona."""

    def __init__(self, directory: Path):
        self.directory = directory
        self.lock = threading.Lock()

    def _append(self, phase, persona, record):
        self.directory.mkdir(parents=True, exist_ok=True)
        with self.lock, (self.directory / f"{phase}-{persona}.jsonl").open("a") as stream:
            stream.write(json.dumps(record) + "\n")
            stream.flush()
            os.fsync(stream.fileno())

    def agent(self, persona, phase, interaction_id, usage):
        self._append(phase, persona, {"t": "agent", "id": interaction_id, "usage": usage})

    def memory(self, persona, phase, op, n=1):
        self._append(phase, persona, {"t": "memory", "op": op, "n": n})

    def capture(self, persona, doc_id):
        self._append("ingestion", persona, {"t": "capture", "doc_id": doc_id})

    def event(self, persona, phase, record):
        self._append(phase, persona, record)

    def records(self, phase, persona=None):
        for path in sorted(self.directory.glob(f"{phase}-{persona or '*'}.jsonl")):
            for line in path.read_text().splitlines():
                if line.strip():
                    yield json.loads(line)


def _app_calls(sent, log_path):
    """Each app call as sent, with the result the app logged for it (matched in order by tool name)."""
    from graders.mechanical import load_tool_calls
    log, cursor, calls = load_tool_calls(Path(log_path)), 0, []
    for tool, arguments in sent:
        match = next((i for i in range(cursor, len(log)) if log[i].get("tool") == tool), None)
        call = {"tool": tool, "args": arguments}
        if match is not None:
            if "result" in log[match]:
                call["result"] = log[match]["result"]
            cursor = match + 1
        calls.append(call)
    return calls


class MemorybenchHarness:
    def __init__(self, options, work_dir):
        self.options = options
        self.work_dir = Path(work_dir)
        self.run_name = options.get("run_name") or self.work_dir.name
        self.state = self.work_dir / "memorybench"
        self.ledger = Ledger(self.state / "ledger")
        self.agent = options["agent"]
        self.memory_config = options.get("memory") or {"provider": "none"}
        self.provider = self.memory_config.get("provider", "none")
        if self.provider not in ("supermemory", "none"):
            raise ValueError(f"Unknown memory provider: {self.provider}")
        self.model = ChatModel(self.agent)
        self.max_turns = int(self.agent.get("max_turns", 60))

    # ---- contract: identity ----

    def identity(self):
        memory = {k: v for k, v in self.memory_config.items() if k != "api_key_env"}
        return {
            "reference": "memorybench",
            "run_name": self.run_name,
            # Files that decide results; the run CLI (mb_run.py) and the Hermes adapter's files can change without
            # blocking a resume
            "driver_sha256": {name: hashlib.sha256((HERE / name).read_bytes()).hexdigest()
                              for name in ("mb_agent.py", "mb_harness.py", "mb_judge.py", "mb_memory.py")},
            "judge_transport": judge_transport(),
            "agent": {k: v for k, v in self.agent.items() if k != "api_key_env"},
            "memory": memory,
            "memory_prices": SUPERMEMORY_PRICES if self.provider == "supermemory" else {},
            "python": sys.version.split()[0],
            "namespaces": {p: self._namespace(p) for p in PERSONA_NAMES} if self.provider == "supermemory" else {},
        }

    # ---- contract: interactions ----

    def run_interaction(self, request):
        return asyncio.run(self._run(request))

    async def _run(self, request):
        async with connect_apps(request.apps) as apps:
            tools = (await apps.list_tools()).tools
            return await self.run_agent(request, tools, apps.call_tool)

    async def run_agent(self, request, tools, call_app):
        persona, phase = request.persona, request.phase
        name = PERSONA_NAMES.get(persona, persona.title())
        memory = self._memory(persona, writable=(phase == "ingestion"), phase=phase)
        if phase == "ingestion":
            self._configure(persona, memory)

        system = [SOUL.format(name=name) + "\n\n" + WORK_SECTION.format(name=name)]
        if self.provider != "none":
            system[0] += "\n\n" + MEMORY_SECTION.format(name=name)
            recall_config = self.memory_config.get("recall", {})
            if phase == "tests" or recall_config.get("during_ingestion", True):
                try:
                    recalled, stats = await asyncio.to_thread(memory.recall, request.message)
                except MemoryUnavailable as error:
                    self.ledger.event(persona, phase, {"t": "memory_error", "id": request.interaction_id,
                                                       "where": "recall", "error": str(error)[:300]})
                    raise
                if stats is not None:
                    self.ledger.event(persona, phase, {"t": "recall", "id": request.interaction_id, **stats})
                if recalled:
                    system.append(recalled)

        app_tools = [{"name": t.name, "description": t.description or "", "parameters": t.inputSchema}
                     for t in tools]
        defaults = {t["name"]: {k: v["default"] for k, v in (t["parameters"].get("properties") or {}).items()
                                if isinstance(v, dict) and "default" in v} for t in app_tools}
        sent = []  # app calls in order, with the arguments the app received
        memory_tools = list(memory.tools)
        memory_names = {t["name"] for t in memory_tools}
        app_names = {t["name"] for t in app_tools}
        if memory_names & app_names:
            raise ValueError(f"Tool name collision: {memory_names & app_names}")
        all_tools = app_tools + memory_tools

        async def execute(tool, arguments):
            try:
                if tool in memory_names:
                    return await asyncio.to_thread(memory.call_tool, tool, arguments)
                if tool in app_names:
                    sent.append((tool, arguments))
                    result = await call_app(tool, arguments)
                    return "\n".join(c.text for c in result.content if getattr(c, "type", "") == "text")
                return f"Error: unknown tool {tool}"
            except MemoryUnavailable as error:  # an outage aborts the interaction; it must not count as a result
                self.ledger.event(persona, phase, {"t": "memory_error", "id": request.interaction_id,
                                                   "where": tool, "error": str(error)[:300]})
                raise
            except Exception as error:  # bad arguments etc.: surfaced to the model as the tool result
                self.ledger.event(persona, phase, {"t": "tool_error", "id": request.interaction_id,
                                                   "tool": tool, "error": str(error)[:300]})
                return f"Error: {error}"

        def fill(tool, arguments):
            """Omitted optional app arguments get the tool's declared defaults, as the app would apply them, so the
            transcript, the app's call log and the graded arguments all agree."""
            return {**defaults.get(tool, {}), **arguments} if tool in app_names else arguments

        messages, usages, attempts = await run_conversation(
            self.model, system, request.dated_message, all_tools, execute, self.max_turns, fill)
        for usage in usages:
            self.ledger.agent(persona, phase, request.interaction_id, usage)

        if phase == "ingestion" and self.provider != "none":
            content = self._capture_content(name, request, final_reply(messages))
            doc_id = f"{persona}-{request.interaction_id}"
            await asyncio.to_thread(memory.capture, doc_id, content, request.narrative_time,
                                    {"docId": doc_id, "persona": persona, "date": request.narrative_time})
            self.ledger.capture(persona, doc_id)

        return InteractionRecord(settings=self.model.settings(all_tools), messages=messages, attempts=attempts,
                                 app_calls=_app_calls(sent, request.apps["env"]["DOLPHINBENCH_LOG_PATH"]))

    # ---- contract: freeze / verify ----

    def freeze(self, persona):
        memory = self._memory(persona, writable=False, phase="ingestion")
        doc_ids = sorted({r["doc_id"] for r in self.ledger.records("ingestion", persona) if r["t"] == "capture"})
        memory.wait_until_processed(doc_ids, progress=lambda done, total: print(
            f"[{persona}] memory processing {done}/{total}", flush=True))
        snapshot = {"persona": persona, **memory.snapshot()}
        path = self.state / "checkpoints" / f"{persona}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(snapshot, indent=2))
        return snapshot

    def verify_checkpoint(self, persona, checkpoint):
        current = {"persona": persona, **self._memory(persona, writable=False, phase="tests").snapshot()}
        if current.get("sha256") != checkpoint.get("sha256") or current.get("namespace") != checkpoint.get("namespace"):
            raise ValueError(f"{persona}: memory changed since freeze "
                             f"(documents {checkpoint.get('documents')} -> {current.get('documents')}, "
                             f"memories {checkpoint.get('memories')} -> {current.get('memories')})")

    # ---- contract: cost ----

    def total_cost_usd(self, phase):
        prices = self.agent.get("prices_per_1m") or {}
        agent_usd = 0.0
        for record in self.ledger.records(phase):
            if record["t"] != "agent":
                continue
            if any(prices.get(k) is None for k in ("input", "cached_input", "output")):
                raise ValueError("Set agent.prices_per_1m (input, cached_input, output) to report cost")
            tokens = token_counts(record["usage"])  # DolphinBench's reading of any usage shape
            agent_usd += ((tokens["input_tokens"] + tokens["cache_creation_input_tokens"]) * prices["input"]
                          + tokens["cache_read_input_tokens"] * prices["cached_input"]
                          + tokens["output_tokens"] * prices["output"]) / 1e6
        return round(agent_usd + self.memory_cost(phase), 6)

    def memory_cost(self, phase):
        if self.provider != "supermemory":
            return 0.0
        totals = {}
        for record in self.ledger.records(phase):
            if record["t"] == "memory":
                totals[record["op"]] = totals.get(record["op"], 0) + record["n"]
        p = SUPERMEMORY_PRICES
        return (totals.get("memory_tokens", 0) / 1000 * p["memory_per_1k_tokens"]
                + totals.get("search", 0) / 1000 * p["search_per_1k_queries"]
                + totals.get("operation", 0) / 1000 * p["operation_per_1k"])

    # ---- helpers ----

    def _namespace(self, persona):
        prefix = self.memory_config.get("namespace_prefix", "dolphinbench")
        return re.sub(r"[^a-zA-Z0-9_:-]", "_", f"{prefix}-{self.run_name}-{persona}")[:100]

    def _memory(self, persona, writable, phase):
        if self.provider == "none":
            return NoMemory()
        settings = dict(self.memory_config.get("settings") or {})
        name = PERSONA_NAMES.get(persona, persona.title())
        if settings.get("supportingContext"):
            settings["supportingContext"] = settings["supportingContext"].replace("{persona}", name)
        if settings.get("profileBuckets"):
            settings["profileBuckets"] = {k: v.replace("{persona}", name) for k, v in settings["profileBuckets"].items()}
        key_env = self.memory_config.get("api_key_env", "SUPERMEMORY_API_KEY")
        api_key = os.environ.get(key_env, "")
        if not api_key:
            raise RuntimeError(f"{key_env} is not set")
        return Supermemory(self._namespace(persona), settings, self.memory_config.get("recall", {}), api_key,
                           self.memory_config.get("base_url", "https://api.supermemory.ai"), writable,
                           self.ledger, persona, phase)

    def _configure(self, persona, memory):
        """Once per persona, before its first ingested conversation (each persona's history runs on one thread)."""
        marker = self.state / f"configured-{persona}"
        if marker.exists():
            return
        memory.configure()
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(self._namespace(persona))

    def _capture_content(self, name, request, reply):
        """One document per ingestion conversation: the dated user message, and the reply unless capture is 'user'."""
        text = f"[{request.narrative_time}] {name}: {request.message}"
        if self.memory_config.get("capture", "conversation") == "conversation" and reply:
            text += f"\n\nAssistant: {reply}"
        return text
