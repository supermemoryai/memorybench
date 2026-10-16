#!/usr/bin/env python3
"""Build the BEAM oracle file memorybench's `beam` benchmark reads.

BEAM questions cite the chat messages that hold their answer (`source_chat_ids`).
This keeps those references, maps each message to its user/assistant turn pair
(one session, as in the BEAM 1M run on the v3/v4 API), and writes only the
sessions some question cites.

    uv run --with pyarrow scripts/prepare-beam-oracle.py \
        --parquet <BEAM 1M parquet> [--canonical <dir with chats.jsonl + questions.jsonl>]

--canonical cross-checks session ids, dates and text against the canonical
snapshot used for the v3/v4 runs and records each question's v4 id.

--chats 5,6,13 --per-type 5 keeps that many answerable questions per type from
those chats (in order) and marks the file "shared": every question then uses one
container holding the evidence of all of them.
"""

import argparse
import ast
import hashlib
import json
import sys
from datetime import datetime
from pathlib import Path

import pyarrow.parquet as pq

TYPE_ABBREV = {
    "abstention": "ab",
    "contradiction_resolution": "cr",
    "event_ordering": "eo",
    "information_extraction": "ie",
    "instruction_following": "if",
    "knowledge_update": "ku",
    "multi_session_reasoning": "msr",
    "preference_following": "pf",
    "summarization": "sum",
    "temporal_reasoning": "tr",
}
ANSWER_KEYS = ["answer", "ideal_answer", "ideal_response", "ideal_summary"]


def parse_anchor(value):
    """"March-01-2024" -> "2024-03-01"."""
    if not value or value == "None":
        return None
    try:
        return datetime.strptime(value.strip(), "%B-%d-%Y").strftime("%Y-%m-%d")
    except ValueError:
        return None


def flat_ids(value):
    if isinstance(value, dict):
        return [i for v in value.values() for i in flat_ids(v)]
    if isinstance(value, list):
        return [i for v in value for i in flat_ids(v)]
    return [int(value)] if isinstance(value, int) else []


def parse_questions(raw):
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return ast.literal_eval(raw)


def build_sessions(chat_id, batches):
    sessions, by_message = [], {}
    for batch_index, batch in enumerate(batches):
        date = next((d for d in (parse_anchor(m["time_anchor"]) for m in batch) if d), None)
        if len(batch) % 2:
            raise ValueError(f"chat {chat_id} batch {batch_index + 1} has an odd message count")
        for pair_index in range(0, len(batch), 2):
            user, assistant = batch[pair_index], batch[pair_index + 1]
            if user["role"] != "user" or assistant["role"] != "assistant":
                raise ValueError(f"chat {chat_id} batch {batch_index + 1} is not user/assistant pairs")
            session_id = f"beam-1M-{chat_id}-batch-{batch_index + 1}-turn-{pair_index // 2 + 1}"
            for message in (user, assistant):
                # Some chats restart message ids partway through; BEAM cites the first occurrence
                by_message.setdefault(int(message["id"]), session_id)
            sessions.append(
                {
                    "sessionId": session_id,
                    "batchNumber": batch_index + 1,
                    "turnIndex": pair_index // 2 + 1,
                    "documentDate": date,
                    "messages": [
                        {"role": m["role"], "content": m["content"], "messageId": int(m["id"])}
                        for m in (user, assistant)
                    ],
                }
            )
    return sessions, by_message


def load_canonical(path):
    chats, questions = {}, {}
    with open(path / "chats.jsonl") as f:
        for line in f:
            chat = json.loads(line)
            chats[chat["chatId"]] = {s["sessionId"]: s for s in chat["sessions"]}
    with open(path / "questions.jsonl") as f:
        for line in f:
            q = json.loads(line)
            questions[(q["chatId"], q["questionType"], q["question"].strip())] = q["questionId"]
    return chats, questions


def answerable(q):
    """Abstention needs no evidence; other types need some, and a knowledge update needs the update."""
    if q["questionType"] == "abstention":
        return True
    if not q["evidenceSessionIds"]:
        return False
    ids = q["details"].get("source_chat_ids")
    return not (q["questionType"] == "knowledge_update" and isinstance(ids, dict) and not ids.get("updated_info"))


