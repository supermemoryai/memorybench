#!/usr/bin/env python3
"""Embed benchmark observations into ChromaDB.

Called by the anamnesis provider's awaitIndexing phase.
Reads observation IDs from argv, fetches narratives from SQLite,
and adds them to the cm__claude-mem ChromaDB collection.

Uses the same Python environment as chroma-mcp to avoid version mismatches.
"""
import json
import os
import sqlite3
import sys

# ChromaDB — must match the version used by chroma-mcp (1.5.x)
import chromadb

DB_PATH = os.environ.get("ANAMNESIS_DB", os.path.expanduser("~/.claude-mem/claude-mem.db"))
VECTOR_PATH = os.environ.get("CHROMA_PATH", os.path.expanduser("~/.claude-mem/vector-db"))
COLLECTION = "cm__claude-mem"
BATCH_SIZE = 50  # ChromaDB handles batches well


def embed_observations(ids: list[int]) -> dict:
    """Fetch observations from SQLite and embed into ChromaDB."""
    if not ids:
        return {"embedded": 0, "skipped": 0, "errors": 0}

    # Read observations from SQLite
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    placeholders = ",".join("?" for _ in ids)
    rows = db.execute(
        f"SELECT id, title, subtitle, narrative, facts, namespace FROM observations WHERE id IN ({placeholders})",
        ids,
    ).fetchall()
    db.close()

    if not rows:
        return {"embedded": 0, "skipped": 0, "errors": 0}

    # Connect to ChromaDB
    client = chromadb.PersistentClient(path=VECTOR_PATH)
    col = client.get_collection(COLLECTION)

    embedded = 0
    skipped = 0
    errors = 0

    # Process in batches
    for i in range(0, len(rows), BATCH_SIZE):
        batch = rows[i : i + BATCH_SIZE]
        batch_ids = []
        batch_docs = []
        batch_metas = []

        for row in batch:
            obs_id = str(row["id"])
            # Build document text for embedding (same as what search would match against)
            parts = []
            if row["title"]:
                parts.append(row["title"])
            if row["subtitle"]:
                parts.append(row["subtitle"])
            if row["narrative"]:
                parts.append(row["narrative"])

            doc = "\n".join(parts)
            if not doc.strip():
                skipped += 1
                continue

            batch_ids.append(obs_id)
            batch_docs.append(doc[:8000])  # ChromaDB has doc size limits
            batch_metas.append({
                "source": "memorybench",
                "namespace": row["namespace"] or "",
                "title": row["title"] or "",
            })

        if batch_ids:
            try:
                col.upsert(
                    ids=batch_ids,
                    documents=batch_docs,
                    metadatas=batch_metas,
                )
                embedded += len(batch_ids)
            except Exception as e:
                print(json.dumps({"error": str(e), "batch_start": i}), file=sys.stderr)
                errors += len(batch_ids)

    return {"embedded": embedded, "skipped": skipped, "errors": errors}


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: embed.py <id1,id2,...>"}))
        sys.exit(1)

    ids = [int(x) for x in sys.argv[1].split(",") if x.strip()]
    result = embed_observations(ids)
    print(json.dumps(result))
