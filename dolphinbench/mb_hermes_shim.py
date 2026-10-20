"""Runs inside the Hermes agent container in place of DolphinBench's `harness.hermes_observed_cli` entry point.

Three additions the driver contract needs and the plugin doesn't provide, then DolphinBench's observed CLI runs
unchanged (same trace capture, turn status and tools):

- Recall placement. Hermes appends a memory provider's recalled context to the API copy of the user message.
  DolphinBench requires the dated request to be the conversation's only, unchanged user message, so the same recalled
  block (Hermes' own <memory-context> wrapper, byte for byte) goes in the system prompt instead, through Hermes'
  ephemeral system prompt, which it adds to the system message of every model call in the session. The recorded trace
  therefore shows exactly what the model was sent. Each interaction is a fresh one-turn Hermes session, so nothing
  carries over.
- Seed receipts. DolphinBench's Hermes driver treats Supermemory as a receipt-backed provider: a history message
  counts as stored only with one `automatic_sync_turn` receipt for its seed item. The Supermemory plugin knows nothing
  about this and is not changed: the shim observes its writes from outside, by wrapping the plugin client's write call
  (`_SupermemoryClient.add_memory`) on the class. When the conversation's own document (the write that carries the
  plugin's per-conversation id, `hermes_<session id>`) is accepted, it appends the receipt with the evaluation build's
  own receipt helpers, once per seed item. The write itself goes through unchanged (same arguments, same result or
  error); notes saved by the plugin's tools or mirrored from built-in memory carry no id and get no receipt.
- Read-only tools in tests. DolphinBench's driver refuses a test session that offers memory write tools
  (harness.hermes_driver._validate_hermes_runtime_tools), and the plugin has no read-only mode. Under DolphinBench's
  own read-only flag (DOLPHINBENCH_SUPERMEMORY_READ_ONLY, set for tests) the shim leaves the plugin's write tools
  (supermemory_store / supermemory_forget and their kebab-case aliases) out of the tools Hermes offers, as
  DolphinBench's evaluation build does for its bundled provider; the read tools are unchanged. The plugin's own
  automatic capture still runs and is refused by the proxy (405), which the plugin logs without failing the turn.
"""

import importlib.abc
import importlib.machinery
import sys
import threading

SEED_RECEIPTS = "DOLPHINBENCH_SUPERMEMORY_SEED_RECEIPTS"


def relocate_recall(memory_manager_module):
    manager = memory_manager_module.MemoryManager
    if getattr(manager, "_mb_recall_relocated", False):
        return
    original = manager.prefetch_all

    def prefetch_all(self, query, *args, **kwargs):
        raw = original(self, query, *args, **kwargs) or ""
        self._mb_recall = memory_manager_module.build_memory_context_block(raw) if raw.strip() else ""
        return ""

    manager.prefetch_all = prefetch_all
    manager._mb_recall_relocated = True


def recall_in_system_prompt(agent_class):
    if getattr(agent_class, "_mb_recall_relocated", False):
        return

    def get(self):
        base = self.__dict__.get("_mb_ephemeral_system_prompt")
        recall = getattr(self.__dict__.get("_memory_manager"), "_mb_recall", "")
        if not recall or (isinstance(base, str) and recall in base):
            return base
        return f"{base}\n\n{recall}" if base else recall

    def set(self, value):
        self.__dict__["_mb_ephemeral_system_prompt"] = value

    agent_class.ephemeral_system_prompt = property(get, set)
    agent_class._mb_recall_relocated = True


def receipt_on_capture(client_class):
    """Wraps the plugin client's add_memory (class level, so every client the provider builds is covered) to write
    the seed receipt after the conversation document's write is accepted. Arguments, result and errors pass through."""
    from agent import benchmark_memory as receipts  # DolphinBench's evaluation build of Hermes

    if getattr(client_class, "_mb_seed_receipts", False):
        return
    add_memory, lock = client_class.add_memory, threading.Lock()

    def add_memory_with_receipt(self, content, *args, **kwargs):
        result = add_memory(self, content, *args, **kwargs)
        document_id = kwargs.get("custom_id")
        if document_id and not kwargs.get("container_tag"):  # the conversation document, primary container
            metadata = kwargs.get("metadata") if isinstance(kwargs.get("metadata"), dict) else (
                args[0] if args and isinstance(args[0], dict) else {})
            with lock:
                if not receipts.seed_item_has_receipt(SEED_RECEIPTS, "supermemory"):
                    receipts.write_seed_receipt(SEED_RECEIPTS, "supermemory", details={
                        "namespace": getattr(self, "_container_tag", None),
                        "document_id": (result or {}).get("id") or document_id,
                        "conversation_id": document_id,
                        "hermes_session_id": metadata.get("session_id"),
                    })
        return result

    client_class.add_memory = add_memory_with_receipt
    client_class._mb_seed_receipts = True


