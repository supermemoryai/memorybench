"""Hermes, DolphinBench's reference harness, with the Supermemory plugin on hosted Supermemory.

Loaded by DolphinBench's runner as `mb_hermes:HermesSupermemoryHarness` (run config: "adapter"). Same runner,
apps, grader and evidence as mb_harness; the agent is Hermes instead of memorybench's own loop:

- Every interaction is a fresh one-turn Hermes session (`hermes chat -q`), started by DolphinBench's Hermes driver
  (harness.hermes_driver -> reference.execution.hermes_agent) in its disposable Docker agent container, with its
  trace capture, turn status, runtime tool checks and retry rules. Hermes built-in memory and session_search stay on
  as in every published condition; the Supermemory plugin (plugins/memory/supermemory, unmodified) is the external
  provider. Tests run without the hermes-cli toolset, as the published runs did (PHASE_TOOLSETS). Each test runs in a
  copy of the frozen ingestion profile with its session history cleared (clear_session_history): built-in memory
  notes stay, but session_search finds no ingestion conversations.
- The plugin runs with its product defaults except for the benchmark's choices, which go into each persona profile's
  supermemory.json (the plugin's own config file); see _plugin_config.
- The container never gets the Supermemory key. The plugin talks to a local proxy (mb_proxy) with a per-interaction
  token that pins the persona's namespace and the phase: during tests only search, profile and document reads pass,
  so the plugin's own writes (it has no read-only mode) are refused with 405, which it logs without failing the turn;
  mb_hermes_shim leaves the plugin's write tools out of test sessions, which DolphinBench's driver requires.
- mb_hermes_shim (inside the container) moves the plugin's recalled context into the system prompt, so the dated
  request stays the conversation's only, unchanged user message, and writes DolphinBench's seed receipts when it sees
  the plugin's write of a history message's conversation document accepted.
- The proxy passes each history message's timestamp through Supermemory's date field on ingestion document writes
  (when the plugin sends no date) and retries connection-level upstream failures with backoff.
- Capture receipts and memory usage come from the proxy; agent cost from the recorded per-response API usage, priced
  at the config's list prices (Hermes' own price table is not used).
- An interaction whose conversation DolphinBench can't export (recording error, rewritten context, invalid messages)
  or that hit an infrastructure failure is rerun (RECORDING_RETRIES, DolphinBench's retry limits); before an ingestion
  rerun, built-in memory, the ingestion app state and the Supermemory documents the failed attempt stored are rolled
  back. Reruns never depend on grading, which runs only on the final attempt; every attempt is kept in the journal.
"""

from __future__ import annotations

import hashlib
import hmac
import copy
import json
import os
import re
import secrets
import shutil
import socketserver
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from contextlib import closing
from pathlib import Path

import yaml

from graders.mechanical import load_tool_calls
from harness import hermes_driver
from harness.adapter import InteractionRecord
from harness.adapters.hermes import copy_profile, tree_identity
from harness.adapters.hermes_profile import _load_personas, _profile_config, toolsets_for
from harness.durable_json import save_json
from harness.submission import token_counts
from harness.submission_capture import _plain
from reference.execution import hermes_agent
from reference.execution.agent_container import AgentContainer, AppBridge, AppConnection, extract_files

from mb_harness import PERSONA_NAMES, Ledger
from mb_judge import judge_transport
from mb_memory import SUPERMEMORY_PRICES, Supermemory, count_tokens
from mb_proxy import SupermemoryProxy

HERE = Path(__file__).resolve().parent
RELEASE_ROOT = Path(hermes_driver.__file__).resolve().parents[1]
IMAGES = HERE.parent / "data" / "dolphinbench" / "hermes-images"
SHIM = HERE / "mb_hermes_shim.py"
# Profile recipe (config.yaml) and the toolsets each `hermes chat -q -t ...` is started with. As in DolphinBench's
# published Hermes runs: history messages run with its seed toolsets (reference.execution.hermes), tests without
# hermes-cli (terminal, files, skills, web, code, delegation, cron): scoped app tools, session_search and the memory
# provider's tools.
TOOLSETS = toolsets_for("supermemory")
PHASE_TOOLSETS = {"ingestion": TOOLSETS, "tests": [t for t in TOOLSETS if t != "hermes-cli"]}
# DolphinBench's Hermes adapter sets these to 1 in tests (built-in memory read-only, one turn)
READ_ONLY = ("DOLPHINBENCH_MEMORY_READ_ONLY", "DOLPHINBENCH_MEM0_READ_ONLY", "DOLPHINBENCH_HONCHO_READ_ONLY",
             "DOLPHINBENCH_NATIVE_MEMORY_READ_ONLY", "DOLPHINBENCH_SINGLE_TURN", "DOLPHINBENCH_SUPERMEMORY_READ_ONLY")
SEED_RECEIPTS = "DOLPHINBENCH_SUPERMEMORY_SEED_RECEIPTS"
MOCK_PREFIXES = ("mcp_dolphinbench_apps_", "mcp__dolphinbench_apps__")
# The plugin's environment: per interaction, the proxy token as its API key and the proxy as its endpoint
# (SUPERMEMORY_BASE_URL is the plugin's fallback when supermemory.json has no base_url, which it never has here)
PLUGIN_ENV = ("SUPERMEMORY_API_KEY", "SUPERMEMORY_BASE_URL")
# supermemory.json keys (plugin _CONFIG_SPEC) a config's memory.plugin_settings may set. container_tag and
# entity_context come from the namespace and memory.settings.supportingContext; base_url is the proxy (environment).
PLUGIN_KEYS = ("auto_recall", "auto_capture", "max_recall_results", "capture_mode", "search_mode", "dreaming",
               "api_timeout", "enable_custom_container_tags", "custom_containers", "custom_container_instructions")
# Reruns of an interaction whose conversation DolphinBench's recorder couldn't export
RECORDING_RETRIES = 2


def plugin_tag(raw):
    """The plugin's container tag normalization (_sanitize_tag): it applies it to container_tag, so the namespace the
    controller uses must already be in that form."""
    return re.sub(r"_+", "_", re.sub(r"[^a-zA-Z0-9_]", "_", raw or "")).strip("_")


# ---- host networking: how the agent container reaches the proxy and the app server ----

def host_settings():
    """macOS (Docker Desktop, OrbStack): host.docker.internal reaches the Mac's loopback, but a Unix socket can't be
    bind-mounted from macOS, so apps go over an authenticated TCP bridge. Linux: DolphinBench's own Unix-socket
    bridge, and the proxy on the docker0 gateway. MB_HERMES_BIND / MB_HERMES_ADVERTISE / MB_HERMES_APP_BRIDGE
    override (not part of the run identity, so a run can resume on another machine)."""
    if sys.platform == "darwin":
        defaults = {"bind": "127.0.0.1", "advertise": "host.docker.internal", "bridge": "tcp"}
    else:
        gateway = subprocess.run(["docker", "--context", "default", "network", "inspect", "bridge", "--format",
                                  "{{(index .IPAM.Config 0).Gateway}}"], capture_output=True, text=True
                                 ).stdout.strip() or "172.17.0.1"
        defaults = {"bind": gateway, "advertise": gateway, "bridge": "unix"}
    return {"bind": os.environ.get("MB_HERMES_BIND") or defaults["bind"],
            "advertise": os.environ.get("MB_HERMES_ADVERTISE") or defaults["advertise"],
            "bridge": os.environ.get("MB_HERMES_APP_BRIDGE") or defaults["bridge"]}


