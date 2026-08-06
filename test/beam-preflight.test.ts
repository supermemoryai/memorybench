import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CheckpointManager } from "../src/orchestrator/checkpoint"
import { Orchestrator } from "../src/orchestrator"
import { SupermemoryProvider } from "../src/providers/supermemory"

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "memorybench-beam-preflight-test-"))
  tempRoots.push(path)
  return path
}

describe("BEAM orchestration preflight", () => {
  test("rejects an invalid dataset before provider initialization or checkpoint creation", async () => {
    const root = await tempRoot()
    const manager = new CheckpointManager(join(root, "runs"))
    const initialize = spyOn(SupermemoryProvider.prototype, "initialize")

    try {
      await expect(
        new Orchestrator(manager).run({
          provider: "supermemory",
          benchmark: "beam-1m",
          judgeModel: "gpt-4.1-mini",
          runId: "invalid-beam-dataset",
          dataPath: join(root, "missing-dataset"),
          datasetRevision: "a".repeat(64),
          limit: 1,
        })
      ).rejects.toThrow("run the BEAM prepare command")

      expect(initialize).not.toHaveBeenCalled()
      expect(manager.exists("invalid-beam-dataset")).toBe(false)
    } finally {
      initialize.mockRestore()
    }
  })
})