def select_subset(questions, chats, per_type):
    picked, counts = [], {}
    for chat in chats:
        for q in questions:
            if q["chatId"] == chat and answerable(q) and counts.get(q["questionType"], 0) < per_type:
                counts[q["questionType"]] = counts.get(q["questionType"], 0) + 1
                picked.append(q)
    short = {t: n for t, n in counts.items() if n < per_type}
    if short or len(counts) < len(TYPE_ABBREV):
        sys.exit(f"not enough answerable questions per type in chats {chats}: {counts}")
    return picked


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--parquet", required=True, type=Path)
    parser.add_argument("--canonical", type=Path)
    parser.add_argument("--out", type=Path, default=Path("data/benchmarks/beam/1M/oracle.json"))
    parser.add_argument("--chats", help="comma-separated chat ids to draw a shared-container subset from")
    parser.add_argument("--per-type", type=int, default=5)
    args = parser.parse_args()

    canonical_chats, canonical_questions = load_canonical(args.canonical) if args.canonical else ({}, {})
    rows = pq.read_table(args.parquet, columns=["conversation_id", "chat", "probing_questions"]).to_pylist()

    sessions_out, questions_out, problems = {}, [], []
    for row in rows:
        chat_id = str(row["conversation_id"])
        sessions, by_message = build_sessions(chat_id, row["chat"])
        by_id = {s["sessionId"]: s for s in sessions}
        # Questions are asked after the chat ends, so its last session date is "today" for them
        asked_on = max((s["documentDate"] for s in sessions if s["documentDate"]), default=None)

        if canonical_chats:
            canon = canonical_chats[chat_id]
            if set(canon) != set(by_id):
                problems.append(f"chat {chat_id}: session ids differ from the canonical snapshot")
            for sid, s in by_id.items():
                c = canon.get(sid)
                if c and (
                    c.get("documentDate") != s["documentDate"]
                    or [m["content"] for m in c["messages"]] != [m["content"] for m in s["messages"]]
                ):
                    problems.append(f"{sid}: date or text differs from the canonical snapshot")

        for qtype, items in parse_questions(row["probing_questions"]).items():
            for index, item in enumerate(items):
                cited = flat_ids(item.get("source_chat_ids"))
                unmapped = sorted({i for i in cited if i not in by_message})
                evidence = sorted(
                    {by_message[i] for i in cited if i in by_message},
                    key=lambda sid: (by_id[sid]["batchNumber"], by_id[sid]["turnIndex"]),
                )
                answer = next((item[k] for k in ANSWER_KEYS if item.get(k)), None)
                details = {
                    k: v
                    for k, v in item.items()
                    if k not in {"question", "rubric", "difficulty", *ANSWER_KEYS}
                }
                questions_out.append(
                    {
                        "questionId": f"beam-1M-{chat_id}-{TYPE_ABBREV[qtype]}-{index}",
                        "v4QuestionId": canonical_questions.get((chat_id, qtype, item["question"].strip())),
                        "chatId": chat_id,
                        "questionType": qtype,
                        "question": item["question"],
                        "referenceAnswer": answer,
                        "rubric": item.get("rubric") or [],
                        "difficulty": item.get("difficulty"),
                        "questionDate": asked_on,
                        "evidenceSessionIds": evidence,
                        "evidenceMessageIds": sorted(set(cited)),
                        "unmappedMessageIds": unmapped,
                        "details": details,
                    }
                )
                for sid in evidence:
                    sessions_out[sid] = {"chatId": chat_id, **by_id[sid]}

    if problems:
        print("\n".join(problems[:20]), file=sys.stderr)
        sys.exit(f"{len(problems)} mismatches against the canonical snapshot")

    container = "per-question"
    if args.chats:
        questions_out = select_subset(questions_out, args.chats.split(","), args.per_type)
        cited = {sid for q in questions_out for sid in q["evidenceSessionIds"]}
        sessions_out = {sid: s for sid, s in sessions_out.items() if sid in cited}
        container = "shared"

    digest = hashlib.sha256(args.parquet.read_bytes()).hexdigest()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(
            {
                "source": {"file": args.parquet.name, "sha256": digest, "scale": "1M"},
                "container": container,
                "questions": questions_out,
                "sessions": sessions_out,
            }
        )
    )
    with_evidence = sum(1 for q in questions_out if q["evidenceSessionIds"])
    print(
        f"{len(questions_out)} questions ({with_evidence} with evidence), "
        f"{len(sessions_out)} evidence sessions -> {args.out}"
    )


if __name__ == "__main__":
    main()