TCP_APP_CLIENT = '''"""Agent-side stdio connection to the controller's simulated app server over an authenticated TCP bridge."""
import json, os, socket, sys, threading

config = json.load(open("/payload/app_bridge.json"))
with socket.create_connection((config["host"], config["port"]), timeout=30) as connection:
    connection.sendall(config["token"].encode() + b"\\n")
    connection.settimeout(None)

    def send():
        try:
            while data := os.read(sys.stdin.fileno(), 65536):
                connection.sendall(data)
            connection.shutdown(socket.SHUT_WR)
        except OSError:
            pass

    threading.Thread(target=send, daemon=True).start()
    while data := connection.recv(65536):
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
'''


class TcpAppBridge(socketserver.ThreadingTCPServer):
    """DolphinBench's AppBridge (one controller-side app process per connection) behind a per-turn token."""

    daemon_threads = True
    block_on_close = False
    allow_reuse_address = True
    stop = AppBridge.stop

    def __init__(self, address, command, env):
        self.command, self.env = command, env
        self.processes = set()
        self.lock = threading.Lock()
        self.token = secrets.token_urlsafe(32)
        super().__init__(address, TcpAppConnection)


class TcpAppConnection(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.settimeout(15)
        line = bytearray()
        try:
            while len(line) < 256:
                byte = self.request.recv(1)
                if not byte:
                    return
                if byte == b"\n":
                    break
                line.extend(byte)
            else:
                return
        except OSError:
            return
        if not hmac.compare_digest(bytes(line), self.server.token.encode()):
            return
        self.request.settimeout(None)
        AppConnection(self.request, self.client_address, self.server)


class ShimAgentContainer(AgentContainer):
    """DolphinBench's agent container, starting Hermes through mb_hermes_shim (recall placement only)."""

    host = None

    def __init__(self, image, payload, command, environment, app_command, app_environment, **options):
        shutil.copyfile(SHIM, Path(payload) / "runtime" / "mb_hermes_shim.py")
        position = command.index("harness.hermes_observed_cli")
        command = [*command[:position], "mb_hermes_shim", *command[position + 1:]]
        super().__init__(image, payload, command, environment, app_command, app_environment, **options)

    def run(self, output, timeout=None):
        # `docker cp` keeps the controller user's uid on the copied payload, and root in the container has no
        # CAP_DAC_OVERRIDE (--cap-drop=ALL), so Hermes couldn't write its own profile. Open the staged copy's
        # permissions instead of adding capabilities; the payload is a private temporary directory.
        for path in [self.payload, *self.payload.rglob("*")]:
            if path.is_dir():
                path.chmod(0o777)
            elif path.is_file():
                path.chmod(path.stat().st_mode | 0o666)
        if self.host["bridge"] == "unix":
            return super().run(output, timeout)
        if self.host["bridge"] != "tcp":
            raise ValueError("MB_HERMES_APP_BRIDGE must be unix or tcp")
        return self._run_tcp(output, timeout)

    def _run_tcp(self, output, timeout):
        """AgentContainer.run with the TCP app bridge instead of the bind-mounted socket; otherwise identical."""
        bridge = TcpAppBridge((self.host["bind"], 0), self.app_command, self.app_environment)
        thread = threading.Thread(target=bridge.serve_forever, daemon=True)
        thread.start()
        (self.payload / "app_client.py").write_text(TCP_APP_CLIENT)
        (self.payload / "app_bridge.json").write_text(json.dumps(
            {"host": self.host["advertise"], "port": bridge.server_address[1], "token": bridge.token}))
        created = False
        try:
            args = ["docker", "--context", "default", "create", "--name", self.name,
                    "--network", self.network, "--cap-drop=ALL",
                    "--security-opt=no-new-privileges", "--pids-limit=512",
                    "--memory=8g", "--cpus=2", "--workdir=/payload/work"]
            if sys.platform != "darwin" and self.host["advertise"] == "host.docker.internal":
                args.append("--add-host=host.docker.internal:host-gateway")
            for name, value in self.environment.items():
                if not name or "=" in name or "\x00" in name + value:
                    raise ValueError("Invalid agent environment entry")
                args += ["--env", f"{name}={value}"]
            args += ["--entrypoint", self.command[0], self.image, *self.command[1:]]
            subprocess.run(args, check=True, capture_output=True, text=True)
            created = True
            subprocess.run(["docker", "--context", "default", "cp", str(self.payload) + "/.", self.name + ":/payload"],
                           check=True, capture_output=True)
            try:
                result = subprocess.run(["docker", "--context", "default", "start", "--attach", self.name],
                                        capture_output=True, text=True, timeout=timeout)
            except subprocess.TimeoutExpired:
                subprocess.run(["docker", "--context", "default", "kill", self.name], capture_output=True)
                raise
            finally:
                copied = subprocess.Popen(["docker", "--context", "default", "cp", self.name + ":/payload/output/.", "-"],
                                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
                try:
                    extract_files(copied.stdout, output)
                    if copied.wait(timeout=60):
                        raise RuntimeError("Cannot preserve the agent's output")
                    self.output_valid = True
                finally:
                    copied.stdout.close()
                    if copied.poll() is None:
                        copied.kill()
                        copied.wait()
            return result
        finally:
            if created:
                subprocess.run(["docker", "--context", "default", "rm", "--force", self.name], capture_output=True)
            bridge.stop()
            thread.join(timeout=5)


# Each controller thread (persona or test worker) passes its own interaction's agent environment to the launcher;
# DolphinBench's adapter puts it in os.environ, which parallel personas and tests would overwrite.
_LOCAL = threading.local()
_INSTALLED = []


def _install():
    if _INSTALLED:
        return
    original = hermes_agent.run_cli

    def run_cli(command, *, env, **kwargs):
        overlay = getattr(_LOCAL, "env", None)
        if overlay is None:
            raise RuntimeError("Hermes launched outside an mb_hermes interaction")
        # The driver builds `-t` from the process environment; it must be this interaction's phase toolsets
        if command[command.index("-t") + 1] != overlay["DOLPHINBENCH_HERMES_TOOLSETS"]:
            raise RuntimeError("Hermes toolsets differ from the interaction's phase toolsets")
        inherited = {k: v for k, v in env.items() if not k.startswith("SUPERMEMORY_")
                     and k not in ("OPENAI_API_KEY", "OPENAI_BASE_URL", "CUSTOM_API_KEY")}
        return original(command, env={**inherited, **overlay}, **kwargs)

    hermes_agent.run_cli = run_cli
    hermes_agent.AgentContainer = ShimAgentContainer
    hermes_agent.PROVIDER_ENV.update(PLUGIN_ENV)  # the launcher passes only listed provider variables
    # macOS: /var is a symlink and the launcher refuses output paths under one (its turn-status temp file)
    tempfile.tempdir = os.path.realpath(tempfile.gettempdir())
    _INSTALLED.append(True)


def image_info(image):
    path = IMAGES / f"{image.removeprefix('sha256:')}.json"
    if not path.is_file():
        raise ValueError(f"No build record for {image}; build it with `mb_run.py hermes-image` so its Hermes and "
                         "plugin commits are recorded")
    return json.loads(path.read_text())


def app_calls(messages, log):
    """app_calls as the driver contract asks: each recorded app call that reached the app, with the arguments the
    model sent (DolphinBench checks them against the transcript) and the result from the app's own log, paired in
    order by tool (exact arguments first, since the log has defaults filled in)."""
    used, calls = set(), []
    for message in messages:
        for call in message.get("tool_calls") or []:
            name, arguments = call["name"], call["arguments"]
            if name == "tool_call" and isinstance(arguments.get("name"), str):  # Hermes' deferred-tool wrapper
                name, arguments = arguments["name"], arguments.get("arguments", {})
            prefix = next((p for p in MOCK_PREFIXES if name.startswith(p)), None)
            if prefix is None or not isinstance(arguments, dict):
                continue
            tool = name[len(prefix):]
            candidates = [i for i, entry in enumerate(log) if i not in used and entry.get("tool") == tool]
            match = next((i for i in candidates if all((log[i].get("args") or {}).get(k) == v
                                                       for k, v in arguments.items())), None)
            if match is None and candidates:
                match = candidates[0]
            if match is None:
                continue  # rejected before it reached the app (e.g. invalid arguments)
            used.add(match)
            entry = {"tool": tool, "args": arguments}
            if "result" in log[match]:
                entry["result"] = log[match]["result"]
            calls.append(entry)
    return calls


# Session history in a Hermes profile: state.db (sessions, messages and their search indexes, per-session usage),
# legacy session JSON and request dumps under sessions/, and the recorded submission traces
SESSION_HISTORY = ("state.db", "state.db-wal", "state.db-shm", "state.db-journal")
SESSION_HISTORY_DIRS = ("sessions", "submission-traces")


def clear_session_history(profile):
    """A test profile starts like the frozen ingestion profile (built-in memory notes, config, skills, SOUL) but with no
    prior conversations, as a new profile would: no state.db (Hermes creates a fresh one at startup) and empty
    sessions/ and submission-traces/, so session_search can't read ingestion conversations back. The frozen profile
    itself (what freeze fingerprints) is untouched."""
    for name in SESSION_HISTORY:
        (profile / name).unlink(missing_ok=True)
    for name in SESSION_HISTORY_DIRS:
        folder = profile / name
        if folder.is_dir():
            shutil.rmtree(folder)
            folder.mkdir()


def state_usage(profile):
    """Hermes' per-session, per-task token totals (state.db session_model_usage), API-reported. The submission trace
    has only the main loop's responses; this also covers Hermes' auxiliary calls (e.g. session title generation)."""
    path = profile / "state.db"
    if not path.is_file():
        return []
    with closing(sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)) as connection:
        if not connection.execute("SELECT 1 FROM sqlite_master WHERE name='session_model_usage'").fetchone():
            return []
        rows = connection.execute(
            "SELECT session_id, model, COALESCE(task, ''), api_call_count, input_tokens, output_tokens, "
            "cache_read_tokens, cache_write_tokens, reasoning_tokens FROM session_model_usage").fetchall()
    return [{"session_id": r[0], "model": r[1], "task": r[2], "calls": r[3] or 0,
             "usage": {"input_tokens": r[4] or 0, "output_tokens": r[5] or 0, "cache_read_tokens": r[6] or 0,
                       "cache_write_tokens": r[7] or 0, "reasoning_tokens": r[8] or 0}} for r in rows]


# Plugin and Hermes log lines (WARNING and up) that mean memory didn't do its job this turn; the turn carries on.
# The plugin logs recall and mirror failures only at DEBUG, so outages are also read from the proxy record
# (memory_outages). A capture refused by the proxy in tests is expected (the plugin has no read-only mode) and is
# not a failure there.
MEMORY_FAILURES = (
    (re.compile(r"Supermemory capture failed \((\w+), document"), "capture"),
    (re.compile(r"Supermemory initialization failed"), "disabled"),
    (re.compile(r"Memory provider 'supermemory' prefetch timed out"), "recall"),
    (re.compile(r"Memory provider 'supermemory' (?:sync_turn|handle_tool_call\(\w+\)) failed"), "plugin"),
)


def memory_failures(text, testing=False):
    found = []
    for line in text.splitlines():
        for pattern, where in MEMORY_FAILURES:
            if pattern.search(line):
                if not (testing and where == "capture"):
                    found.append({"where": where, "source": "log", "line": line[-300:]})
                break
    return found


def memory_outages(events):
    """Proxy-recorded Supermemory outages (unreachable, 429, 5xx) by plugin route: recall and the memory tools
    (search, profile, read) and, in ingestion, writes (document, forget)."""
    return [{"where": {"search": "recall", "profile": "recall", "read": "tool"}.get(e.get("route"), "capture"),
             "source": "proxy", "doc_id": e.get("doc_id"),
             "line": f"{e.get('method')} {e.get('path')} -> {e.get('status')} {e.get('error', '')}"[:300]}
            for e in events if e.get("route") is not None
            and (e.get("status") is None or e.get("status") == 429 or (e.get("status") or 0) >= 500)]


def recall_stats(messages):
    """What auto-recall added, read back from the recorded system prompt: the plugin's <supermemory-context> block
    (markdown profile, then "## Relevant Memories" search hits), inside Hermes' <memory-context> wrapper."""
    system = next((m.get("content") for m in messages if m["role"] == "system"), "") or ""
    match = re.search(r"<supermemory-context>(.*?)</supermemory-context>", system, re.S)
    block = match.group(1) if match else ""
    profile, _, relevant = block.partition("## Relevant Memories")
    return {"results": sum(line.startswith("- ") for line in relevant.splitlines()),
            "profile_items": sum(line.startswith("- ") for line in profile.splitlines()),
            "chars": len(block)}


def rollout(events):
    """DolphinBench's append-only rollout (harness.submission_capture.build_rollout), plus one case. On the Responses
    API, Hermes' post-response hook can record a reply without the text the model wrote alongside its tool calls,
    while the next request carries that text back to the model. The recorded reply then takes the text from that next
    request, so the transcript shows exactly what the model wrote and saw; tool calls, results and app state are
    untouched. Any other difference from earlier context fails as in DolphinBench."""
    from harness.submission import SubmissionError

    def without_content(message):
        return {k: v for k, v in _plain(message).items() if k != "content"}

    messages, settings = [], None
    for event in events:
        if event.get("error"):
            raise SubmissionError(f"Submission recording failed: {event['error']}")
        current = event["settings"]
        if settings is None:
            settings = copy.deepcopy(current)
        request = event["messages"]
        if len(request) < len(messages):
            raise SubmissionError("Conversation context was rewritten; cannot silently export it as an append-only rollout")
        for index, (old, new) in enumerate(zip(messages, request)):
            if _plain(old) == _plain(new):
                continue
            if (old.get("role") == new.get("role") == "assistant" and not str(old.get("content") or "").strip()
                    and str(new.get("content") or "").strip() and without_content(old) == without_content(new)):
                messages[index] = {**old, "content": new["content"]}
                continue
            raise SubmissionError("Conversation context was rewritten; cannot silently export it as an append-only rollout")
        messages.extend(copy.deepcopy(request[len(messages):]))
        answer = copy.deepcopy(event["assistant"])
        if current != settings:
            answer["settings"] = copy.deepcopy(current)
        messages.append(answer)
    if settings is None:
        raise SubmissionError("No recorded model responses")
    return {"settings": settings, "messages": messages}


class HermesSupermemoryHarness:
    def __init__(self, options, work_dir):
        self.options = options
        self.work_dir = Path(work_dir).resolve()
        self.run_name = options.get("run_name") or self.work_dir.name
        self.state = self.work_dir / "memorybench"
        self.ledger = Ledger(self.state / "ledger")
        self.home = self.work_dir / "hermes"
        self.profiles = self.home / "profiles"
        self.agent = options["agent"]
        self.memory_config = options.get("memory") or {}
        self.provider = self.memory_config.get("provider")
        if self.provider != "supermemory":
            raise ValueError("mb_hermes runs Hermes with the Supermemory plugin; set memory.provider: supermemory")
        if self.agent.get("api_mode", "codex_responses") != "codex_responses":
            raise ValueError("gpt-5.6 models need the Responses API (agent.api_mode: codex_responses)")
        retired = sorted({"recall", "capture"} & set(self.memory_config))
        retired += sorted(set(self.memory_config.get("settings") or {}) - {"supportingContext", "profileBuckets"})
        if retired:
            raise ValueError(f"memory: {', '.join(retired)} are not settings of this plugin; the plugin's own settings "
                             "go in memory.plugin_settings by supermemory.json key")
        self.max_turns = int(self.agent.get("max_turns", 60))
        self.timeout = int(self.agent.get("timeout_seconds", 3600))
        self.upstream = self.memory_config.get("base_url", "https://api.supermemory.ai").rstrip("/")
        self.names = _load_personas(RELEASE_ROOT)
        self._proxy = None
        self._proxy_lock = threading.Lock()
        self._configure_lock = threading.Lock()

    # ---- contract: identity ----

    def identity(self):
        image = self._image()
        templates = self._templates()
        return {
            "reference": "memorybench-hermes",
            "run_name": self.run_name,
            "driver_sha256": {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                              for p in (HERE / "mb_hermes.py", HERE / "mb_hermes_shim.py", HERE / "mb_proxy.py",
                                        HERE / "mb_memory.py", HERE / "mb_harness.py", HERE / "mb_judge.py")},
            "agent_image": image,
            "hermes": {k: v for k, v in image_info(image).items() if k in (
                "commit", "subject", "plugin_commit", "plugin_tree", "plugin_version", "memory", "dolphinbench_commit")},
            "toolsets": {"profile": TOOLSETS, **PHASE_TOOLSETS},
            "profile_templates": {p: {name: hashlib.sha256(text.encode()).hexdigest() for name, text in files.items()}
                                  for p, files in templates.items()},
            "judge_transport": judge_transport(),
            "agent": {k: v for k, v in self.agent.items() if k != "api_key_env"},
            "memory": {k: v for k, v in self.memory_config.items() if k != "api_key_env"},
            "memory_prices": SUPERMEMORY_PRICES,
            "plugin_config": {p: self._plugin_config(p) for p in self.names},
            "retry_environment": {name: os.environ.get(name, default) for name, default in (
                ("DOLPHINBENCH_SEED_RETRIES", "3"), ("DOLPHINBENCH_TEST_RETRIES", "3"),
                ("DOLPHINBENCH_RETRY_BASE_SECONDS", "5"), ("DOLPHINBENCH_RETRY_MAX_SECONDS", "60"))},
            "recording_retries": RECORDING_RETRIES,
            "python": sys.version.split()[0],
            "namespaces": {p: self._namespace(p) for p in self.names},
        }

    def _image(self):
        image = os.environ.get("DOLPHINBENCH_AGENT_IMAGE", "")
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", image):
            raise ValueError("Set DOLPHINBENCH_AGENT_IMAGE to the image ID printed by `mb_run.py hermes-image`")
        image_info(image)
        return image

    # ---- Hermes profiles ----

    def _templates(self):
        agent = {"provider": self.agent.get("provider", "custom"), "model": self.agent["model"],
                 "base_url": self.agent.get("base_url", "https://api.openai.com/v1"),
                 "api_mode": self.agent.get("api_mode", "codex_responses"),
                 "context_length": int(self.agent.get("context_length", 1050000)),
                 "reasoning_effort": self.agent.get("reasoning_effort", "high"), "max_turns": self.max_turns}
        templates = {}
        for persona, name in self.names.items():
            # App server command, paths and env are placeholders: each attempt sets them from request.apps
            job = {"id": f"supermemory-{persona}", "configuration": "builtin", "persona": persona,
                   "toolsets": toolsets_for("builtin"), "provider_identity": {}, "run_id": "per-interaction",
                   "state_path": "per-interaction", "log_path": "per-interaction",
                   "tool_config_path": "per-interaction"}
            manifest = {"root": "/dolphinbench", "agent": agent, "launch": {"mock_mcp_python": "python"}}
            # DolphinBench's profile recipe, with the plugin's own config file (supermemory.json) next to it
            config = _profile_config(job, manifest, {})
            config["memory"]["provider"] = "supermemory"
            config["toolsets"] = list(TOOLSETS)
            config["platform_toolsets"] = {platform: list(TOOLSETS) for platform in config["platform_toolsets"]}
            soul = (RELEASE_ROOT / "harness/benchmark_soul.md").read_text().replace("{{persona_name}}", name)
            templates[persona] = {"config.yaml": yaml.safe_dump(config, sort_keys=False), "SOUL.md": soul,
                                  "supermemory.json": json.dumps(self._plugin_config(persona), indent=2,
                                                                 sort_keys=True) + "\n"}
        return templates

    def _initialize(self, persona):
        destination = self.profiles / persona
        if destination.exists():
            return
        temporary = self.profiles / f"{persona}.initializing"
        if temporary.exists():
            raise ValueError("Interrupted profile initialization requires inspection")
        temporary.mkdir(parents=True)
        for name, content in self._templates()[persona].items():
            (temporary / name).write_text(content)
        temporary.rename(destination)

    # ---- memory: namespace, buckets, proxy, plugin config ----

    def _namespace(self, persona):
        """<prefix>-<run>-<persona> in the plugin's container tag form (non-alphanumerics -> "_"), so the plugin's
        container_tag and the controller's namespace are the same string."""
        prefix = self.memory_config.get("namespace_prefix", "dolphinbench-hermes")
        tag = plugin_tag(f"{prefix}-{self.run_name}-{persona}")[:100].strip("_")
        if not tag or plugin_tag(tag) != tag:
            raise ValueError(f"Cannot form a container tag for {persona}")
        return tag

    def _settings(self, persona):
        """memory.settings with the persona's first name, as mb_harness fills them (the Hermes soul keeps
        DolphinBench's full persona name), plus the plugin's dreaming mode for the controller's namespace setup."""
        settings = dict(self.memory_config.get("settings") or {})
        name = PERSONA_NAMES.get(persona, persona.title())
        if settings.get("supportingContext"):
            settings["supportingContext"] = settings["supportingContext"].replace("{persona}", name)
        if settings.get("profileBuckets"):
            settings["profileBuckets"] = {k: v.replace("{persona}", name) for k, v in settings["profileBuckets"].items()}
        dreaming = (self.memory_config.get("plugin_settings") or {}).get("dreaming")
        if dreaming:
            settings["dreaming"] = dreaming
        return settings

    def _plugin_config(self, persona):
        """The persona profile's supermemory.json: the namespace as container_tag, memory.settings.supportingContext
        (persona filled in) as entity_context (the plugin sends it as supportingContext with every write), and
        memory.plugin_settings by supermemory.json key. Everything else keeps the plugin's product default; base_url
        is left out (the proxy reaches the plugin through SUPERMEMORY_BASE_URL)."""
        extra = dict(self.memory_config.get("plugin_settings") or {})
        unknown = sorted(set(extra) - set(PLUGIN_KEYS))
        if unknown:
            raise ValueError(f"memory.plugin_settings: {unknown} are not plugin settings this adapter passes "
                             f"(allowed: {', '.join(PLUGIN_KEYS)})")
        context = self._settings(persona).get("supportingContext") or ""
        if len(context.strip()) > 1500:  # the plugin (and the API) cut it at 1500 characters
            raise ValueError(f"memory.settings.supportingContext is {len(context.strip())} characters for {persona}; "
                             "the plugin truncates it at 1500")
        return {"container_tag": self._namespace(persona), **({"entity_context": context} if context else {}),
                **extra}

    def _api_key(self):
        key_env = self.memory_config.get("api_key_env", "SUPERMEMORY_API_KEY")
        if not os.environ.get(key_env):
            raise RuntimeError(f"{key_env} is not set")
        return os.environ[key_env]

    def _supermemory(self, persona, writable, phase):
        """Controller-side client (real key, no proxy): bucket setup, processing waits, snapshots, rollback,
        reconcile."""
        return Supermemory(self._namespace(persona), self._settings(persona), {}, self._api_key(), self.upstream,
                           writable, self.ledger, persona, phase)

    def _configure(self, persona):
        """Profile buckets before a persona's first conversation, as in mb_harness (they are never backfilled)."""
        marker = self.state / f"configured-{persona}"
        with self._configure_lock:
            if marker.exists():
                return
            self._supermemory(persona, writable=True, phase="ingestion").configure()
            marker.parent.mkdir(parents=True, exist_ok=True)
            marker.write_text(self._namespace(persona))

    def _proxy_server(self):
        with self._proxy_lock:
            if self._proxy is None:
                self.host = host_settings()
                ShimAgentContainer.host = self.host
                self._proxy = SupermemoryProxy(
                    self.upstream, self._api_key(), bind=self.host["bind"], count_tokens=count_tokens)
            return self._proxy

    # ---- contract: interactions ----

    def run_interaction(self, request):
        from harness.hermes_driver import _failure_details, _retry_delay
        from harness.submission import SubmissionError

        _install()
        self._image()
        # Read by DolphinBench's driver from the process environment: constant for the run, and the toolsets
        # constant for a stage (ingestion and tests never overlap; run_cli checks each launch)
        os.environ.update({"HERMES_HOME": str(self.home), "DOLPHINBENCH_CAPTURE_SUBMISSION": "1",
                           "DOLPHINBENCH_HERMES_TOOLSETS": ",".join(PHASE_TOOLSETS[request.phase])})
        testing = request.phase == "tests"
        persona, item = request.persona, request.interaction_id
        if not testing:
            self._configure(persona)
        retries = int(os.environ.get("DOLPHINBENCH_TEST_RETRIES" if testing else "DOLPHINBENCH_SEED_RETRIES", "3"))
        journal = self.home / "attempts" / request.phase / persona / f"{item}.json"
        if journal.exists():
            raise ValueError("Saved interaction attempts already exist; refusing to replay (run reconcile)")
        state_path = request.apps["env"].get("DOLPHINBENCH_STATE_PATH")
        initial_state = Path(state_path).read_bytes() if testing and state_path else None
        attempts, used = [], {"recording": 0, "transient": 0}
        for number in range(1, retries + RECORDING_RETRIES + 2):
            if number > 1 and initial_state is not None:
                Path(state_path).write_bytes(initial_state)
                Path(request.apps["env"]["DOLPHINBENCH_LOG_PATH"]).write_text("")
            if not testing:
                self._snapshot(request, number)
            result, recording, duration, delivery, memory_failed, events = self._attempt(request, number)
            failure = _failure_details(result)
            trace, recording_error = None, None
            try:
                trace = self._export(request, recording)
            except SubmissionError as error:
                recording_error = str(error)[:1000]
            attempts.append({"attempt": number, "driver_ok": result.ok and not memory_failed,
                             "driver_error": result.error, "memory_failures": memory_failed,
                             "recording_error": recording_error,
                             "latency_seconds": duration / 1000, "transport_failure": failure.__dict__,
                             "seed_delivery_state": delivery, "session_id": result.session_id,
                             "recording": str(recording) if recording else None,
                             **({} if result.ok else {"stderr_tail": (result.stderr or "")[-3000:],
                                                      "stdout_tail": (result.stdout or "")[-1000:]})})
            # Reruns depend only on how the attempt ran, never on its answer (grading comes after):
            # 1. DolphinBench's recorder couldn't export a turn Hermes completed (e.g. context rewritten by Hermes'
            #    empty-reply nudge, a malformed recording): rerun it, up to RECORDING_RETRIES times.
            # 2. A transient Hermes failure (as DolphinBench's driver retries it), or a test that ran without
            #    working memory (recall, a memory tool): rerun, as mb_harness reruns an interaction a Supermemory
            #    outage aborted. Ingestion with a memory failure stops for reconcile instead.
            reason = None
            if (recording_error is not None and (result.ok or recording is not None) and not memory_failed
                    and used["recording"] < RECORDING_RETRIES):
                reason = "recording"
            elif ((failure.transient and not result.ok and (testing or delivery == "known_not_delivered"))
                  or (testing and memory_failed)) and used["transient"] < retries:
                reason = "memory" if testing and memory_failed and result.ok else "transient"
            if reason:
                used["recording" if reason == "recording" else "transient"] += 1
                error = recording_error if reason == "recording" else (
                    ", ".join(memory_failed) if reason == "memory" else result.error)
                attempts[-1]["retry"] = {"reason": reason, "error": str(error or "")[:1000]}
                if not testing:
                    # Back to the state before this attempt: built-in memory, app state, Supermemory documents
                    attempts[-1]["retry"]["rollback"] = self._rollback(request, number, events)
                save_json(journal, attempts)
                self.ledger.event(persona, request.phase, {"t": "retry", "id": item, "attempt": number,
                                                           "reason": reason, "error": str(error or "")[:300]})
                print(f"{request.phase}/{persona}/{item}: attempt {number} {reason} failure ({str(error)[:200]}); "
                      "retrying", flush=True)
                if reason != "recording":
                    time.sleep(_retry_delay(failure, used["transient"]))
                continue
            save_json(journal, attempts)
            break
        if memory_failed:
            raise RuntimeError(f"Supermemory failed during this interaction ({', '.join(memory_failed)}; see "
                               "output/hermes/logs); run reconcile, then resume")
        if not testing and delivery != "delivered":
            raise RuntimeError(f"Hermes ingestion capture {delivery}: {result.error}")
        if trace is None:
            raise RuntimeError(f"Hermes interaction has no exportable recorded conversation "
                               f"({recording_error or result.error}); run reconcile, then resume")
        if not testing:
            self._drop_snapshot(persona)
        self.ledger.event(persona, request.phase, {"t": "recall", "id": item, **recall_stats(trace["messages"])})
        log = load_tool_calls(Path(request.apps["env"]["DOLPHINBENCH_LOG_PATH"]))
        return InteractionRecord(trace["settings"], trace["messages"], duration, attempts,
                                 app_calls=app_calls(trace["messages"], log))

    @staticmethod
    def _export(request, recording):
        """The conversation as DolphinBench's runner will save it, with the checks it applies (strict JSON, append-
        only rollout, message and settings checks, the dated request as the only user message). Raises
        SubmissionError when it can't be exported."""
        from harness.submission import SubmissionError, check_messages, check_settings, load_json

        if recording is None:
            raise SubmissionError("No recorded trace for the Hermes session")
        try:
            trace = rollout([load_json(line) for line in recording.read_text().splitlines() if line.strip()])
        except SubmissionError:
            raise
        except (KeyError, TypeError, ValueError, AttributeError) as error:
            raise SubmissionError(f"Malformed recording: {type(error).__name__}: {error}") from None
        label = f"{request.phase}/{request.persona}/{request.interaction_id}"
        check_settings(trace["settings"], label)
        check_messages(trace["messages"], label)
        if [m["content"] for m in trace["messages"] if m["role"] == "user"] != [request.dated_message]:
            raise SubmissionError("Recorded conversation has a different user message or conversation boundary")
        return trace

    def _attempt(self, request, number):
        from harness.hermes_driver import _validate_hermes_runtime_tools

        persona, phase, item = request.persona, request.phase, request.interaction_id
        testing = phase == "tests"
        self._initialize(persona)
        profile = persona
        if testing:
            profile = f"{persona}-test-{item}-a{number:02d}"
            if (self.profiles / profile).exists():
                raise ValueError("Test profile already exists; refusing to replay (run reconcile)")
            copy_profile(self.profiles / f"{persona}-frozen", self.profiles / profile)
            clear_session_history(self.profiles / profile)
        directory = self.profiles / profile
        config_path = directory / "config.yaml"
        config = yaml.safe_load(config_path.read_text())
        config["mcp_servers"]["dolphinbench-apps"].update(request.apps)
        config_path.write_text(yaml.safe_dump(config, sort_keys=False))
        traces = directory / "submission-traces"
        before = set(traces.glob("*.jsonl")) if traces.exists() else set()
        sessions_before = {row["session_id"] for row in state_usage(directory)}

        proxy = self._proxy_server()
        # Ingestion writes are dated with the interaction's narrative time (when the plugin sends no date)
        session = proxy.open_session(self._namespace(persona), phase, f"{phase}/{persona}/{item}/a{number}",
                                     journal=self._proxy_journal(phase, persona, item, number),
                                     date=None if testing else request.narrative_time)
        seed_item = f"{persona}-{item}"
        receipts = self.home / "receipts" / persona / f"{item}-a{number}.jsonl"
        if not testing:
            receipts.parent.mkdir(parents=True, exist_ok=True)
        key_env = self.agent.get("api_key_env", "OPENAI_API_KEY")
        if not os.environ.get(key_env):
            raise RuntimeError(f"{key_env} is not set")
        _LOCAL.env = {
            "OPENAI_API_KEY": os.environ[key_env],
            "DOLPHINBENCH_HERMES_TOOLSETS": ",".join(PHASE_TOOLSETS[phase]),
            # DolphinBench's read-only flags (its evaluation build makes built-in memory read-only in tests). The
            # plugin has no read-only mode; in tests the proxy refuses its writes.
            **{key: "1" if testing else "0" for key in READ_ONLY},
            # The plugin writes the conversation's document on Hermes' memory worker after the turn (and retries a
            # failed write at session end and shutdown); let that finish before Hermes exits
            "HERMES_MEMORY_SYNC_DRAIN_TIMEOUT_SECONDS": "600",
            "HERMES_EXIT_WATCHDOG_S": "720",
            "SUPERMEMORY_API_KEY": session.token,
            "SUPERMEMORY_BASE_URL": f"http://{self.host['advertise']}:{proxy.port}",
            # Ingestion: the seed item whose receipt mb_hermes_shim writes when the conversation's document is stored
            **({} if testing else {"DOLPHINBENCH_SEED_ITEM_ID": seed_item, SEED_RECEIPTS: str(receipts)}),
        }
        started, result = time.monotonic(), None
        try:
            result = hermes_driver.run_hermes(profile, request.message, timeout=self.timeout, model=None,
                                              narrative_time=request.narrative_time)
            duration = (time.monotonic() - started) * 1000
        finally:
            _LOCAL.env = None
            events = proxy.close_session(session)
            new = sorted(set(traces.glob("*.jsonl")) - before) if traces.exists() else []
            recording, failures = self._account(request, number, events, new,
                                                result.session_id if result else None, directory,
                                                sessions_before)
        if result.session_id or getattr(result, "available_tools", None):
            _validate_hermes_runtime_tools(result, "test" if testing else "seed", item, "supermemory")
        delivery = None
        failures = failures + memory_outages(events)
        if not testing:
            delivery, conversation = self._delivery(events, result.session_id)
            if delivery == "delivered":
                # The plugin retries a failed write of the conversation document (at session end, shutdown); once
                # it is stored, the earlier failure didn't cost anything
                failures = [f for f in failures if not (f["where"] == "capture" and (
                    f.get("source") == "log" or f.get("doc_id") == conversation))]
            # mb_hermes_shim's seed receipt (written when the plugin's write of the conversation was accepted)
            seed_receipt = receipts.is_file() and seed_item in receipts.read_text()
            if (delivery == "delivered") != seed_receipt:
                self.ledger.event(persona, phase, {"t": "receipt_mismatch", "id": item, "attempt": number,
                                                   "proxy": delivery, "seed_receipt": seed_receipt})
        if testing:
            shutil.rmtree(directory)
        return result, recording, duration, delivery, sorted({f["where"] for f in failures}), events

    def _account(self, request, number, events, new_traces, session_id, directory, sessions_before):
        """Ledger records for one attempt (agent usage, memory operations, captures, errors); archives its traces
        and logs out of the profile so the profile copied into each container doesn't grow with them. Returns the
        trace of the matched Hermes session, if any, and the memory failures the logs show."""
        persona, phase, item = request.persona, request.phase, request.interaction_id
        archive = self.home / "traces" / phase / persona
        archive.mkdir(parents=True, exist_ok=True)
        recording, traced = None, {}
        for path in new_traces:
            for line in path.read_text().splitlines():
                if not line.strip():
                    continue
                event = json.loads(line)
                if event.get("error"):
                    self.ledger.event(persona, phase, {"t": "trace_error", "id": item, "attempt": number,
                                                       "error": event["error"]})
                    continue
                usage = (event.get("assistant") or {}).get("usage")
                self.ledger._append(phase, persona, {"t": "agent", "id": item, "attempt": number,
                                                     "model": event["settings"].get("model"), "usage": usage})
                traced[path.stem] = traced.get(path.stem, 0) + 1
            target = archive / f"{item}-a{number:02d}-{path.name}"
            shutil.move(path, target)
            if session_id and path.stem == session_id:
                recording = target
        # Auxiliary model calls of this attempt's sessions, and a check that the trace has every main-loop call
        for row in state_usage(directory):
            if row["session_id"] in sessions_before:
                continue
            if row["task"]:
                self.ledger._append(phase, persona, {"t": "agent_aux", "id": item, "attempt": number, **row})
            elif row["calls"] != traced.get(row["session_id"], 0):
                self.ledger.event(persona, phase, {"t": "usage_mismatch", "id": item, "attempt": number,
                                                   "session_id": row["session_id"], "state_db_calls": row["calls"],
                                                   "traced_calls": traced.get(row["session_id"], 0)})
        logs, failures = directory / "logs", []
        if logs.is_dir():
            # agent.log has every level (errors.log repeats its warnings and errors)
            log = logs / "agent.log" if (logs / "agent.log").is_file() else logs / "errors.log"
            failures = memory_failures(log.read_text(errors="replace"), testing=phase == "tests") if log.is_file() else []
            for failure in failures:
                self.ledger.event(persona, phase, {"t": "memory_failure", "id": item, "attempt": number, **failure})
            kept = self.home / "logs" / phase / persona / f"{item}-a{number:02d}"
            kept.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(logs, kept)
        for event in events:
            record = {"t": "proxy", "id": item, "attempt": number, **event}
            self.ledger._append(phase, persona, record)
            status, route = event.get("status") or 0, event.get("route")
            if status == 405 or route is None:
                self.ledger.event(persona, phase, {"t": "proxy_denied", "id": item, "method": event["method"],
                                                   "path": event["path"]})
            elif status >= 500 or status == 429 or event.get("status") is None:
                self.ledger.event(persona, phase, {"t": "memory_error", "id": item, "where": route,
                                                   "error": f"{event.get('status')} {event.get('error', '')}"[:300]})
            elif status < 300 and route == "document":
                self.ledger.memory(persona, phase, "document")
                self.ledger.memory(persona, phase, "memory_tokens", event.get("tokens", 0))
                if event.get("dreaming") == "instant":
                    self.ledger.memory(persona, phase, "operation")
                self.ledger._append("ingestion", persona, {"t": "capture", "id": item, "attempt": number,
                                                           "doc_id": event.get("stored_id") or event.get("doc_id")})
            elif status < 300 and route == "forget":
                self.ledger.event(persona, phase, {"t": "forget", "id": item, "attempt": number,
                                                   "memory_ids": event.get("memory_ids") or []})
            elif status < 300 and route in ("search", "profile"):
                self.ledger.memory(persona, phase, "search")
                if event.get("rewrite"):
                    self.ledger.memory(persona, phase, "operation")
                if event.get("rerank"):
                    self.ledger.memory(persona, phase, "operation")
        return recording, failures

    @staticmethod
    def _delivery(events, session_id):
        """Capture receipt from the proxy: (state, conversation document id). The plugin stores a conversation as one
        document under its own id, hermes_<session id>, re-sent whole after each turn; its other writes (notes from
        supermemory_store and mirrored built-in memory writes) carry no id and get one from Supermemory."""
        documents = [e for e in events if e.get("route") == "document"]
        named = {e.get("doc_id") for e in documents if e.get("doc_id")}
        expected = f"hermes_{plugin_tag(session_id) or 'hermes'}" if session_id else (
            next(iter(named)) if len(named) == 1 else None)
        unexpected = named - {expected}
        if unexpected:
            raise RuntimeError(f"The plugin wrote documents {sorted(unexpected)}; expected only this conversation's "
                               f"({expected}) and notes without ids")
        if any(e.get("doc_id") == expected and 0 < (e.get("status") or 0) < 300 for e in documents):
            return "delivered", expected
        # Never sent, or refused by the proxy or by Supermemory's validation: a retry can't duplicate it
        reached = [e for e in documents if e.get("doc_id") == expected
                   and (e.get("status") or 0) not in range(400, 500)]
        return ("ambiguous" if reached else "known_not_delivered"), expected

    # ---- rollback of a failed ingestion attempt (automatic retry, reconcile) ----

    def _proxy_journal(self, phase, persona, item, number):
        return self.home / "proxy" / phase / persona / f"{item}-a{number:02d}.jsonl"

    def _snapshot_dir(self, persona):
        return self.home / "rollback" / persona

    def _snapshot(self, request, number):
        """Before an ingestion attempt: Hermes' built-in memory files and the persona's ingestion app state, kept on
        disk (one slot per persona) so a retry or a reconcile after a crash can put them back."""
        persona = request.persona
        self._initialize(persona)
        slot = self._snapshot_dir(persona)
        temporary = slot.with_name(f"{persona}.saving")
        shutil.rmtree(temporary, ignore_errors=True)
        temporary.mkdir(parents=True)
        memories = self.profiles / persona / "memories"
        if memories.is_dir():
            shutil.copytree(memories, temporary / "memories")
        state = Path(request.apps["env"]["DOLPHINBENCH_STATE_PATH"])
        if state.is_file():
            shutil.copyfile(state, temporary / "app_state.json")
        (temporary / "meta.json").write_text(json.dumps({
            "item": request.interaction_id, "attempt": number, "ts": time.time(), "app_state": str(state),
            "app_log": request.apps["env"]["DOLPHINBENCH_LOG_PATH"], "memories": memories.is_dir()}))
        shutil.rmtree(slot, ignore_errors=True)
        temporary.rename(slot)

    def _drop_snapshot(self, persona):
        shutil.rmtree(self._snapshot_dir(persona), ignore_errors=True)

    def _restore_snapshot(self, persona, item):
        """Puts back the built-in memory files and ingestion app state saved before `item`'s latest attempt.
        Returns what was restored ({} if there is no snapshot for this item)."""
        slot = self._snapshot_dir(persona)
        meta = json.loads((slot / "meta.json").read_text()) if (slot / "meta.json").is_file() else {}
        if meta.get("item") != item:
            return {}
        memories = self.profiles / persona / "memories"
        shutil.rmtree(memories, ignore_errors=True)
        if meta["memories"]:
            shutil.copytree(slot / "memories", memories)
        if (slot / "app_state.json").is_file():
            shutil.copyfile(slot / "app_state.json", meta["app_state"])
        Path(meta["app_log"]).write_text("")
        return {"built_in_memory": sorted(p.name for p in (slot / "memories").glob("*")) if meta["memories"] else [],
                "app_state": (slot / "app_state.json").is_file(), "snapshot_attempt": meta["attempt"]}

    def _attempt_documents(self, persona, item, events, since):
        """Supermemory documents an attempt (or several, for reconcile) of `item` stored: every document write the
        proxy forwarded and didn't see refused (its id, or the id Supermemory gave it), plus anything in the
        namespace created since the attempt started that no other interaction stored (a write whose response was
        lost has no known id). The namespace is the persona's own, and a persona's history runs one message at a
        time."""
        ids = set()
        for event in events:
            if event.get("route") != "document" or (event.get("status") or 0) in range(400, 500):
                continue
            ids.update(i for i in (event.get("stored_id"), event.get("doc_id")) if i)
        memory = self._supermemory(persona, writable=True, phase="ingestion")
        if since is not None:
            others = {r["doc_id"] for r in self.ledger.records("ingestion", persona)
                      if r["t"] == "capture" and r.get("id") != item and r.get("doc_id")}
            ids.update(d["id"] for d in memory.documents_since(since - 300) if d["id"] not in others)
        return memory, sorted(ids)

    def _rollback(self, request, number, events):
        """Undoes a failed ingestion attempt before it is rerun: built-in memory files and app state back to the
        snapshot, and the Supermemory documents it stored deleted (their memories go with them). Memories it
        forgot (supermemory_forget) can't be restored and are listed."""
        persona, item = request.persona, request.interaction_id
        restored = self._restore_snapshot(persona, item)
        started = next((r.get("ts") for r in self._journal_records(self._proxy_journal(
            "ingestion", persona, item, number)) if r.get("t") == "start"), None)
        memory, documents = self._attempt_documents(persona, item, events, started)
        deleted = [doc_id for doc_id in documents if memory.delete_document(doc_id)]
        forgotten = sorted({i for e in events if e.get("route") == "forget" and 0 < (e.get("status") or 0) < 300
                            for i in e.get("memory_ids") or []})
        self.ledger.event(persona, "ingestion", {"t": "rollback", "id": item, "attempt": number,
                                                 "doc_ids": deleted, "forgotten_not_restored": forgotten})
        receipts = self.home / "receipts" / persona / f"{item}-a{number}.jsonl"
        if receipts.exists():
            receipts.rename(receipts.with_name(f"rolled-back-{receipts.name}"))
        return {**restored, "deleted_documents": deleted, "forgotten_memories_not_restored": forgotten}

    @staticmethod
    def _journal_records(path):
        if not path.is_file():
            return []
        return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]

    def _removed_documents(self, persona):
        return {d for r in self.ledger.records("ingestion", persona) if r["t"] == "rollback"
                for d in r.get("doc_ids") or []}

    def retry_summary(self, phase):
        """Automatic reruns logged in the attempt journals (completed, in-flight and reconciled interactions)."""
        reasons = {}
        for path in (self.home / "attempts" / phase).glob("*/*.json"):
            for attempt in json.loads(path.read_text()):
                if attempt.get("retry"):
                    reasons[attempt["retry"]["reason"]] = reasons.get(attempt["retry"]["reason"], 0) + 1
        return reasons

    # ---- contract: freeze / verify ----

    def _freeze_profile(self, persona):
        source, destination = self.profiles / persona, self.profiles / f"{persona}-frozen"
        if not destination.exists():
            temporary = self.profiles / f"{persona}.freezing"
            if temporary.exists():
                raise ValueError("Interrupted memory freeze requires inspection")
            copy_profile(source, temporary)
            temporary.rename(destination)
        return tree_identity(destination)

    def freeze(self, persona):
        """Waits for every document in the persona's namespace (listed, since the plugin names notes nothing and the
        conversation documents after Hermes sessions) and checks that every document the proxy saw stored, and no
        rollback or reconcile deleted, is among them."""
        files = self._freeze_profile(persona)
        memory = self._supermemory(persona, writable=False, phase="ingestion")
        listed = memory.document_ids()
        stored = {r["doc_id"] for r in self.ledger.records("ingestion", persona) if r["t"] == "capture"
                  and r.get("doc_id")} - self._removed_documents(persona)
        extra = sorted(set(listed) - stored)
        if extra:
            print(f"[{persona}] {len(extra)} documents in the namespace that the proxy didn't record: {extra[:5]}",
                  flush=True)
        memory.wait_until_processed(sorted(set(listed) | stored), progress=lambda done, total: print(
            f"[{persona}] memory processing {done}/{total}", flush=True))
        snapshot = {"persona": persona, **memory.snapshot(), "hermes_profile": files}
        path = self.state / "checkpoints" / f"{persona}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(snapshot, indent=2))
        return snapshot

    def verify_checkpoint(self, persona, checkpoint):
        frozen = self.profiles / f"{persona}-frozen"
        if not frozen.is_dir() or tree_identity(frozen) != checkpoint.get("hermes_profile"):
            raise ValueError(f"{persona}: frozen Hermes profile (built-in memory, sessions) changed since freeze")
        current = self._supermemory(persona, writable=False, phase="tests").snapshot()
        if current.get("sha256") != checkpoint.get("sha256") or current.get("namespace") != checkpoint.get("namespace"):
            raise ValueError(f"{persona}: memory changed since freeze "
                             f"(documents {checkpoint.get('documents')} -> {current.get('documents')}, "
                             f"memories {checkpoint.get('memories')} -> {current.get('memories')})")

    # ---- contract: cost ----

    def total_cost_usd(self, phase):
        prices = self.agent.get("prices_per_1m") or {}
        if any(prices.get(k) is None for k in ("input", "cached_input", "output")):
            raise ValueError("Set agent.prices_per_1m (input, cached_input, output) to report cost")
        agent_usd = 0.0
        for record in self.ledger.records(phase):
            if record["t"] not in ("agent", "agent_aux"):
                continue
            if record.get("model") not in (None, self.agent["model"]):
                raise ValueError(f"Usage from an unpriced model: {record.get('model')}")
            tokens = token_counts(record["usage"])  # every response's API-reported usage, retries included
            agent_usd += ((tokens["input_tokens"] + tokens["cache_creation_input_tokens"]) * prices["input"]
                          + tokens["cache_read_input_tokens"] * prices["cached_input"]
                          + tokens["output_tokens"] * prices["output"]) / 1e6
        return round(agent_usd + self.memory_cost(phase), 6)

    def memory_cost(self, phase):
        """Every write and search the proxy forwarded, retried and rolled-back attempts included."""
        totals = {}
        for record in self.ledger.records(phase):
            if record["t"] == "memory":
                totals[record["op"]] = totals.get(record["op"], 0) + record["n"]
        p = SUPERMEMORY_PRICES
        return (totals.get("memory_tokens", 0) / 1000 * p["memory_per_1k_tokens"]
                + totals.get("search", 0) / 1000 * p["search_per_1k_queries"]
                + totals.get("operation", 0) / 1000 * p["operation_per_1k"])

    # ---- reconcile (mb_run reconcile) ----

    def reconcile(self, phase, persona, item):
        """Clears one interrupted interaction so a resume reruns it. Ingestion: deletes the Supermemory documents its
        attempts stored (from the proxy's on-disk journal, plus anything created in the namespace since it started
        that no other message stored) and puts back the built-in memory files and app state saved before its last
        attempt. Sets aside its attempt journal, proxy journals, traces, receipts and test profiles (kept for
        inspection; their usage stays in the ledger)."""
        notes, stamp = [], time.strftime("%Y%m%d%H%M%S")
        journals = sorted((self.home / "proxy" / phase / persona).glob(f"{item}-a*.jsonl"))
        if phase == "ingestion":
            records = [r for path in journals for r in self._journal_records(path)]
            events = [r for r in records if r.get("t") in ("event", "sending")]
            starts = [r["ts"] for r in records if r.get("t") == "start"]
            memory, documents = self._attempt_documents(persona, item, events, min(starts) if starts else None)
            deleted = [doc_id for doc_id in documents if memory.delete_document(doc_id)]
            if deleted:
                self.ledger.event(persona, "ingestion", {"t": "rollback", "id": item, "doc_ids": deleted,
                                                         "reconcile": True})
                notes.append(f"deleted {len(deleted)} documents it stored")
            if self._restore_snapshot(persona, item):
                notes.append("restored built-in memory and app state from before its last attempt")
            self._drop_snapshot(persona)
        journal = self.home / "attempts" / phase / persona / f"{item}.json"
        if journal.exists():
            journal.rename(journal.with_name(f"{item}.reconciled-{stamp}.json"))
            notes.append("set aside its attempt journal")
        for path in journals:
            path.rename(path.with_name(f"reconciled-{stamp}-{path.name}"))
        # Seed receipts too: with its documents deleted, a leftover receipt would disagree with the namespace
        for kind in ("traces", "receipts"):
            for path in (self.home / kind / (phase if kind == "traces" else "") / persona).glob(f"{item}-a*.jsonl"):
                path.rename(path.with_name(f"reconciled-{stamp}-{path.name}"))
        if phase == "tests":
            for leftover in self.profiles.glob(f"{persona}-test-{item}-a*"):
                shutil.rmtree(leftover)
        return ", ".join(notes)