def seed_receipts(memory_manager_module):
    """Every provider Hermes registers goes through MemoryManager.add_provider; the Supermemory plugin's client class
    is found from the provider's own module there."""
    manager = memory_manager_module.MemoryManager
    if getattr(manager, "_mb_seed_receipts", False):
        return
    original = manager.add_provider

    def add_provider(self, provider):
        if getattr(provider, "name", "") == "supermemory":
            from agent import benchmark_memory as receipts
            if receipts.seed_item(SEED_RECEIPTS) is not None:
                client_class = getattr(sys.modules.get(type(provider).__module__), "_SupermemoryClient", None)
                if client_class is None or not callable(getattr(client_class, "add_memory", None)):
                    raise RuntimeError("Supermemory plugin has no _SupermemoryClient.add_memory to observe for receipts")
                receipt_on_capture(client_class)
        return original(self, provider)

    manager.add_provider = add_provider
    manager._mb_seed_receipts = True


WRITE_TOOLS = {"supermemory_store", "supermemory_forget", "supermemory-save", "supermemory-forget"}


def read_only_tools(provider):
    """Drops the plugin's write tools from this provider's schemas (tests); a call to one is refused."""
    schemas, call = provider.get_tool_schemas, provider.handle_tool_call

    def get_tool_schemas():
        return [schema for schema in schemas() if schema.get("name") not in WRITE_TOOLS]

    def handle_tool_call(tool_name, args, **kwargs):
        if tool_name in WRITE_TOOLS:
            from tools.registry import tool_error
            return tool_error("Supermemory writes are disabled for this evaluation.")
        return call(tool_name, args, **kwargs)

    provider.get_tool_schemas, provider.handle_tool_call = get_tool_schemas, handle_tool_call


def read_only_tests(memory_manager_module):
    manager = memory_manager_module.MemoryManager
    if getattr(manager, "_mb_read_only_tools", False):
        return
    original = manager.add_provider

    def add_provider(self, provider):
        if getattr(provider, "name", "") == "supermemory":
            from agent.benchmark_memory import memory_is_read_only
            if memory_is_read_only("supermemory"):
                read_only_tools(provider)
        return original(self, provider)

    manager.add_provider = add_provider
    manager._mb_read_only_tools = True


def patch_memory_manager(module):
    relocate_recall(module)
    seed_receipts(module)
    read_only_tests(module)


class Finder(importlib.abc.MetaPathFinder):
    """Patches modules as they load, so Hermes still selects its profile before importing the agent."""

    patches = {"agent.memory_manager": patch_memory_manager,
               "run_agent": lambda module: recall_in_system_prompt(module.AIAgent)}

    def find_spec(self, fullname, path=None, target=None):
        if fullname not in self.patches:
            return None
        spec = importlib.machinery.PathFinder.find_spec(fullname, path)
        if spec is None or spec.loader is None:
            return None
        original, patch = spec.loader, self.patches[fullname]

        class Loader(importlib.abc.Loader):
            def create_module(self, spec):
                return original.create_module(spec)

            def exec_module(self, module):
                original.exec_module(module)
                patch(module)

        spec.loader = Loader()
        return spec


def main():
    from harness import hermes_observed_cli as observed

    # DolphinBench's turn-status finder loads run_agent ahead of this one; patch the class it hands to observe_turns.
    observe = observed.observe_turns

    def observe_turns(agent_class, path):
        recall_in_system_prompt(agent_class)
        return observe(agent_class, path)

    observed.observe_turns = observe_turns
    if "agent.memory_manager" in sys.modules:
        patch_memory_manager(sys.modules["agent.memory_manager"])
    sys.meta_path.insert(0, Finder())
    observed.main()


if __name__ == "__main__":
    main()
