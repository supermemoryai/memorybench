"""Tool-calling agent loop over OpenAI's Responses API or any Chat Completions endpoint (OpenAI or Azure).

gpt-5.6 models on OpenAI only accept reasoning effort together with function tools on the Responses API."""

from __future__ import annotations

import asyncio
import json
import os
import random
import time
import urllib.error
import urllib.request

USAGE_KEYS = ("prompt_tokens", "completion_tokens", "total_tokens", "prompt_tokens_details",
              "completion_tokens_details", "input_tokens", "output_tokens", "input_tokens_details",
              "output_tokens_details")


class ChatModel:
    def __init__(self, config):
        self.model = config["model"]
        self.base_url = config.get("base_url", "https://api.openai.com/v1").rstrip("/")
        self.api_key_env = config.get("api_key_env", "OPENAI_API_KEY")
        self.auth = config.get("auth", "bearer")  # "bearer" (OpenAI) or "api-key" (Azure)
        self.api = config.get("api", "chat")  # "responses" or "chat" (Chat Completions)
        self.reasoning_effort = config.get("reasoning_effort")
        self.max_completion_tokens = config.get("max_completion_tokens")
        self.parallel_tool_calls = config.get("parallel_tool_calls")
        self.timeout = config.get("timeout_seconds", 600)

    def settings(self, tools):
        settings = {"model": self.model}
        if self.reasoning_effort:
            settings["reasoning_effort"] = self.reasoning_effort
        if self.max_completion_tokens:
            settings["max_completion_tokens"] = self.max_completion_tokens
        if self.parallel_tool_calls is not None:
            settings["parallel_tool_calls"] = self.parallel_tool_calls
        settings["tools"] = tools
        return settings

    # ---- wire format: the running conversation as the API expects it ----

    def new_wire(self, recorded):
        return [{"role": m["role"], "content": m["content"]} for m in recorded]

    def add_assistant(self, wire, message, items):
        if self.api == "responses":
            wire.extend(items)  # reasoning (encrypted), messages and function calls, passed back as returned
        else:
            wire.append({"role": "assistant", "content": message.get("content"),
                         **({"tool_calls": message["tool_calls"]} if message.get("tool_calls") else {})})

    def add_tool_result(self, wire, call_id, result):
        if self.api == "responses":
            wire.append({"type": "function_call_output", "call_id": call_id, "output": result})
        else:
            wire.append({"role": "tool", "tool_call_id": call_id, "content": result})

    # ---- one model response ----

    def complete(self, wire, tools, attempts):
        """Returns (chat-style message, API usage, duration ms, raw output items). Retries transient failures."""
        if self.api == "responses":
            body = {"model": self.model, "input": wire, "store": False, "include": ["reasoning.encrypted_content"]}
            if tools:
                body["tools"] = [{"type": "function", "name": t["name"], "description": t.get("description", ""),
                                  "parameters": t["parameters"], "strict": False} for t in tools]
                if self.parallel_tool_calls is not None:
                    body["parallel_tool_calls"] = self.parallel_tool_calls
            if self.reasoning_effort:
                body["reasoning"] = {"effort": self.reasoning_effort}
            if self.max_completion_tokens:
                body["max_output_tokens"] = self.max_completion_tokens
            raw, duration = self._post("/responses", body, attempts)
            items = raw.get("output") or []
            text = "".join(part.get("text", "") for item in items if item.get("type") == "message"
                           for part in item.get("content") or [] if part.get("type") == "output_text")
            calls = [{"id": item["call_id"], "type": "function",
                      "function": {"name": item["name"], "arguments": item.get("arguments") or "{}"}}
                     for item in items if item.get("type") == "function_call"]
            message = {"role": "assistant", "content": text or None, **({"tool_calls": calls} if calls else {})}
            return message, raw.get("usage") or {}, duration, items
        body = {"model": self.model, "messages": wire}
        if tools:
            body["tools"] = [{"type": "function", "function": t} for t in tools]
            if self.parallel_tool_calls is not None:
                body["parallel_tool_calls"] = self.parallel_tool_calls
        if self.reasoning_effort:
            body["reasoning_effort"] = self.reasoning_effort
        if self.max_completion_tokens:
            body["max_completion_tokens"] = self.max_completion_tokens
        raw, duration = self._post("/chat/completions", body, attempts)
        return raw["choices"][0]["message"], raw.get("usage") or {}, duration, None

    def _post(self, path, body, attempts):
        """Failed HTTP attempts are appended to `attempts` and retried."""
        key = os.environ.get(self.api_key_env, "")
        if not key:
            raise RuntimeError(f"{self.api_key_env} is not set")
        headers = {"Content-Type": "application/json",
                   **({"api-key": key} if self.auth == "api-key" else {"Authorization": f"Bearer {key}"})}
        for attempt in range(8):
            started = time.monotonic()
            request = urllib.request.Request(f"{self.base_url}{path}", data=json.dumps(body).encode(),
                                             headers=headers, method="POST")
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    raw = json.loads(response.read())
                return raw, (time.monotonic() - started) * 1000
            except urllib.error.HTTPError as error:
                text = error.read().decode(errors="replace")[:500]
                attempts.append({"error": f"HTTP {error.code}", "detail": text, "attempt": attempt + 1})
                if error.code in (408, 409, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524) and attempt < 7:  # 52x: Cloudflare
                    asked = error.headers.get("retry-after")
                    time.sleep(max(float(asked or 0), min(2 ** attempt, 60)) + random.random())
                    continue
                raise RuntimeError(f"model call failed ({error.code}): {text}") from None
            except (urllib.error.URLError, TimeoutError) as error:
                attempts.append({"error": type(error).__name__, "detail": str(error)[:300], "attempt": attempt + 1})
                if attempt < 7:
                    time.sleep(min(2 ** attempt, 60))
                    continue
                raise


