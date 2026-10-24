"""DolphinBench's judge (gpt-5.6-sol, medium) sent to OpenAI when no Azure deployment is configured."""

from __future__ import annotations

import json
import os
import time
import urllib.request

# gpt-5.6-sol list price, USD per 1M tokens (developers.openai.com, 2026-10-12)
JUDGE_PRICES_PER_1M = {"input": 4.00, "cached_input": 0.40, "output": 20.00}


def judge_transport():
    return "azure" if os.environ.get("AZURE_OPENAI_ENDPOINT") else "openai"


def openai_judge(llm_judge):
    """DolphinBench's Azure judge request (same model, prompts, effort, token limit and JSON mode), sent to OpenAI's
    Chat Completions endpoint, for runs without an Azure deployment."""
    # OpenAI's edge can answer 520-524 (Cloudflare); retried like the judge's other transient HTTP errors
    llm_judge.RETRYABLE_HTTP_STATUS = set(llm_judge.RETRYABLE_HTTP_STATUS) | {520, 521, 522, 523, 524}

    def call(system_prompt, user_prompt, config, timeout=120):
        key = os.environ.get("OPENAI_API_KEY", "")
        if not key:
            raise RuntimeError("Missing OPENAI_API_KEY for the judge")
        model = config.get("azure_deployment", llm_judge.AZURE_DEPLOYMENT)
        body = {
            "messages": [{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}],
            "max_completion_tokens": llm_judge.DEFAULT_MAX_TOKENS,
            "reasoning_effort": config.get("reasoning_effort", llm_judge.JUDGE_REASONING_EFFORT),
            "response_format": {"type": "json_object"},
        }
        request = urllib.request.Request(
            "https://api.openai.com/v1/chat/completions", data=json.dumps({"model": model, **body}).encode(),
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"}, method="POST")
        started = time.monotonic()
        raw = llm_judge._urlopen_json(request, timeout, model=model)
        from graders.judge_recording import record_response
        record_response({"model": model, **{k: v for k, v in body.items() if k != "messages"}},
                        body["messages"], raw, (time.monotonic() - started) * 1000)
        choice = raw["choices"][0]
        text = choice["message"].get("content") or ""
        if not text.strip():
            raise RuntimeError(f"Judge returned empty content (finish_reason={choice.get('finish_reason')})")
        return llm_judge._extract_json(text)
    return call
