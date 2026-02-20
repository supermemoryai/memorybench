#!/usr/bin/env python3
"""
RagZoom HTTP Bridge Server

A thin FastAPI server that wraps the RagZoom gRPC Python client,
exposing a simple REST API for the memorybench TypeScript provider.

Endpoints:
  POST /ingest       — batch_append content into a document
  POST /search       — agentic search over a document
  GET  /status/:id   — document indexing status (completion_pct)
  POST /clear        — clear a document
  GET  /health       — health check

Start: python3 bridge.py [--port 8079] [--grpc-address localhost:50052]
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import time

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import uvicorn

# Ensure ragzoom is importable (pip install -e ~/dynamic-summary)
try:
    from ragzoom.wrapper import RagZoom, AppendUnit
except ImportError as exc:
    print(
        f"ERROR: Cannot import ragzoom: {exc}\n"
        "Make sure ragzoom is installed: pip install -e ~/dynamic-summary",
        file=sys.stderr,
    )
    sys.exit(1)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("ragzoom-bridge")

app = FastAPI(title="RagZoom MemoryBench Bridge", version="0.1.0")

# Global RagZoom client — initialized at startup
_rz: RagZoom | None = None


def get_rz() -> RagZoom:
    if _rz is None:
        raise RuntimeError("RagZoom client not initialized")
    return _rz


# ── Request/Response models ──────────────────────────────────────────────────


class AppendUnitPayload(BaseModel):
    text: str
    time_start: str | None = None
    time_end: str | None = None


class IngestRequest(BaseModel):
    document_id: str
    units: list[AppendUnitPayload]


class IngestResponse(BaseModel):
    document_id: str
    chunks_created: int
    leaf_count: int


class SearchRequest(BaseModel):
    question: str
    document_id: str


class SearchResponse(BaseModel):
    answer: str


class StatusResponse(BaseModel):
    document_id: str
    exists: bool
    completion_pct: float
    leaf_count: int
    node_count: int
    has_pending_work: bool


class ClearRequest(BaseModel):
    document_id: str


class ClearResponse(BaseModel):
    document_id: str
    cleared: bool


# ── Endpoints ────────────────────────────────────────────────────────────────


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/ingest", response_model=IngestResponse)
def ingest(req: IngestRequest):
    rz = get_rz()
    units = []
    for u in req.units:
        if u.time_start and u.time_end:
            units.append(AppendUnit(text=u.text, time_start=u.time_start, time_end=u.time_end))
        else:
            units.append(AppendUnit(text=u.text))

    try:
        result = rz.batch_append(req.document_id, units)
    except Exception as exc:
        logger.error("batch_append failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))

    # Get leaf count from status
    try:
        status = rz.get_document_status(req.document_id)
        leaf_count = status.leaf_count
    except Exception:
        leaf_count = 0

    return IngestResponse(
        document_id=req.document_id,
        chunks_created=result.chunks_created,
        leaf_count=leaf_count,
    )


@app.post("/search", response_model=SearchResponse)
def search(req: SearchRequest):
    rz = get_rz()
    try:
        result = rz.search(req.question, req.document_id)
    except Exception as exc:
        logger.error("search failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))

    return SearchResponse(answer=result.answer)


@app.get("/status/{document_id}", response_model=StatusResponse)
def status(document_id: str):
    rz = get_rz()
    try:
        s = rz.get_document_status(document_id)
    except Exception as exc:
        logger.error("get_document_status failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))

    # Also check work queue status for has_pending_work
    has_pending = False
    if s.exists:
        try:
            from ragzoom.client.grpc_client import GrpcRagzoomClient
            # Re-use the address from the RagZoom wrapper
            addr = rz._address
            if addr:
                with GrpcRagzoomClient(addr) as client:
                    work = client.get_document_work_status(document_id)
                    has_pending = work.has_pending_work
        except Exception:
            # If we can't check work status, infer from completion_pct
            has_pending = s.completion_pct < 100.0

    return StatusResponse(
        document_id=s.document_id,
        exists=s.exists,
        completion_pct=s.completion_pct,
        leaf_count=s.leaf_count,
        node_count=s.node_count,
        has_pending_work=has_pending,
    )


@app.post("/clear", response_model=ClearResponse)
def clear(req: ClearRequest):
    rz = get_rz()
    try:
        rz.clear(req.document_id)
    except Exception as exc:
        logger.error("clear failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))

    return ClearResponse(document_id=req.document_id, cleared=True)


# ── Main ─────────────────────────────────────────────────────────────────────


def main():
    global _rz

    parser = argparse.ArgumentParser(description="RagZoom HTTP Bridge for MemoryBench")
    parser.add_argument(
        "--port", type=int, default=int(os.environ.get("RAGZOOM_BRIDGE_PORT", "8079")),
        help="HTTP port (default: 8079 or RAGZOOM_BRIDGE_PORT env)",
    )
    parser.add_argument(
        "--grpc-address",
        default=os.environ.get("RAGZOOM_SERVER_ADDRESS", "localhost:50052"),
        help="RagZoom gRPC address (default: localhost:50052 or RAGZOOM_SERVER_ADDRESS env)",
    )
    parser.add_argument(
        "--timeout", type=float, default=300.0,
        help="gRPC timeout in seconds for long operations like search (default: 300)",
    )
    args = parser.parse_args()

    logger.info("Connecting to RagZoom gRPC at %s", args.grpc_address)
    _rz = RagZoom(server_address=args.grpc_address, timeout=args.timeout)

    logger.info("Starting bridge on port %d", args.port)
    uvicorn.run(app, host="0.0.0.0", port=args.port, log_level="info")


if __name__ == "__main__":
    main()
