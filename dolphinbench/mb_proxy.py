"""Supermemory proxy between the Hermes agent container and the hosted API.

The agent container never holds the real Supermemory key. Each interaction gets a random session token that the
container uses as its SUPERMEMORY_API_KEY; the proxy maps the token to one persona namespace and one mode, swaps in
the real key, and forwards only the calls the Supermemory plugin makes:

  ingestion  POST /ns/{ns}/document (conversation capture, supermemory_store, mirrored built-in memory notes),
             DELETE /ns/{ns}/memories (supermemory_forget), POST /ns/{ns}/search, POST /ns/{ns}/profile,
             GET /ns/{ns}/document/{id}
  tests      POST /ns/{ns}/search, POST /ns/{ns}/profile, GET /ns/{ns}/document/{id}

Everything else (other namespaces, other routes, writes during tests) gets 405 and never reaches Supermemory. Every
request is recorded per session (route, status, stored document ids, forgotten memory ids, size) for capture receipts,
rollback and cost. With a journal path, each session's records also go to disk as they happen (a write is journaled
before it is forwarded), so an interrupted interaction's writes can still be found and undone.

Only the request's own Content-Type and Accept headers are forwarded, with the real key.

During ingestion the session carries the message's timestamp, passed through as Supermemory's "date" field on document
writes that don't set one (the body is otherwise forwarded byte for byte; the event records date_added). A
connection-level failure before any response (DNS, refused or reset connection, timeout) is retried up to
UPSTREAM_ATTEMPTS times with backoff (the event records the failed attempts); once Supermemory has answered, its answer
is passed through as is.
"""

from __future__ import annotations

import http.client
import json
import os
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROUTES = {
    "ingestion": {"document", "forget", "search", "profile", "read"},
    "tests": {"search", "profile", "read"},
}
NAMESPACE_KEYS = ("namespace", "namespaces", "containerTag", "containerTags")
MAX_BODY = 16 * 1024 * 1024
UPSTREAM_ATTEMPTS = 5
UPSTREAM_BACKOFF = (1, 2, 4, 8, 16)  # seconds before attempt 2, 3, ...


class Unanswered(Exception):
    """No response arrived from upstream (connection-level failure); safe to retry."""


def with_date(body, date):
    """The JSON object body with "date" added as its first member, every other byte unchanged."""
    start = len(body) - len(body.lstrip())
    if body[start:start + 1] != b"{":
        raise ValueError("not a JSON object")
    rest = body[start + 1:]
    member = b'"date": ' + json.dumps(date).encode()
    return body[:start] + b"{" + member + (b", " if rest.strip() != b"}" else b"") + rest


class Session:
    def __init__(self, namespace, mode, label, journal=None, date=None):
        if mode not in ROUTES:
            raise ValueError(f"Unknown proxy mode: {mode}")
        self.token = "mbp_" + secrets.token_urlsafe(32)
        self.namespace, self.mode, self.label = namespace, mode, label
        self.date = date
        self.events = []
        self.active = 0
        self.condition = threading.Condition()
        self.journal = journal
        self.note({"t": "start", "label": label, "namespace": namespace, "mode": mode, "date": date,
                   "ts": time.time()})

    def note(self, record):
        """Appends one record to the session's journal on disk (no-op without one)."""
        if self.journal is None:
            return
        with self.condition:
            self.journal.parent.mkdir(parents=True, exist_ok=True)
            with self.journal.open("a") as stream:
                stream.write(json.dumps(record) + "\n")
                stream.flush()
                os.fsync(stream.fileno())

    def begin(self):
        with self.condition:
            self.active += 1

    def end(self, event):
        self.note({"t": "event", **event})
        with self.condition:
            self.events.append(event)
            self.active -= 1
            self.condition.notify_all()

    def wait_idle(self, timeout=600):
        """Requests still in flight after the agent exits (an abandoned upload) finish before receipts are read."""
        deadline = time.monotonic() + timeout
        with self.condition:
            while self.active:
                left = deadline - time.monotonic()
                if left <= 0:
                    raise TimeoutError(f"proxy session {self.label} still has {self.active} requests in flight")
                self.condition.wait(left)
            return list(self.events)