async def run_conversation(model, system_messages, user_message, tools, execute_tool, max_turns, fill=None):
    """Runs one fresh conversation. Returns (recorded messages, usage list, attempts).
    `fill(name, arguments)` completes a call's arguments before it runs; the recorded call is what ran."""
    recorded = [{"role": "system", "content": text} for text in system_messages]
    recorded.append({"role": "user", "content": user_message})
    wire = model.new_wire(recorded)
    usages, attempts = [], []
    for _ in range(max_turns):
        message, usage, duration, items = await asyncio.to_thread(model.complete, wire, tools, attempts)
        usage = {k: usage[k] for k in USAGE_KEYS if k in usage}
        usages.append(usage)
        calls = []
        for call in message.get("tool_calls") or []:
            try:
                arguments = json.loads(call["function"].get("arguments") or "{}")
                if not isinstance(arguments, dict):
                    raise ValueError("arguments must be an object")
                if fill:
                    arguments = fill(call["function"]["name"], arguments)
                error = None
            except ValueError as exc:
                arguments, error = {}, f"Invalid tool arguments: {exc}"
            calls.append((call["id"], call["function"]["name"], arguments, error))
        entry = {"role": "assistant", "usage": usage, "duration_ms": duration}
        text = message.get("content")
        if text or not calls:
            entry["content"] = text or ""
        if calls:
            entry["tool_calls"] = [{"id": i, "name": n, "arguments": a} for i, n, a, _ in calls]
        recorded.append(entry)
        model.add_assistant(wire, message, items)
        if not calls:
            break
        for call_id, name, arguments, error in calls:
            result = error or await execute_tool(name, arguments)
            recorded.append({"role": "tool", "tool_call_id": call_id, "content": result})
            model.add_tool_result(wire, call_id, result)
    return recorded, usages, attempts


def final_reply(messages):
    for message in reversed(messages):
        if message["role"] == "assistant" and message.get("content"):
            return message["content"]
    return ""
