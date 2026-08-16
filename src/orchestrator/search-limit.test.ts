import { test, expect } from "bun:test"
import { mkdtempSync, rmSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { splitSearchBudget } from "../providers/zep"
import { runSearchPhase } from "./phases/search"
import { CheckpointManager } from "./checkpoint"
import type { Provider, SearchOptions } from "../types/provider"
import type { Benchmark } from "../types/benchmark"

// Every retrieved result becomes context in the answer prompt, so the number of results a
// provider returns is an accuracy and token advantage. The benchmark's whole cross-provider
// claim depends on that number being identical for everyone.

test("zep's edge/node budget never exceeds the caller's limit", () => {
  for (let limit = 1; limit <= 50; limit++) {
    const { edgeLimit, nodeLimit } = splitSearchBudget(limit)
    expect(edgeLimit + nodeLimit, `limit=${limit}`).toBeLessThanOrEqual(limit)
    expect(nodeLimit, `limit=${limit}`).toBeGreaterThanOrEqual(1)
    expect(edgeLimit, `limit=${limit}`).toBeGreaterThanOrEqual(0)
  }
  // Edge-heavy, as before: 10 -> 7 edges + 3 nodes rather than 10 + 10.
  expect(splitSearchBudget(10)).toEqual({ edgeLimit: 7, nodeLimit: 3 })
})

function fakeBenchmark(): Benchmark {
  const question = {
    questionId: "q1",
    question: "who?",
    questionType: "single-session-user",
    groundTruth: "someone",
    haystackSessionIds: [],
  }
  return {
    name: "fake",
    load: async () => {},
    getQuestions: () => [question],
    getHaystackSessions: () => [],
    getGroundTruth: () => question.groundTruth,
    getQuestionTypes: () => ({}),
  } as unknown as Benchmark
}

/** Stands in for a provider that ignores the limit it was handed, as Supermemory did. */
function greedyProvider(returnCount: number): Provider {
  return {
    name: "greedy",
    initialize: async () => {},
    ingest: async () => ({ documentIds: [] }),
    awaitIndexing: async () => {},
    search: async (_q: string, _o: SearchOptions) =>
      Array.from({ length: returnCount }, (_, i) => ({ chunk: `result_${i}` })),
    clear: async () => {},
  }
}

test("a provider that over-returns is truncated to the shared limit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memorybench-search-"))
  try {
    const cm = new CheckpointManager(dir)
    const checkpoint = cm.create("run-1", "greedy", "fake", "gpt-4o", "gpt-4o")
    cm.initQuestion(checkpoint, "q1", "q1-run-1", {
      question: "who?",
      groundTruth: "someone",
      questionType: "single-session-user",
    })
    // Search only runs for questions whose indexing already completed.
    checkpoint.questions.q1.phases.indexing.status = "completed"

    await runSearchPhase(greedyProvider(30), fakeBenchmark(), checkpoint, cm, ["q1"])
    await cm.flush()

    const stored = checkpoint.questions.q1.phases.search.results as unknown[]
    expect(stored).toHaveLength(10)

    // The persisted result file feeds the answer phase, so it must be capped too.
    const onDisk = JSON.parse(readFileSync(join(cm.getResultsDir("run-1"), "q1.json"), "utf8"))
    expect(onDisk.results).toHaveLength(10)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a compliant provider's results are passed through untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memorybench-search-"))
  try {
    const cm = new CheckpointManager(dir)
    const checkpoint = cm.create("run-2", "polite", "fake", "gpt-4o", "gpt-4o")
    cm.initQuestion(checkpoint, "q1", "q1-run-2", {
      question: "who?",
      groundTruth: "someone",
      questionType: "single-session-user",
    })
    checkpoint.questions.q1.phases.indexing.status = "completed"

    await runSearchPhase(greedyProvider(4), fakeBenchmark(), checkpoint, cm, ["q1"])
    await cm.flush()

    expect(checkpoint.questions.q1.phases.search.results as unknown[]).toHaveLength(4)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
