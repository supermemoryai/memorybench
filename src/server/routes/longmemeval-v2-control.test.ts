import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { LongMemEvalV2RunnerOptions } from "../../orchestrator/longmemeval-v2"
import { BuildAwareRunStore } from "../../orchestrator/build-aware-run-store"
import {
  supermemoryPreflightGatePath,
  type SupermemoryPreflightReport,
} from "../../providers/supermemory/advanced"
import type { BuildAwareRunCheckpoint, BuildAwareRunConfig } from "../../types/build-aware"
import { createLongMemEvalV2ControlHandler } from "./longmemeval-v2-control"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memorybench-v2-control-"))
  temporaryDirectories.push(root)
  return root
}

function checkpoint(
  config: BuildAwareRunConfig,
  status: BuildAwareRunCheckpoint["status"] = "completed"
) {
  return {
    schemaVersion: 1,
    executionModel: "shared-memory-build-v1",
    runId: "ui-v2-run",
    configFingerprint: "fingerprint",
    status,
    currentStage: "plan",
    config,
    targetQuestionIds: [],
    buildIds: [],
    buildLinks: {},
    questions: {},
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:01.000Z",
  } satisfies BuildAwareRunCheckpoint
}

function config(datasetPath: string): BuildAwareRunConfig {
  return {
    provider: "supermemory",
    benchmark: "longmemeval-v2",
    mode: "benchmark",
    datasetPath,
    datasetRevision: "f152293e235517d504809563c833d7190b8c713b",
    tier: "small",
    domain: "all",
    seed: "memorybench-longmemeval-v2",
    retrieval: {
      topK: 20,
      threshold: 0,
      searchMode: "hybrid",
      rerank: true,
      rewriteQuery: false,
      includeSummaries: true,
      includeChunks: true,
      includeDocuments: true,
      includeRelatedMemories: true,
      metadataFilter: {},
    },
    reader: {
      model: "gpt-5",
      reasoningEffort: "high",
      maxCompletionTokens: 20_000,
      maxContextTokens: 200_000,
      evidenceTopK: 20,
      maxImages: 100,
      maxImageBytes: 20 * 1024 * 1024,
      malformedResponseAttempts: 3,
    },
    evaluator: {
      model: "gpt-5",
      reasoningEffort: "high",
      maxCompletionTokens: 4096,
    },
    build: {
      serviceBaseUrl: "https://api.supermemory.ai",
      dreaming: "instant",
      rootFilterMode: "self",
      maxDocumentChars: 200_000,
      trajectoryConcurrency: 4,
      maxInFlightRequests: 20,
      maxTrajectoryAttempts: 4,
      indexingTimeoutMs: 30 * 60_000,
      pollIntervalMs: 2_000,
      preflightMaxAgeMs: 24 * 60 * 60_000,
      continueOnIndexingTimeout: true,
    },
    execution: { buildConcurrency: 2, questionConcurrency: 5 },
  }
}

function startBody(overrides: Record<string, unknown> = {}) {
  return {
    runId: "ui-v2-run",
    datasetPath: "../LongMemEval-V2/data/longmemeval-v2",
    runThrough: "plan",
    ...overrides,
  }
}

