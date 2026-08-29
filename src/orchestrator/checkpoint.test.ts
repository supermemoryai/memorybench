import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { CheckpointManager } from "./checkpoint"
import type { RunCheckpoint } from "../types/checkpoint"

const tempDirs: string[] = []

function makeManager(): CheckpointManager {
  const dir = mkdtempSync(join(tmpdir(), "memorybench-checkpoint-"))
  tempDirs.push(dir)
  return new CheckpointManager(dir)
}

function makeCheckpoint(runId: string): RunCheckpoint {
  return {
    runId,
    provider: "rag",
    benchmark: "longmemeval",
    judge: "gpt-4o",
    answeringModel: "gpt-4o",
    status: "running",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    questions: {},
  } as RunCheckpoint
}

/** Read/write the manager's private basePath, so a test can break and repair writes. */
function basePathOf(manager: CheckpointManager): { get(): string; set(p: string): void } {
  const target = manager as unknown as { basePath: string }
  return { get: () => target.basePath, set: (p: string) => (target.basePath = p) }
}

/**
 * Force every write for this run to fail, the way ENOSPC/EACCES or a read-only
 * volume would. Rooting the run directory under a regular *file* makes both the
 * mkdir and the write fail with ENOTDIR. Returns the original base path.
 */
function breakWrites(manager: CheckpointManager): string {
  const basePath = basePathOf(manager)
  const original = basePath.get()
  const wall = join(original, "wall")
  writeFileSync(wall, "a file where a directory is required")
  basePath.set(join(wall, "nested"))
  return original
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

describe("CheckpointManager.save", () => {
  test("persists the checkpoint", async () => {
    const manager = makeManager()
    const checkpoint = makeCheckpoint("run-ok")

    manager.save(checkpoint)
    await manager.flush("run-ok")

    expect(existsSync(manager.getCheckpointPath("run-ok"))).toBe(true)
    expect(manager.load("run-ok")?.runId).toBe("run-ok")
  })

  test("snapshots the checkpoint at call time, not at write time", async () => {
    const manager = makeManager()
    const checkpoint = makeCheckpoint("run-snapshot")

    checkpoint.status = "running"
    manager.save(checkpoint)
    // Mutate immediately, while the first write is still queued — as concurrent
    // updatePhase calls do. The queued write must not pick this up.
    checkpoint.status = "completed"

    await manager.flush("run-snapshot")

    expect(manager.load("run-snapshot")?.status).toBe("running")
  })

  test("a failing save does not become an unhandled rejection", async () => {
    const manager = makeManager()
    const checkpoint = makeCheckpoint("run-unhandled")
    breakWrites(manager)

    const rejections: unknown[] = []
    const onRejection = (e: unknown) => rejections.push(e)
    process.on("unhandledRejection", onRejection)

    manager.save(checkpoint)
    await manager.flush("run-unhandled").catch(() => {})
    // Give the microtask queue a chance to report an unhandled rejection.
    await new Promise((resolve) => setTimeout(resolve, 50))

    process.off("unhandledRejection", onRejection)
    expect(rejections).toEqual([])
  })

  test("a failed save does not stop later saves from running", async () => {
    const manager = makeManager()
    const checkpoint = makeCheckpoint("run-chained")

    const original = breakWrites(manager)
    manager.save(checkpoint)
    await manager.flush("run-chained").catch(() => {})

    // Repair the destination and save again: the second write must actually run
    // rather than chaining onto a rejected promise and being skipped.
    basePathOf(manager).set(original)
    checkpoint.status = "completed"
    manager.save(checkpoint)
    await manager.flush("run-chained")

    expect(manager.load("run-chained")?.status).toBe("completed")
  })
})

describe("CheckpointManager.flush", () => {
  test("resolves quietly when every save succeeded", async () => {
    const manager = makeManager()
    manager.save(makeCheckpoint("run-quiet"))

    await manager.flush("run-quiet")
    expect(manager.hasSaveError("run-quiet")).toBe(false)
  })

  test("reports a write failure as a checkpoint-persistence error", async () => {
    const manager = makeManager()
    breakWrites(manager)
    manager.save(makeCheckpoint("run-failing"))

    // The message must name checkpoint persistence — the whole point is that an
    // opaque rejection used to surface as an unrelated run failure.
    await expect(manager.flush("run-failing")).rejects.toThrow(/Checkpoint could not be persisted/)
  })

  test("names the affected run", async () => {
    const manager = makeManager()
    breakWrites(manager)
    manager.save(makeCheckpoint("run-named"))

    await expect(manager.flush("run-named")).rejects.toThrow(/run-named/)
  })

  test("consumes the error so a later clean flush succeeds", async () => {
    const manager = makeManager()
    const checkpoint = makeCheckpoint("run-consumed")
    breakWrites(manager)

    manager.save(checkpoint)
    await expect(manager.flush("run-consumed")).rejects.toThrow()

    // Same failure must not be re-reported once it has been surfaced.
    await manager.flush("run-consumed")
    expect(manager.hasSaveError("run-consumed")).toBe(false)
  })

  test("flushing every run surfaces a failure from any of them", async () => {
    const manager = makeManager()
    breakWrites(manager)
    manager.save(makeCheckpoint("run-all"))

    await expect(manager.flush()).rejects.toThrow(/Checkpoint could not be persisted/)
  })

  test("deleting a run clears its pending error", async () => {
    const manager = makeManager()
    breakWrites(manager)
    manager.save(makeCheckpoint("run-deleted"))
    await manager.flush("run-deleted").catch(() => {})

    manager.save(makeCheckpoint("run-deleted"))
    await new Promise((resolve) => setTimeout(resolve, 20))
    manager.delete("run-deleted")

    expect(manager.hasSaveError("run-deleted")).toBe(false)
    await manager.flush()
  })
})

describe("CheckpointManager save ordering", () => {
  test("queued saves are applied in call order", async () => {
    const manager = makeManager()
    const checkpoint = makeCheckpoint("run-order")

    for (const status of ["initializing", "running", "completed"] as const) {
      checkpoint.status = status
      manager.save(checkpoint)
    }
    await manager.flush("run-order")

    const written = JSON.parse(readFileSync(manager.getCheckpointPath("run-order"), "utf8"))
    expect(written.status).toBe("completed")
  })
})
