import { access, mkdir, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import type {
  BuildAwareQuestionCheckpoint,
  BuildAwareRunCheckpoint,
  BuildAwareRunConfig,
  BuildAwareStage,
  StageState,
} from "../types/build-aware"
import { atomicWriteJson, stableHash } from "../core/canonical"

function validateRunId(runId: string): void {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(runId)) {
    throw new Error("runId must match [A-Za-z0-9_-]+ and be <= 100 characters")
  }
}

export class BuildAwareRunStore {
  readonly runRoot: string
  readonly checkpointPath: string
  private saveQueue: Promise<void> = Promise.resolve()

  constructor(
    readonly runId: string,
    root = "data/runs-v2"
  ) {
    validateRunId(runId)
    this.runRoot = resolve(root, runId)
    this.checkpointPath = resolve(this.runRoot, "checkpoint.json")
  }

  async exists(): Promise<boolean> {
    try {
      await access(this.checkpointPath)
      return true
    } catch {
      return false
    }
  }

  async createOrLoad(config: BuildAwareRunConfig): Promise<BuildAwareRunCheckpoint> {
    const configFingerprint = stableHash({
      ...config,
      datasetPath: undefined,
    })
    if (await this.exists()) {
      const checkpoint = await this.load()
      if (checkpoint.configFingerprint !== configFingerprint) {
        throw new Error(
          `Run ${this.runId} already exists with a different configuration; use a new run ID`
        )
      }
      return checkpoint
    }
    await mkdir(this.runRoot, { recursive: true })
    const timestamp = new Date().toISOString()
    const checkpoint: BuildAwareRunCheckpoint = {
      schemaVersion: 1,
      executionModel: "shared-memory-build-v1",
      runId: this.runId,
      configFingerprint,
      status: "running",
      currentStage: "plan",
      config,
      targetQuestionIds: [],
      buildIds: [],
      buildLinks: {},
      questions: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    await this.save(checkpoint)
    return checkpoint
  }

  async load(): Promise<BuildAwareRunCheckpoint> {
    const checkpoint = JSON.parse(
      await readFile(this.checkpointPath, "utf8")
    ) as BuildAwareRunCheckpoint
    if (
      checkpoint.schemaVersion !== 1 ||
      checkpoint.executionModel !== "shared-memory-build-v1" ||
      checkpoint.runId !== this.runId
    ) {
      throw new Error(`Invalid build-aware checkpoint at ${this.checkpointPath}`)
    }
    return checkpoint
  }

  async save(checkpoint: BuildAwareRunCheckpoint): Promise<void> {
    checkpoint.updatedAt = new Date().toISOString()
    this.saveQueue = this.saveQueue.then(() => atomicWriteJson(this.checkpointPath, checkpoint))
    await this.saveQueue
  }

  async initializeQuestion(
    checkpoint: BuildAwareRunCheckpoint,
    input: Omit<BuildAwareQuestionCheckpoint, "stages">
  ): Promise<void> {
    const existing = checkpoint.questions[input.questionId]
    if (existing) {
      if (
        existing.question !== input.question ||
        existing.groundTruth !== input.groundTruth ||
        existing.evalFunction !== input.evalFunction ||
        existing.buildId !== input.buildId ||
        existing.questionImageHash !== input.questionImageHash
      ) {
        throw new Error(`Question ${input.questionId} changed since checkpoint creation`)
      }
      return
    }
    checkpoint.questions[input.questionId] = {
      ...input,
      stages: {
        query: { status: "pending" },
        read: { status: "pending" },
        evaluate: { status: "pending" },
      },
    }
    await this.save(checkpoint)
  }

  async updateQuestionStage(
    checkpoint: BuildAwareRunCheckpoint,
    questionId: string,
    stage: "query" | "read" | "evaluate",
    update: Partial<StageState>
  ): Promise<void> {
    const question = checkpoint.questions[questionId]
    if (!question) throw new Error(`Unknown checkpoint question ${questionId}`)
    question.stages[stage] = { ...question.stages[stage], ...update }
    await this.save(checkpoint)
  }

  async setStage(
    checkpoint: BuildAwareRunCheckpoint,
    stage: BuildAwareStage,
    status: BuildAwareRunCheckpoint["status"] = "running"
  ): Promise<void> {
    checkpoint.currentStage = stage
    checkpoint.status = status
    if (status === "running") checkpoint.error = undefined
    await this.save(checkpoint)
  }

  async fail(checkpoint: BuildAwareRunCheckpoint, error: unknown): Promise<void> {
    checkpoint.status = "failed"
    checkpoint.error = error instanceof Error ? error.message : String(error)
    await this.save(checkpoint)
  }

  async flush(): Promise<void> {
    await this.saveQueue
  }
}