def classify(method, path, namespace):
    """The plugin route a request is, or None. The namespace must be the session's own."""
    parts = path.split("/")
    if len(parts) < 4 or parts[0] != "" or parts[1] != "ns":
        return None
    if urllib.parse.unquote(parts[2]) != namespace:
        return None
    rest = parts[3:]
    if method == "POST" and rest == ["document"]:
        return "document"
    if method == "DELETE" and rest == ["memories"]:
        return "forget"
    if method == "POST" and rest == ["search"]:
        return "search"
    if method == "POST" and rest == ["profile"]:
        return "profile"
    if method == "GET" and len(rest) == 2 and rest[0] == "document" and rest[1]:
        return "read"
    return None


class SupermemoryProxy(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False

    def __init__(self, upstream, api_key, *, bind="127.0.0.1", port=0, count_tokens=None, timeout=300,
                 backoff=UPSTREAM_BACKOFF):
        if not api_key:
            raise ValueError("The proxy needs the real Supermemory API key")
        self.upstream = upstream.rstrip("/")
        self.api_key = api_key
        self.count_tokens = count_tokens or (lambda text: 0)
        self.timeout = timeout
        self.backoff = tuple(backoff)
        self.sessions = {}
        self.lock = threading.Lock()
        super().__init__((bind, port), ProxyHandler)
        self.thread = threading.Thread(target=self.serve_forever, name="supermemory-proxy", daemon=True)
        self.thread.start()

    @property
    def port(self):
        return self.server_address[1]

    def open_session(self, namespace, mode, label, journal=None, date=None):
        session = Session(namespace, mode, label, journal, date)
        with self.lock:
            self.sessions[session.token] = session
        return session

    def close_session(self, session, timeout=600):
        try:
            return session.wait_idle(timeout)
        finally:
            with self.lock:
                self.sessions.pop(session.token, None)

    def lookup(self, token):
        with self.lock:
            return self.sessions.get(token)

    def stop(self):
        self.shutdown()
        self.server_close()


class ProxyHandler(BaseHTTPRequestHandler):
    server_version = "memorybench-supermemory-proxy/1"
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass

    def _reply(self, status, payload, content_type="application/json"):
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def _body(self):
        if self.headers.get("Transfer-Encoding"):
            raise ValueError(411, "Content-Length is required")
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise ValueError(400, "Invalid Content-Length") from None
        if not 0 <= length <= MAX_BODY:
            raise ValueError(413, "Request body too large")
        return self.rfile.read(length) if length else b""

    def _handle(self):
        authorization = self.headers.get("Authorization") or ""
        token = authorization[7:].strip() if authorization[:7].lower() == "bearer " else ""
        session = self.server.lookup(token) if token else None
        if session is None:
            try:
                self._body()
            except ValueError:
                pass
            self._reply(401, {"error": "Unknown or expired proxy session"})
            return
        session.begin()
        started = time.monotonic()
        split = urllib.parse.urlsplit(self.path)
        event = {"method": self.command, "path": split.path, "route": None, "status": None}
        try:
            try:
                body = self._body()
            except ValueError as error:
                event["status"] = error.args[0]
                self._reply(error.args[0], {"error": error.args[1]})
                return
            route = classify(self.command, split.path, session.namespace)
            payload = None
            if route in ("document", "forget", "search", "profile"):
                try:
                    payload = json.loads(body or b"{}")
                except ValueError:
                    payload = None
                if not isinstance(payload, dict) or any(
                        key in payload and payload[key] not in (session.namespace, [session.namespace])
                        for key in NAMESPACE_KEYS):
                    route = None
                elif route == "forget" and not (isinstance(payload.get("ids"), list) and payload["ids"]
                                                and all(isinstance(i, str) and i for i in payload["ids"])):
                    route = None
            event["route"] = route
            if route not in ROUTES[session.mode]:
                event["status"] = 405
                self._reply(405, {"error": f"{self.command} {split.path} is not permitted for this session "
                                           f"({session.mode}, namespace {session.namespace})"})
                return
            if route == "document":
                content = payload.get("content")
                event["doc_id"] = payload.get("id") or payload.get("customId")
                event["tokens"] = self.server.count_tokens(content) if isinstance(content, str) else 0
                event["dreaming"] = payload.get("dreaming")
                if session.date and "date" not in payload:
                    body = with_date(body, session.date)
                    event["date_added"] = session.date
            elif route == "forget":
                event["memory_ids"] = list(payload["ids"])
            if route in ("document", "forget"):  # journaled before it can reach Supermemory
                session.note({"t": "sending", **event, "ts": time.time()})
            elif route == "search":
                event["rewrite"] = bool(payload.get("rewriteQuery"))
                event["rerank"] = bool(payload.get("rerank")) and payload.get("rerank") != "none"
            headers = {"Authorization": f"Bearer {self.server.api_key}"}
            for name in ("Content-Type", "Accept"):
                if self.headers.get(name):
                    headers[name] = self.headers[name]
            target = self.server.upstream + split.path + (f"?{split.query}" if split.query else "")
            try:
                status, data, content_type = self._forward(target, body, headers, event)
            except Unanswered as error:
                event["status"], event["error"] = 502, str(error)[:300]
                self._reply(502, {"error": "Supermemory is unreachable through the proxy"})
                return
            event["status"] = status
            if route == "document" and status < 300:
                try:
                    event["stored_id"] = json.loads(data).get("id")
                except (ValueError, AttributeError):
                    pass
            if status >= 400:
                event["error"] = data[:300].decode(errors="replace")
            self._reply(status, data, content_type)
        except (BrokenPipeError, ConnectionResetError):
            event.setdefault("client_gone", True)
        finally:
            event["ms"] = round((time.monotonic() - started) * 1000, 1)
            session.end(event)

    def _forward(self, target, body, headers, event):
        """(status, data, content type) from upstream. Connection-level failures before any response are retried
        with backoff (each failed attempt goes in event["upstream_retries"]); raises Unanswered when all fail. Once a
        response has started arriving, nothing is retried: a failure reading it is reported as unanswered."""
        failures = []
        for attempt in range(1, UPSTREAM_ATTEMPTS + 1):
            request = urllib.request.Request(target, data=body if self.command in ("POST", "DELETE") else None,
                                             method=self.command, headers=headers)
            try:
                response = urllib.request.urlopen(request, timeout=self.server.timeout)
            except urllib.error.HTTPError as error:
                return error.code, error.read(), error.headers.get("Content-Type") or "application/json"
            except (urllib.error.URLError, TimeoutError, OSError) as error:
                reason = getattr(error, "reason", error)
                failures.append({"attempt": attempt, "error": f"{type(reason).__name__}: {reason}"[:300],
                                 "ts": time.time()})
                event["upstream_retries"] = failures
                if attempt < UPSTREAM_ATTEMPTS:
                    time.sleep(self.server.backoff[min(attempt, len(self.server.backoff)) - 1])
                    continue
                raise Unanswered(f"{failures[-1]['error']} (after {attempt} attempts)") from None
            except http.client.HTTPException as error:  # a malformed answer arrived: not retried
                event["response_read_error"] = True
                raise Unanswered(f"{type(error).__name__}: {error} (malformed response)") from None
            # A response was received: no retry from here on
            with response:
                try:
                    data = response.read()
                except (TimeoutError, OSError, http.client.HTTPException) as error:
                    event["response_read_error"] = True
                    raise Unanswered(f"{type(error).__name__}: {error} (reading the response)") from None
                return response.status, data, response.headers.get("Content-Type") or "application/json"

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = _handle
