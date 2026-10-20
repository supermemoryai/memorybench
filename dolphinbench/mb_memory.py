"""Memory backends for the DolphinBench driver: hosted Supermemory (v5 API, through the official supermemory SDK)
and none."""

from __future__ import annotations

import hashlib
import json
import random
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

# Public list prices (supermemory.ai/pricing, 2026-10-11)
SUPERMEMORY_PRICES = {
    "memory_per_1k_tokens": 0.005,
    "search_per_1k_queries": 0.005,
    "operation_per_1k": 0.10,
}

# Settings shared with memorybench's --provider-config for the Supermemory provider
SEARCH_KEYS = ("searchMode", "limit", "threshold", "rerank", "rewriteQuery", "include")
# The same search body keys as supermemory SDK arguments
SDK_SEARCH_ARGS = {"query": "query", "searchMode": "search_mode", "limit": "limit", "threshold": "threshold",
                   "rerank": "rerank", "rewriteQuery": "rewrite_query", "include": "include"}
TIMEOUT = 120  # seconds per request


class ReadOnlyError(RuntimeError):
    pass


class MemoryUnavailable(RuntimeError):
    """Supermemory still failing after retries (5xx, 429, timeouts). Aborts the interaction instead of
    showing the agent an error, so an outage can't quietly turn into failed tests."""


class NoMemory:
    name = "none"
    tools: list = []

    def __init__(self, *args, **kwargs):
        pass

    def configure(self):
        pass

    def recall(self, query):
        return None, None

    def capture(self, doc_id, content, date, metadata):
        return None

    def call_tool(self, name, arguments):
        raise KeyError(name)

    def wait_until_processed(self, doc_ids, progress=None):
        pass

    def snapshot(self):
        return {"provider": "none"}


