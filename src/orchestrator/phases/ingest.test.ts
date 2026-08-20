import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { runIngestPhase } from "./ingest"
import { CheckpointManager } from "../checkpoint"
import type { Benchmark } from "../../types/benchmark"
import type { Provider, IngestResult } from "../../types/provider"
import type { RunCheckpoint } from "../../types/checkpoint"
import type { UnifiedQuestion, UnifiedSession } from "../../types/unified"

const QUESTION_ID = "q1"
const SESSION_IDS = ["s1", "s2", "s3", "s4"]

const tempDirs: string[] = []

function makeManager(): CheckpointManager {
  const dir = mkdtempSync(join(tmpdir(), "memorybench-ingest-"))
  tempDirs.push(dir)
  return new CheckpointManager(dir)
}

/**
 * Wait for the queued checkpoint writes to reach disk. save() returns before the
 * write happens, so a test that reads the file has to drain the queue first.
 */
async function settleSaves(manager: CheckpointManager, runId: string): Promise<void> {
  const locks = (manager as unknown as { saveLock: Map<string, Promise<void>> }).saveLock
  for (let i = 0; i < 20; i++) {
    const pending = locks.get(runId)
    if (!pending) return
    await pending.catch(() => {})
  }
}

function makeQuestion(): UnifiedQuestion {
  return {
    questionId: QUESTION_ID,
    question: "what did I say?",
    questionType: "single-session-user",
    groundTruth: "something",
    haystackSessionIds: [...SESSION_IDS],
  }
}

function makeBenchmark(): Benchmark {
  const sessions: UnifiedSession[] = SESSION_IDS.map((sessionId) => ({
    sessionId,
    messages: [{ role: "user", content: `message in ${sessionId}` }],
  }))

  return {
    name: "test",
    load: async () => {},
    getQuestions: () => [makeQuestion()],
    getHaystackSessions: () => sessions,
    getGroundTruth: () => "something",
    getQuestionTypes: () => ({}),
  }
}

/**
 * Ingests one session at a time, minting an id per session, and throws on the
 * session ids listed in `failOn` — the shape of a provider that dies partway
 * through a question (rate limit, oversized payload, dropped connection).
 */
function makeProvider(failOn: string[] = []): Provider {
  return {
    name: "test",
    initialize: async () => {},
    ingest: async (sessions: UnifiedSession[]): Promise<IngestResult> => {
      const ids: string[] = []
      const tasks: string[] = []
      for (const session of sessions) {
        if (failOn.includes(session.sessionId)) {
          throw new Error(`provider refused ${session.sessionId}`)
        }
        ids.push(`doc-${session.sessionId}`)
        tasks.push(`task-${session.sessionId}`)
      }
      return { documentIds: ids, taskIds: tasks }
    },
    awaitIndexing: async () => {},
    search: async () => [],
    clear: async () => {},
  }
}

function makeCheckpoint(manager: CheckpointManager, runId: string): RunCheckpoint {
  const checkpoint = manager.create(runId, "test", "test", "gpt-4o", "gpt-4o")
  manager.initQuestion(checkpoint, QUESTION_ID, `${QUESTION_ID}-${runId}`, {
    question: "what did I say?",
    groundTruth: "something",
    questionType: "single-session-user",
  })
  return checkpoint
}

/** Reload the checkpoint from disk, the way resuming a run does. */
async function reload(manager: CheckpointManager, runId: string): Promise<RunCheckpoint> {
  await settleSaves(manager, runId)
  const loaded = manager.load(runId)
  if (!loaded) throw new Error("checkpoint was not written")
  return loaded
}

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe("runIngestPhase", () => {
  test("keeps the document ids of sessions ingested before a later session failed", async () => {
    const manager = makeManager()
    const runId = "run-partial"
    const checkpoint = makeCheckpoint(manager, runId)

    await expect(
      runIngestPhase(makeProvider(["s3"]), makeBenchmark(), checkpoint, manager)
    ).rejects.toThrow(/provider refused s3/)

    const persisted = (await reload(manager, runId)).questions[QUESTION_ID].phases.ingest

    // The two ids must be on disk, not just in the failed attempt's memory: the
    // sessions that produced them are already recorded as completed, so a resume
    // skips them and never mints the ids again.
    expect(persisted.completedSessions).toEqual(["s1", "s2"])
    expect(persisted.ingestResult?.documentIds).toEqual(["doc-s1", "doc-s2"])
    expect(persisted.ingestResult?.taskIds).toEqual(["task-s1", "task-s2"])
  })

  test("resuming after a failure ends up with every session's ids exactly once", async () => {
    const manager = makeManager()
    const runId = "run-resume"

    await expect(
      runIngestPhase(makeProvider(["s3"]), makeBenchmark(), makeCheckpoint(manager, runId), manager)
    ).rejects.toThrow()

    const resumed = await reload(manager, runId)
    await runIngestPhase(makeProvider(), makeBenchmark(), resumed, manager)

    const persisted = (await reload(manager, runId)).questions[QUESTION_ID].phases.ingest

    expect(persisted.status).toBe("completed")
    expect(persisted.completedSessions).toEqual(SESSION_IDS)
    // Indexing waits on exactly this list before search is allowed to run, so a
    // short list lets search query sessions the provider has not indexed yet.
    expect(persisted.ingestResult?.documentIds).toEqual(SESSION_IDS.map((s) => `doc-${s}`))
    expect(persisted.ingestResult?.taskIds).toEqual(SESSION_IDS.map((s) => `task-${s}`))
  })

  test("does not double-count ids when the phase completes in a single attempt", async () => {
    const manager = makeManager()
    const runId = "run-clean"
    const checkpoint = makeCheckpoint(manager, runId)

    await runIngestPhase(makeProvider(), makeBenchmark(), checkpoint, manager)

    const persisted = (await reload(manager, runId)).questions[QUESTION_ID].phases.ingest

    expect(persisted.ingestResult?.documentIds).toEqual(SESSION_IDS.map((s) => `doc-${s}`))
  })

  test("re-running a completed question is a no-op rather than a second copy", async () => {
    const manager = makeManager()
    const runId = "run-rerun"
    const checkpoint = makeCheckpoint(manager, runId)

    await runIngestPhase(makeProvider(), makeBenchmark(), checkpoint, manager)
    await runIngestPhase(makeProvider(), makeBenchmark(), await reload(manager, runId), manager)

    const persisted = (await reload(manager, runId)).questions[QUESTION_ID].phases.ingest

    expect(persisted.ingestResult?.documentIds).toEqual(SESSION_IDS.map((s) => `doc-${s}`))
  })

  test("omits taskIds entirely for providers that do not report them", async () => {
    const manager = makeManager()
    const runId = "run-no-tasks"
    const checkpoint = makeCheckpoint(manager, runId)

    const provider = makeProvider()
    provider.ingest = async (sessions: UnifiedSession[]) => ({
      documentIds: sessions.map((s) => `doc-${s.sessionId}`),
    })

    await runIngestPhase(provider, makeBenchmark(), checkpoint, manager)

    const persisted = (await reload(manager, runId)).questions[QUESTION_ID].phases.ingest

    expect(persisted.ingestResult?.documentIds).toEqual(SESSION_IDS.map((s) => `doc-${s}`))
    expect(persisted.ingestResult?.taskIds).toBeUndefined()
  })
})
