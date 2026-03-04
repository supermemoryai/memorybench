#!/usr/bin/env python3
"""Semantic search for benchmark observations via ChromaDB.

Called by the anamnesis provider's search phase.
Queries ChromaDB collection with namespace filtering, then enriches
results with full content from SQLite.

Uses the same Python environment as chroma-mcp to avoid version mismatches.
"""
import json
import os
import sqlite3
import sys

import chromadb

DB_PATH = os.environ.get("ANAMNESIS_DB", os.path.expanduser("~/.claude-mem/claude-mem.db"))
VECTOR_PATH = os.environ.get("CHROMA_PATH", os.path.expanduser("~/.claude-mem/vector-db"))
COLLECTION = "cm__claude-mem"


def search(query: str, namespace: str, limit: int = 10) -> list[dict]:
    """Search ChromaDB for observations matching query within namespace."""
    client = chromadb.PersistentClient(path=VECTOR_PATH)
    col = client.get_collection(COLLECTION)

    # Query ChromaDB with namespace filter
    results = col.query(
        query_texts=[query],
        n_results=min(limit * 3, 100),  # Overfetch to account for filtering
        where={"namespace": namespace},
        include=["documents", "distances", "metadatas"],
    )

    if not results["ids"] or not results["ids"][0]:
        return []

    # Extract IDs (ChromaDB stores them as strings matching observation IDs)
    chroma_ids = results["ids"][0]
    distances = results["distances"][0] if results["distances"] else []

    # Convert string IDs to ints for SQLite lookup
    obs_ids = []
    for cid in chroma_ids:
        try:
            obs_ids.append(int(cid))
        except ValueError:
            continue

    if not obs_ids:
        return []

    # Fetch full content from SQLite
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    placeholders = ",".join("?" for _ in obs_ids)
    rows = db.execute(
        f"""SELECT id, title, narrative, facts, created_at_epoch
            FROM observations
            WHERE id IN ({placeholders}) AND namespace = ?""",
        [*obs_ids, namespace],
    ).fetchall()
    db.close()

    # Build a lookup for SQLite results
    row_map = {row["id"]: row for row in rows}

    # Merge ChromaDB ranking with SQLite content
    results_out = []
    for i, obs_id in enumerate(obs_ids):
        if obs_id not in row_map:
            continue
        row = row_map[obs_id]
        # ChromaDB distances are L2 — lower is better. Convert to score (higher is better).
        distance = distances[i] if i < len(distances) else 1.0
        score = max(0.0, 1.0 - (distance / 2.0))  # Normalize roughly to 0-1

        results_out.append({
            "id": str(obs_id),
            "content": row["narrative"] or row["facts"] or "",
            "score": round(score, 4),
            "metadata": {
                "title": row["title"] or "",
                "created_at": row["created_at_epoch"],
            },
        })

    # Sort by score descending and limit
    results_out.sort(key=lambda x: x["score"], reverse=True)
    return results_out[:limit]


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: search.py <query> <namespace> [limit]"}))
        sys.exit(1)

    query = sys.argv[1]
    namespace = sys.argv[2]
    limit = int(sys.argv[3]) if len(sys.argv) > 3 else 10

    results = search(query, namespace, limit)
    print(json.dumps(results))