class Supermemory:
    name = "supermemory"

    def __init__(self, namespace, settings, recall, api_key, base_url, writable, ledger, persona, phase):
        self.namespace = namespace
        self.settings = settings
        self.recall_settings = recall
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.writable = writable
        self.ledger = ledger
        self.persona = persona
        self.phase = phase
        self._sm, self._client = _sdk_client(api_key, self.base_url)
        # The SDK puts path parameters into the URL as given; the API expects them percent-encoded
        self._namespace = _quote(namespace)

    # ---- requests ----

    def _call(self, method, path, send, *, write=False, op=None):
        """One API call (send() through the SDK, or plain HTTP) for `method path` (used in errors and the read-only
        check): retries 429/5xx and network errors with backoff, then raises MemoryUnavailable; other errors raise
        RuntimeError. A successful call counts `op` in the ledger."""
        if write and not self.writable:
            raise ReadOnlyError(f"memory is read-only during {self.phase}: {method} {path}")
        for attempt in range(9):
            try:
                result = send()
            except Exception as error:
                failure = self._failure(error)
                if failure is None:
                    raise
                status, text, asked = failure
                if status is None:  # network error or timeout
                    if attempt < 8:
                        time.sleep(min(2 ** attempt, 30))
                        continue
                    raise MemoryUnavailable(f"Supermemory {method} {path} unreachable: {text}") from None
                message = f"Supermemory {method} {path} failed ({status}): {text[:300]}"
                if status in (429, 500, 502, 503, 504):
                    if attempt < 8:
                        asked = asked or _retry_after(text)
                        wait = max(float(asked or 0), min(2 ** attempt, 30))
                        time.sleep(wait + random.random())
                        continue
                    raise MemoryUnavailable(message) from None
                raise RuntimeError(message) from None
            if op:
                self.ledger.memory(self.persona, self.phase, op)
            return result

    def _failure(self, error):
        """(status, response text, Retry-After) for an error response, (None, reason, None) for a network error or
        timeout, None for anything else."""
        if isinstance(error, self._sm.APIStatusError):
            response = error.response
            text = response.text if response is not None else (
                error.body if isinstance(error.body, str) else json.dumps(error.body))
            asked = response.headers.get("retry-after") if response is not None else (error.headers or {}).get(
                "retry-after")
            return error.status_code, text, asked
        if isinstance(error, self._sm.APIConnectionError):
            return None, str(error.__cause__ or error), None
        if isinstance(error, urllib.error.HTTPError):  # plain HTTP (_dreaming_status)
            return error.code, error.read().decode(errors="replace"), error.headers.get("retry-after")
        if isinstance(error, (urllib.error.URLError, TimeoutError)):
            return None, str(error), None
        return None

    def _markdown(self, send):
        """The markdown body of a call made with Accept: text/markdown, from the raw response. (SDK 5.0.0 parses every
        2xx body as JSON, so a markdown body comes back as a status error that carries the response.)"""
        try:
            return send().http_response.text
        except self._sm.APIStatusError as error:
            if 200 <= error.status_code < 300:
                return error.response.text if error.response is not None else error.body
            raise

    def _ns(self, suffix=""):
        return f"/ns/{self._namespace}{suffix}"

    # ---- writes (ingestion only) ----

    def configure(self):
        """Profile buckets are assigned while memories form and are never backfilled, and they can only be set on an
        existing namespace. So: create the namespace with a placeholder document, set the buckets, remove the
        placeholder, and only then ingest."""
        buckets = self.settings.get("profileBuckets")
        if not buckets:
            return
        setup = f"{self.namespace}-setup"
        self._call("POST", self._ns("/document"), lambda: self._client.add(
            self._namespace, id=setup, content="Namespace setup placeholder. Contains no information about anyone.",
            **self._document_settings()), write=True)
        self._call("PUT", self._ns("/profile/buckets"), lambda: self._client.profiles.set_buckets(
            self._namespace, buckets=buckets), write=True)
        self.wait_until_processed([setup], poll_seconds=5)
        self.delete_document(setup)
        active = _as_dict(self._call("GET", self._ns("/profile/buckets"), lambda: self._client.profiles.get_buckets(
            self._namespace))).get("buckets") or {}
        missing = set(buckets) - set(active)
        if missing:
            raise RuntimeError(f"profile buckets not active on {self.namespace}: {sorted(missing)}")

    def _document_settings(self):
        """supportingContext and dreaming as sent with every document write, left out when unset."""
        return {**({"supporting_context": self.settings["supportingContext"]}
                   if self.settings.get("supportingContext") else {}),
                **({"dreaming": self.settings["dreaming"]} if self.settings.get("dreaming") else {})}

    def capture(self, doc_id, content, date, metadata):
        """One document per conversation, dated with the message's timestamp; supportingContext rides on each write."""
        self._call("POST", self._ns("/document"), lambda: self._client.add(
            self._namespace, id=doc_id, content=content, date=date, metadata=metadata, **self._document_settings()),
            write=True, op="document")
        self.ledger.memory(self.persona, self.phase, "memory_tokens", count_tokens(content))
        if self.settings.get("dreaming") == "instant":
            self.ledger.memory(self.persona, self.phase, "operation")
        return doc_id

    def delete_document(self, doc_id):
        """Removes one document (crash reconcile). False if it was never stored."""
        result = self._call("DELETE", self._ns("/document"), lambda: self._client.documents.delete(
            self._namespace, ids=[doc_id]), write=True)
        return bool(_as_dict(result).get("count"))

    # ---- reads ----

    def search(self, query, limit=None, mode=None):
        body = {"query": query}
        for key in SEARCH_KEYS:
            if key in self.settings:
                body[key] = self.settings[key]
        if limit is not None:
            body["limit"] = limit
        if mode is not None:
            body["searchMode"] = mode
        options = {SDK_SEARCH_ARGS[key]: value for key, value in body.items()}
        result = _as_dict(self._call("POST", self._ns("/search"), lambda: self._client.search(
            self._namespace, **options), op="search"))
        # Query rewriting and reranking are billed as operations
        if body.get("rewriteQuery"):
            self.ledger.memory(self.persona, self.phase, "operation")
        if body.get("rerank") and body["rerank"] != "none":
            self.ledger.memory(self.persona, self.phase, "operation")
        return result.get("results") or []

    def profile(self, markdown=False):
        if markdown:
            return self._call("POST", self._ns("/profile"), lambda: self._markdown(
                lambda: self._client.with_raw_response.profile(self._namespace,
                                                               extra_headers={"Accept": "text/markdown"})),
                op="search")
        return _as_dict(self._call("POST", self._ns("/profile"), lambda: self._client.profile(self._namespace),
                                   op="search")).get("profile") or {}

    def read_document(self, doc_id, offset=0, length=8000):
        doc = _as_dict(self._call("GET", self._ns(f"/document/{_quote(doc_id)}"), lambda: self._client.documents.get(
            self._namespace, _quote(doc_id))))
        content = doc.get("content") or ""
        window = content[offset:offset + length]
        end = offset + len(window)
        return {"id": doc_id, "date": (doc.get("metadata") or {}).get("date"), "content": window,
                "nextOffset": end if end < len(content) else None}

    # ---- recall and tools ----

    tools = [
        {
            "name": "supermemory_search",
            "description": "Search what you remember about the user: past conversations, facts, preferences, "
                           "people, places, vendors and decisions. Returns memories and matching excerpts with "
                           "their dates and document ids.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "What to look for"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 20},
                },
                "required": ["query"],
            },
        },
        {
            "name": "supermemory_profile",
            "description": "Get the user's full profile: lasting facts about who they are, sections such as "
                           "preferences, people, places and standing instructions, and a sample of recent memories.",
            "parameters": {"type": "object", "properties": {}},
        },
        {
            "name": "supermemory_read_document",
            "description": "Read a stored past conversation by document id (from search results), to check "
                           "exact wording, names and dates. Long documents are paged with offset.",
            "parameters": {
                "type": "object",
                "properties": {
                    "document_id": {"type": "string"},
                    "offset": {"type": "integer", "minimum": 0},
                },
                "required": ["document_id"],
            },
        },
    ]

    def call_tool(self, name, arguments):
        if name == "supermemory_search":
            limit = arguments.get("limit")
            limit = max(1, min(int(limit), 20)) if isinstance(limit, (int, float)) else None
            return format_results(self.search(str(arguments.get("query", "")), limit=limit))
        if name == "supermemory_profile":
            return self.profile(markdown=True)
        if name == "supermemory_read_document":
            offset = arguments.get("offset")
            offset = int(offset) if isinstance(offset, (int, float)) and offset >= 0 else 0
            return json.dumps(self.read_document(str(arguments.get("document_id", "")), offset), ensure_ascii=False)
        raise KeyError(name)

    def recall(self, query):
        """Profile plus top search results, as a system message before the agent's first step. Returns (text, stats)."""
        if not self.recall_settings.get("enabled", True):
            return None, None
        parts, profile_items = [], 0
        if self.recall_settings.get("profile", True):
            profile = profile_sections(self.profile(markdown=True), self.recall_settings.get("profile_exclude", []),
                                       self.recall_settings.get("profile_max_chars"),
                                       self.recall_settings.get("profile_max_items"))
            profile_items = sum(1 for line in profile.splitlines() if line.startswith("- "))
            if profile_items:
                parts.append(f"<supermemory_profile>\n{profile}\n</supermemory_profile>")
        results = self.search(query, limit=self.recall_settings.get("limit", 5))
        if results:
            cap = self.recall_settings.get("max_chars", 500)
            parts.append(f"<supermemory_auto_search>\n{format_results(results, cap)}\n</supermemory_auto_search>")
        text = None
        if parts:
            text = ("Relevant context from memory (retrieved automatically for this request; "
                    "use supermemory_search for anything else):\n\n" + "\n\n".join(parts))
        stats = {"results": len(results), "memories": sum(1 for r in results if r.get("memory")),
                 "profile_items": profile_items, "chars": len(text or "")}
        return text, stats

    # ---- freeze / verify ----

    def _list(self, kind, order="asc", until=None):
        """Every item of `kind` in the namespace by creation time; with `until`, stops after the first page that has
        an item for which until(item) is true (for newest-first scans)."""
        items, page = [], 1
        while True:
            result = _as_dict(self._call(
                "POST", self._ns(f"/list/{kind}?page={page}&limit=100&sort=createdAt&order={order}"),
                lambda: self._client.list(self._namespace, kind, page=page, limit=100, sort="createdAt", order=order)))
            batch = result.get(kind) or []
            items.extend(batch)
            if len(batch) < 100 or (until and any(until(item) for item in batch)):  # 100: the API's page size limit
                return items
            page += 1

    def document_ids(self):
        """Ids of every document stored in the namespace (what freeze waits for)."""
        return [d["id"] for d in self._list("documents")]

    def documents_since(self, since):
        """Documents created at or after `since` (epoch seconds), newest first. Documents without a parseable
        createdAt are left out."""
        def created(item):
            return _epoch((item.get("system") or {}).get("createdAt") or item.get("createdAt"))
        recent = self._list("documents", order="desc", until=lambda item: (created(item) or 0) < since)
        return [d for d in recent if (created(d) or 0) >= since]

    def _dreaming_status(self, doc_id):
        """Plain HTTP: the v5 SDK has no call for the v3 document status."""
        path = f"/v3/documents/{_quote(doc_id)}?namespace={self._namespace}"

        def send():
            request = urllib.request.Request(self.base_url + path, method="GET", headers={
                "Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"})
            with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
                return json.loads(response.read() or b"{}")
        doc = self._call("GET", path, send)
        return doc.get("dreamingStatus") or doc.get("status")

    def wait_until_processed(self, doc_ids, progress=None, poll_seconds=30, workers=8):
        """v5 status covers chunking; memory formation shows up only in the v3 dreamingStatus."""
        pending = set(doc_ids)
        while pending:
            status = {d["id"]: (d.get("system") or {}).get("status") for d in self._list("documents")}
            missing = pending - status.keys()
            if missing:
                raise RuntimeError(f"{len(missing)} captured documents are missing from {self.namespace}")
            failed = [i for i in pending if status[i] == "failed"]
            if failed:
                raise RuntimeError(f"{len(failed)} documents failed processing in {self.namespace}: {failed[:5]}")
            chunked = [i for i in pending if status[i] == "done"]
            with ThreadPoolExecutor(workers) as pool:
                dreaming = dict(zip(chunked, pool.map(self._dreaming_status, chunked)))
            pending -= {i for i, s in dreaming.items() if s in (None, "done")}
            if progress:
                progress(len(doc_ids) - len(pending), len(doc_ids))
            if pending:
                time.sleep(poll_seconds)

    def snapshot(self):
        documents = self._list("documents")
        memories = self._list("memories")
        doc_keys = sorted((d["id"], (d.get("system") or {}).get("status")) for d in documents)
        memory_keys = sorted((m.get("id"), m.get("memory") or "", bool(m.get("isLatest")), bool(m.get("isForgotten")))
                             for m in memories)
        settings = _as_dict(self._call("GET", self._ns(), lambda: self._client.namespaces.get(self._namespace)))
        return {
            "provider": "supermemory",
            "namespace": self.namespace,
            "documents": len(documents),
            "memories": len(memories),
            "supportingContext": (settings.get("supportingContext") if isinstance(settings, dict) else None),
            "sha256": hashlib.sha256(json.dumps([doc_keys, memory_keys]).encode()).hexdigest(),
        }