async function call(
  handler: ReturnType<typeof createLongMemEvalV2ControlHandler>,
  method: string,
  path: string,
  body?: unknown,
  origin?: string
) {
  const headers = new Headers()
  if (body !== undefined) headers.set("content-type", "application/json")
  if (origin) headers.set("origin", origin)
  const request = new Request(`http://localhost${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return handler(request, new URL(request.url))
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return
    await Bun.sleep(5)
  }
  throw new Error("Timed out waiting for test condition")
}

describe("LongMemEval-V2 control routes", () => {
  test("starts an offline plan with CLI-equivalent defaults and server-side credentials", async () => {
    const root = await temporaryRoot()
    const captured: LongMemEvalV2RunnerOptions[] = []
    const executeOptions: unknown[] = []
    const events: Array<Record<string, unknown>> = []
    const handler = createLongMemEvalV2ControlHandler({
      runsRoot: join(root, "runs"),
      buildsRoot: join(root, "builds"),
      artifactsRoot: join(root, "artifacts"),
      preflightRoot: join(root, "preflights"),
      runnerFactory: (options) => {
        captured.push(options)
        return {
          async execute(input) {
            executeOptions.push(input)
            return checkpoint(options.config)
          },
        }
      },
      broadcast: (event) => events.push(event),
    })

    const response = await call(handler, "POST", "/api/runs-v2/start", startBody())
    expect(response?.status).toBe(202)
    expect(await response!.json()).toMatchObject({
      message: "Run started",
      runId: "ui-v2-run",
      statusUrl: "/api/runs-v2/ui-v2-run/status",
      runUrl: "/api/runs/ui-v2-run",
    })
    const immediateCheckpoint = await new BuildAwareRunStore("ui-v2-run", join(root, "runs")).load()
    expect(immediateCheckpoint).toMatchObject({
      runId: "ui-v2-run",
      status: "running",
      currentStage: "plan",
      config: { benchmark: "longmemeval-v2" },
    })
    await waitFor(() => events.some((event) => event.type === "run_complete"))
    expect(captured).toHaveLength(1)
    expect(captured[0].supermemoryApiKey).toBeUndefined()
    expect(captured[0].openAIApiKey).toBeUndefined()
    expect(captured[0].signal).toBeInstanceOf(AbortSignal)
    expect(captured[0].config).toMatchObject({
      provider: "supermemory",
      benchmark: "longmemeval-v2",
      tier: "small",
      domain: "all",
      datasetRevision: "f152293e235517d504809563c833d7190b8c713b",
      retrieval: { topK: 20 },
      reader: { evidenceTopK: 20, model: "gpt-5", reasoningEffort: "high" },
      evaluator: { model: "gpt-5", reasoningEffort: "high" },
      build: {
        maxTrajectoryAttempts: 4,
        indexingTimeoutMs: 1_800_000,
        continueOnIndexingTimeout: true,
      },
    })
    expect(executeOptions).toEqual([{ through: "plan", forceBuild: false, freshQuery: false }])

    const status = await call(handler, "GET", "/api/runs-v2/ui-v2-run/status")
    expect(status?.status).toBe(200)
    const statusBody = await status!.json()
    expect(statusBody.active).toBe(false)
    expect(statusBody.stopping).toBe(false)
    expect(statusBody.control.events.map((event: { action: string }) => event.action)).toEqual([
      "start",
      "completed",
    ])
  })

  test("persists the selected provider, provider retrieval profile, concurrency, and launch flags", async () => {
    const root = await temporaryRoot()
    const captured: LongMemEvalV2RunnerOptions[] = []
    const handler = createLongMemEvalV2ControlHandler({
      runsRoot: join(root, "runs"),
      runnerFactory: (options) => {
        captured.push(options)
        return { execute: async () => checkpoint(options.config) }
      },
    })
    const response = await call(
      handler,
      "POST",
      "/api/runs-v2/start",
      startBody({
        provider: "filesystem",
        trajectoryConcurrency: 3,
        maxInFlightRequests: 7,
        forceBuild: true,
        freshQuery: true,
      })
    )
    expect(response?.status).toBe(202)
    await waitFor(() => captured.length === 1)
    expect(captured[0].config).toMatchObject({
      provider: "filesystem",
      retrieval: { searchMode: "memories", rerank: false },
      build: { trajectoryConcurrency: 3, maxInFlightRequests: 7 },
    })
    await waitFor(async () => {
      const current = await call(handler, "GET", "/api/runs-v2/ui-v2-run/status")
      return current?.status === 200 && (await current.json()).active === false
    })
    const status = await call(handler, "GET", "/api/runs-v2/ui-v2-run/status")
    const body = await status!.json()
    expect(body.control.events[0]).toMatchObject({
      action: "start",
      provider: "filesystem",
      forceBuild: true,
      freshQuery: true,
    })
  })

  test("keeps providers without a safe build adapter plan-only", async () => {
    const root = await temporaryRoot()
    const handler = createLongMemEvalV2ControlHandler({ runsRoot: join(root, "runs") })
    const response = await call(
      handler,
      "POST",
      "/api/runs-v2/start",
      startBody({ provider: "mem0", runThrough: "build", questionIds: ["q-1"] })
    )
    expect(response?.status).toBe(400)
    expect(await response!.json()).toEqual({
      error: "mem0 does not yet have a safe LongMemEval-V2 adapter; use Plan only",
    })
  })

  test("accepts a bounded haystack selection and configurable OpenAI models", async () => {
    const root = await temporaryRoot()
    const captured: LongMemEvalV2RunnerOptions[] = []
    const handler = createLongMemEvalV2ControlHandler({
      runsRoot: join(root, "runs"),
      runnerFactory: (options) => {
        captured.push(options)
        return { execute: async () => checkpoint(options.config) }
      },
    })

    const response = await call(
      handler,
      "POST",
      "/api/runs-v2/start",
      startBody({
        haystackLimit: 1,
        runThrough: "query",
        readerModel: "gpt-4o",
        evaluatorModel: "gpt-5.2",
        reasoningEffort: "none",
        evaluatorReasoningEffort: "none",
      })
    )
    expect(response?.status).toBe(202)
    await waitFor(() => captured.length === 1)
    expect(captured[0].config).toMatchObject({
      haystackLimit: 1,
      reader: {
        model: "gpt-4o",
        reasoningEffort: "none",
        maxCompletionTokens: 8_000,
        maxContextTokens: 120_000,
      },
      evaluator: { model: "gpt-5.2", reasoningEffort: "none" },
    })
    await waitFor(async () => {
      const status = await call(handler, "GET", "/api/runs-v2/ui-v2-run/status")
      return status?.status === 200 && (await status.json()).active === false
    })
  })

  test("rejects cross-site, unknown, key-bearing, and unsafe configurations", async () => {
    const root = await temporaryRoot()
    const handler = createLongMemEvalV2ControlHandler({
      runsRoot: join(root, "runs"),
      runnerFactory: () => ({ execute: async () => checkpoint(config(root)) }),
    })

    const crossSite = await call(
      handler,
      "POST",
      "/api/runs-v2/start",
      startBody(),
      "https://evil.example"
    )
    expect(crossSite?.status).toBe(403)

    const keyBearing = await call(
      handler,
      "POST",
      "/api/runs-v2/start",
      startBody({ supermemoryApiKey: "sm_secret-value-must-not-echo" }),
      "http://localhost:3000"
    )
    expect(keyBearing?.status).toBe(400)
    expect(JSON.stringify(await keyBearing!.json())).not.toContain("secret-value")

    const invalidTopK = await call(
      handler,
      "POST",
      "/api/runs-v2/start",
      startBody({ topK: 5, evidenceTopK: 6 })
    )
    expect(invalidTopK?.status).toBe(400)
    expect((await invalidTopK!.json()).error).toContain("cannot exceed topK")

    const medium = await call(
      handler,
      "POST",
      "/api/runs-v2/start",
      startBody({ tier: "medium", runThrough: "build", questionIds: ["q-1"] })
    )
    expect(medium?.status).toBe(400)
    expect((await medium!.json()).error).toContain("allowMedium")

    const scoringCanary = await call(
      handler,
      "POST",
      "/api/runs-v2/start",
      startBody({
        mode: "one-trajectory-canary",
        questionIds: ["question-1"],
        runThrough: "evaluate",
      })
    )
    expect(scoringCanary?.status).toBe(400)
    expect((await scoringCanary!.json()).error).toContain("may only plan, build, or query")

    const accidentalFullRun = await call(
      handler,
      "POST",
      "/api/runs-v2/start",
      startBody({ runThrough: "query" })
    )
    expect(accidentalFullRun?.status).toBe(400)
    expect((await accidentalFullRun!.json()).error).toContain("allowFullRun")

    const mixedSelectors = await call(
      handler,
      "POST",
      "/api/runs-v2/start",
      startBody({ questionIds: ["question-1"], haystackLimit: 1 })
    )
    expect(mixedSelectors?.status).toBe(400)
    expect((await mixedSelectors!.json()).error).toContain("mutually exclusive")
  })

  test("prevents duplicate active IDs and aborts the exact run on stop", async () => {
    const root = await temporaryRoot()
    let signal: AbortSignal | undefined
    const events: Array<Record<string, unknown>> = []
    const handler = createLongMemEvalV2ControlHandler({
      runsRoot: join(root, "runs"),
      runnerFactory: (options) => {
        signal = options.signal
        return {
          execute: async () =>
            new Promise<BuildAwareRunCheckpoint>((_resolve, reject) => {
              if (options.signal?.aborted) return reject(options.signal.reason)
              options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
                once: true,
              })
            }),
        }
      },
      broadcast: (event) => events.push(event),
    })

    const started = await call(handler, "POST", "/api/runs-v2/start", startBody())
    expect(started?.status).toBe(202)
    const duplicate = await call(handler, "POST", "/api/runs-v2/start", startBody())
    expect(duplicate?.status).toBe(409)

    const keyBearingStop = await call(handler, "POST", "/api/runs-v2/ui-v2-run/stop", {
      apiKey: "sm_secret-value-must-not-echo",
    })
    expect(keyBearingStop?.status).toBe(400)
    expect(signal?.aborted).toBe(false)

    const stopped = await call(handler, "POST", "/api/runs-v2/ui-v2-run/stop")
    expect(stopped?.status).toBe(202)
    expect(signal?.aborted).toBe(true)
    await waitFor(() => events.some((event) => event.type === "run_stopped"))
    const status = await call(handler, "GET", "/api/runs-v2/ui-v2-run/status")
    const body = await status!.json()
    expect(body.active).toBe(false)
    expect(body.control.events.map((event: { action: string }) => event.action)).toEqual([
      "start",
      "stop-request",
      "stopped",
    ])
  })

  test("resumes from the exact stored config and enforces monotonic stage targets", async () => {
    const root = await temporaryRoot()
    const runsRoot = join(root, "runs")
    const storedConfig = {
      ...config(resolve(root, "dataset")),
      questionIds: ["question-1"],
    }
    const store = new BuildAwareRunStore("resume-run", runsRoot)
    const stored = await store.createOrLoad(storedConfig)
    stored.status = "failed"
    stored.currentStage = "query"
    stored.error = "network interruption"
    await store.save(stored)

    const captured: LongMemEvalV2RunnerOptions[] = []
    const executions: unknown[] = []
    const handler = createLongMemEvalV2ControlHandler({
      runsRoot,
      runnerFactory: (options) => {
        captured.push(options)
        return {
          async execute(input) {
            executions.push(input)
            return { ...stored, status: "completed", currentStage: "report" }
          },
        }
      },
    })

    const earlier = await call(handler, "POST", "/api/runs-v2/resume-run/resume", {
      runThrough: "plan",
    })
    expect(earlier?.status).toBe(400)
    expect((await earlier!.json()).error).toContain("cannot be earlier")

    const resumed = await call(handler, "POST", "/api/runs-v2/resume-run/resume", {})
    expect(resumed?.status).toBe(202)
    await waitFor(() => executions.length === 1)
    expect(captured[0].config).toEqual(storedConfig)
    expect(executions).toEqual([{ through: "query", forceBuild: false, freshQuery: false }])
    await waitFor(async () => {
      const status = await call(handler, "GET", "/api/runs-v2/resume-run/status")
      return status?.status === 200 && (await status.json()).active === false
    })

    const explicitContinuation = await call(handler, "POST", "/api/runs-v2/resume-run/resume", {
      runThrough: "report",
    })
    expect(explicitContinuation?.status).toBe(202)
    await waitFor(() => executions.length === 2)
    expect(executions[1]).toEqual({ through: "report", forceBuild: false, freshQuery: false })
    await waitFor(async () => {
      const status = await call(handler, "GET", "/api/runs-v2/resume-run/status")
      return status?.status === 200 && (await status.json()).active === false
    })
  })

  test("resumes a failed canary through its checkpoint stage and exposes stale runs as resumable", async () => {
    const root = await temporaryRoot()
    const runsRoot = join(root, "runs")
    const canaryConfig = {
      ...config(resolve(root, "dataset")),
      mode: "one-trajectory-canary" as const,
      questionIds: ["question-1"],
    }
    const store = new BuildAwareRunStore("canary-resume", runsRoot)
    const stored = await store.createOrLoad(canaryConfig)
    stored.status = "running"
    stored.currentStage = "query"
    await store.save(stored)
    await writeFile(
      join(store.runRoot, "control.json"),
      JSON.stringify({
        schemaVersion: 1,
        runId: "canary-resume",
        events: [
          {
            action: "start",
            at: "2026-07-28T00:00:00.000Z",
            through: "query",
          },
        ],
      })
    )

    const executions: unknown[] = []
    const handler = createLongMemEvalV2ControlHandler({
      runsRoot,
      runnerFactory: () => ({
        async execute(input) {
          executions.push(input)
          return { ...stored, status: "completed" }
        },
      }),
    })

    const staleStatus = await call(handler, "GET", "/api/runs-v2/canary-resume/status")
    expect(await staleStatus!.json()).toMatchObject({
      active: false,
      checkpoint: {
        status: "failed",
        currentStage: "query",
        error: "Run process is no longer active; resume from the durable checkpoint",
      },
    })

    const resumed = await call(handler, "POST", "/api/runs-v2/canary-resume/resume", {})
    expect(resumed?.status).toBe(202)
    await waitFor(() => executions.length === 1)
    expect(executions).toEqual([{ through: "query", forceBuild: false, freshQuery: false }])
    await waitFor(async () => {
      const status = await call(handler, "GET", "/api/runs-v2/canary-resume/status")
      return status?.status === 200 && (await status.json()).active === false
    })
  })

  test("releases a resume reservation when lifecycle history cannot be persisted", async () => {
    const root = await temporaryRoot()
    const runsRoot = join(root, "runs")
    const store = new BuildAwareRunStore("history-failure", runsRoot)
    const stored = await store.createOrLoad({
      ...config(resolve(root, "dataset")),
      questionIds: ["question-1"],
    })
    stored.status = "failed"
    stored.currentStage = "query"
    await store.save(stored)
    await mkdir(join(store.runRoot, "control.json"))

    const handler = createLongMemEvalV2ControlHandler({
      runsRoot,
      runnerFactory: () => ({ execute: async () => stored }),
    })
    const first = await call(handler, "POST", "/api/runs-v2/history-failure/resume", {})
    expect(first?.status).toBe(500)
    const second = await call(handler, "POST", "/api/runs-v2/history-failure/resume", {})
    expect(second?.status).toBe(500)
    expect((await second!.json()).error).not.toContain("already active")
  })

  test("rejects start for an existing checkpoint and resume for a completed report", async () => {
    const root = await temporaryRoot()
    const runsRoot = join(root, "runs")
    const store = new BuildAwareRunStore("existing-run", runsRoot)
    const existing = await store.createOrLoad(config(root))
    existing.status = "completed"
    existing.currentStage = "report"
    await store.save(existing)
    const handler = createLongMemEvalV2ControlHandler({
      runsRoot,
      runnerFactory: () => ({ execute: async () => existing }),
    })

    const start = await call(
      handler,
      "POST",
      "/api/runs-v2/start",
      startBody({ runId: "existing-run" })
    )
    expect(start?.status).toBe(409)
    const resume = await call(handler, "POST", "/api/runs-v2/existing-run/resume", {})
    expect(resume?.status).toBe(409)
    expect((await resume!.json()).error).toContain("cannot be resumed")
  })

  test("requires fresh explicit confirmation before a full-scope plan can continue live", async () => {
    const root = await temporaryRoot()
    const runsRoot = join(root, "runs")
    const store = new BuildAwareRunStore("full-plan", runsRoot)
    const planned = await store.createOrLoad(config(resolve(root, "dataset")))
    planned.status = "completed"
    planned.currentStage = "plan"
    await store.save(planned)
    const executions: unknown[] = []
    const handler = createLongMemEvalV2ControlHandler({
      runsRoot,
      runnerFactory: () => ({
        async execute(input) {
          executions.push(input)
          return { ...planned, status: "completed", currentStage: "build" }
        },
      }),
    })

    const rejected = await call(handler, "POST", "/api/runs-v2/full-plan/resume", {
      runThrough: "build",
    })
    expect(rejected?.status).toBe(400)
    expect((await rejected!.json()).error).toContain("allowFullRun")
    expect(executions).toHaveLength(0)

    const confirmed = await call(handler, "POST", "/api/runs-v2/full-plan/resume", {
      runThrough: "build",
      allowFullRun: true,
    })
    expect(confirmed?.status).toBe(202)
    await waitFor(() => executions.length === 1)
    expect(executions[0]).toEqual({ through: "build", forceBuild: false, freshQuery: false })
    await waitFor(async () => {
      const status = await call(handler, "GET", "/api/runs-v2/full-plan/status")
      return status?.status === 200 && (await status.json()).active === false
    })
  })

  test("runs one bounded server-key preflight at a time and publishes the passing gate", async () => {
    const root = await temporaryRoot()
    let finishPreflight!: (report: SupermemoryPreflightReport) => void
    const pendingPreflight = new Promise<SupermemoryPreflightReport>((resolve) => {
      finishPreflight = resolve
    })
    const handler = createLongMemEvalV2ControlHandler({
      preflightRoot: join(root, "preflights"),
      serviceBaseUrl: "https://api.supermemory.ai",
      preflightRunner: () => pendingPreflight,
      now: () => Date.parse("2026-07-28T00:00:00.000Z"),
    })

    const started = await call(handler, "POST", "/api/runs-v2/preflight", { topK: 25 })
    expect(started?.status).toBe(202)
    const duplicate = await call(handler, "POST", "/api/runs-v2/preflight", { topK: 25 })
    expect(duplicate?.status).toBe(409)

    finishPreflight({
      schemaVersion: 1,
      generatedAt: "2026-07-28T00:00:00.000Z",
      baseUrl: "https://api.supermemory.ai",
      identity: {
        buildId: "preflight-ui",
        containerTag: "preflight-ui",
        runFingerprint: "preflight-ui",
      },
      searchContract: {
        searchMode: "hybrid",
        standaloneChunksExpected: true,
        deprecatedIncludeChunks: false,
        requestedTopK: 25,
      },
      checks: [],
      allPassed: true,
      blockers: [],
      requestBudget: {
        configuredCap: 20,
        effectiveCap: 20,
        inFlight: 0,
        peakInFlight: 1,
        throttleEvents: 0,
        successStreak: 1,
        notBeforeMs: 0,
      },
    })

    await waitFor(async () => {
      const response = await call(handler, "GET", "/api/runs-v2/options")
      const body = await response!.json()
      return body.preflightActivity.status === "passed" && body.preflight.status === "passing"
    })
    const options = await call(handler, "GET", "/api/runs-v2/options")
    expect(await options!.json()).toMatchObject({
      preflightActivity: { status: "passed", topK: 25 },
      preflight: { status: "passing", testedTopK: 25 },
    })
  })

  test("reports bounded prepared-dataset and non-secret prerequisite options", async () => {
    const root = await temporaryRoot()
    const dataset = join(root, "longmemeval-v2")
    await mkdir(join(dataset, "haystacks"), { recursive: true })
    await mkdir(join(dataset, "screenshots"), { recursive: true })
    await writeFile(join(dataset, "questions.jsonl"), "{}\n")
    await writeFile(join(dataset, "trajectories.jsonl"), "{}\n")
    await writeFile(join(dataset, "haystacks/lme_v2_small.json"), "{}\n")
    const preflightRoot = join(root, "preflights")
    const gatePath = supermemoryPreflightGatePath(preflightRoot, "https://api.supermemory.ai")
    await mkdir(dirname(gatePath), { recursive: true })
    await writeFile(
      gatePath,
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: "2026-07-28T00:00:00.000Z",
        baseUrl: "https://api.supermemory.ai",
        identity: {
          buildId: "preflight-test",
          containerTag: "preflight-test",
          runFingerprint: "preflight-test",
        },
        searchContract: {
          searchMode: "hybrid",
          standaloneChunksExpected: true,
          deprecatedIncludeChunks: false,
          requestedTopK: 50,
        },
        checks: [],
        allPassed: true,
        blockers: [],
        requestBudget: {},
      })
    )
    const handler = createLongMemEvalV2ControlHandler({
      runsRoot: join(root, "runs"),
      preflightRoot,
      datasetCandidates: [{ path: dataset, source: "env" }],
      now: () => Date.parse("2026-07-28T00:00:01.000Z"),
    })

    const response = await call(handler, "GET", "/api/runs-v2/options")
    expect(response?.status).toBe(200)
    const body = await response!.json()
    expect(body.defaults.datasetPath).toBe(resolve(dataset))
    expect(body.defaults.runThrough).toBe("plan")
    expect(body.haystacks).toEqual({
      small: { all: 2, web: 1, enterprise: 1, trajectoriesPerBuild: 100 },
      medium: { all: 447, web: 236, enterprise: 211 },
    })
    expect(body.datasets).toEqual([
      {
        path: resolve(dataset),
        source: "env",
        exists: true,
        coreFiles: true,
        pinnedMarker: false,
        screenshots: true,
        prepared: true,
      },
    ])
    expect(body.preflight).toEqual({
      status: "passing",
      baseUrl: "https://api.supermemory.ai",
      generatedAt: "2026-07-28T00:00:00.000Z",
      expiresAt: "2026-07-29T00:00:00.000Z",
      testedTopK: 50,
      blockers: [],
    })
    expect(typeof body.credentials.supermemoryConfigured).toBe("boolean")
    expect(typeof body.credentials.openAIConfigured).toBe("boolean")
    expect(body.providers.map((provider: { name: string }) => provider.name)).toEqual([
      "supermemory",
      "filesystem",
      "rag",
      "mem0",
      "zep",
    ])
    expect(
      body.providers.find((provider: { name: string }) => provider.name === "filesystem")
    ).toMatchObject({
      adapterAvailable: true,
      searchMode: "memories",
      requiresPreflight: false,
    })
    expect(
      body.providers.find((provider: { name: string }) => provider.name === "rag")
    ).toMatchObject({
      adapterAvailable: true,
      searchMode: "hybrid",
      requiresPreflight: false,
    })
    expect(
      body.providers.find((provider: { name: string }) => provider.name === "mem0")
    ).toMatchObject({
      adapterAvailable: false,
      capabilities: { plan: true, build: false },
    })
    expect(JSON.stringify(body)).not.toMatch(/(?:sk|sm)_[A-Za-z0-9_-]{12,}/)
  })
})
