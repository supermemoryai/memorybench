import { describe, expect, test } from "bun:test"
import { parseIngestArgs } from "../src/cli/commands/ingest"
import { mergeResumeConcurrency } from "../src/orchestrator"

describe("ingest CLI concurrency", () => {
  test("passes default build concurrency to ingest runs", () => {
    expect(
      parseIngestArgs([
        "--provider",
        "supermemory",
        "--benchmark",
        "beam-1m",
        "--run-id",
        "beam-ingest-c5",
        "--concurrency",
        "5",
      ])
    ).toMatchObject({
      concurrency: { default: 5 },
    })
  })

  test("supports separate ingest and indexing limits", () => {
    expect(
      parseIngestArgs([
        "--provider",
        "supermemory",
        "--benchmark",
        "beam-1m",
        "--run-id",
        "beam-ingest-split-concurrency",
        "--concurrency-ingest",
        "7",
        "--concurrency-indexing",
        "3",
      ])
    ).toMatchObject({
      concurrency: { ingest: 7, indexing: 3 },
    })
  })

  test("overrides persisted concurrency when resuming a run", () => {
    expect(mergeResumeConcurrency({ default: 5, indexing: 8 }, { default: 20 })).toEqual({
      default: 20,
      indexing: 8,
    })
  })

  test("parses an ordered provider ingest batch size", () => {
    expect(
      parseIngestArgs([
        "--provider",
        "supermemory",
        "--benchmark",
        "beam-1m",
        "--run-id",
        "beam-ingest-c20-b5",
        "--ingest-batch-size",
        "5",
      ])
    ).toMatchObject({ ingestBatchSize: 5 })
  })

  test("rejects an invalid ingest batch size", () => {
    expect(() =>
      parseIngestArgs([
        "--provider",
        "supermemory",
        "--benchmark",
        "beam-1m",
        "--ingest-batch-size",
        "0",
      ])
    ).toThrow("--ingest-batch-size must be an integer between 1 and 600")
  })

  test("parses the per-readiness timeout in seconds", () => {
    expect(
      parseIngestArgs([
        "--provider",
        "supermemory",
        "--benchmark",
        "beam-1m",
        "--ingest-timeout-seconds",
        "300",
      ])
    ).toMatchObject({ ingestReadinessTimeoutMs: 300_000 })
  })
})