_SDK_CLIENTS = {}
_SDK_LOCK = threading.Lock()


def _sdk_client(api_key, base_url):
    """(supermemory module, client) shared by every Supermemory for this key and endpoint, so their requests reuse one
    connection pool. Retries are ours (Supermemory._call): the SDK makes one attempt per call."""
    import supermemory
    with _SDK_LOCK:
        client = _SDK_CLIENTS.get((api_key, base_url))
        if client is None:
            client = _SDK_CLIENTS[(api_key, base_url)] = supermemory.Supermemory(
                api_key=api_key, base_url=base_url, timeout=TIMEOUT, max_retries=0)
    return supermemory, client


def _epoch(value):
    """An ISO 8601 timestamp (as the API sends createdAt) in epoch seconds, or None."""
    from datetime import datetime
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _quote(value):
    return urllib.parse.quote(value, safe="")


def _as_dict(value):
    """An SDK response model as the API's JSON object (keys as the API sent them)."""
    if value is None:
        return {}
    return value.to_dict() if hasattr(value, "to_dict") else dict(value)


def _retry_after(text):
    try:
        return json.loads(text).get("retryAfterSeconds")
    except (ValueError, AttributeError):
        return None


_ENCODER = None


def count_tokens(text):
    """o200k_base, the tokenizer DolphinBench uses for its own token counts."""
    global _ENCODER
    if _ENCODER is None:
        import tiktoken
        _ENCODER = tiktoken.get_encoding("o200k_base")
    return len(_ENCODER.encode(text))


def profile_sections(markdown, exclude=(), max_chars=None, max_items=None):
    """Markdown profile without the excluded `## ` sections (e.g. "Recent Memories"), at most `max_items` entries per
    section, cut at a line boundary past `max_chars`."""
    kept, skip, items = [], False, 0
    for line in markdown.splitlines():
        if line.startswith("## "):
            skip, items = line[3:].strip() in exclude, 0
        if skip:
            continue
        if line.startswith("- "):
            items += 1
            if max_items and items > max_items:
                continue
        kept.append(line)
    text = "\n".join(kept).strip()
    if max_chars and len(text) > max_chars:
        text = text[:text.rfind("\n", 0, max_chars)] + "\n- …"
    return text


def format_profile(profile):
    lines = []
    for section in ("static", "dynamic"):
        for item in profile.get(section) or []:
            if item.get("memory"):
                lines.append(f"- {item['memory']}")
    return "\n".join(lines)


def format_results(results, cap=None):
    lines = []
    for result in results:
        metadata = result.get("metadata") or {}
        when = metadata.get("date") or (metadata.get("temporalContext") or {}).get("documentDate") or ""
        doc = metadata.get("docId") or ((result.get("included") or {}).get("document") or {}).get("id") or ""
        text = result.get("memory") or result.get("chunk") or ""
        if cap and len(text) > cap:
            text = text[:cap] + "…"
        kind = "memory" if result.get("memory") else "excerpt"
        lines.append(f"- [{kind}{', ' + when[:10] if when else ''}{', doc ' + doc if doc else ''}] {text}")
    return "\n".join(lines) if lines else "No results."
