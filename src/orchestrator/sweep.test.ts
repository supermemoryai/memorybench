import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sweepCommand } from "../cli/commands/sweep"
import type { BenchmarkResult } from "../types/unified"
import { config } from "../utils/config"
import { CheckpointManager } from "./checkpoint"
import { runContextSweep } from "./sweep"

const originalCwd = process.cwd()
const originalApiKey = config.openaiApiKey
const originalFetch = globalThis.fetch
const firstResult = "UNIQUE_EVIDENCE: the answer is a blue umbrella."
const secondResult = "DISTRACTOR: unrelated information follows."
const questionId = "fixture-q0"
const options = { sourceRunId: "source", sweepId: "experiment", depths: [0, 1, 2] }
let directory: string
let manager: CheckpointManager
let requests: Array<{ kind: "answer" | "judge"; text: string }>
let failJudge = false

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "memorybench-sweep-"))
  process.chdir(directory)
  mkdirSync("data/benchmarks/locomo", { recursive: true })
  writeFileSync(
    "data/benchmarks/locomo/locomo10.json",
    JSON.stringify([
      {
        sample_id: "fixture",
        conversation: { speaker_a: "A", speaker_b: "B" },
        qa: [{ question: "What did I buy?", answer: "blue umbrella", category: 4, evidence: [] }],
      },
    ])
  )
  manager = new CheckpointManager()
  const source = manager.create("source", "supermemory", "locomo", "gpt-4o", "gpt-4o", {
    targetQuestionIds: [questionId],
  })
  manager.initQuestion(source, questionId, "fixture", {
    question: "What did I buy?",
    questionType: "single-hop",
    groundTruth: "blue umbrella",
  })
  manager.updatePhase(source, questionId, "search", {
    status: "completed",
    durationMs: 500,
    results: [{ memory: firstResult }, { memory: secondResult }],
  })
  await manager.flush(source.runId)

  requests = []
  failJudge = false
  config.openaiApiKey = "offline-test"
  const fakeFetch = async (...[input, init]: Parameters<typeof fetch>) => {
    expect(String(input)).toBe("https://api.openai.com/v1/responses")
    const payload = JSON.stringify(JSON.parse(String(init?.body)).input)
    const kind = payload.includes("Gold answer: blue umbrella") ? "judge" : "answer"
    requests.push({ kind, text: payload })
    if (kind === "judge" && failJudge) {
      return Response.json({ error: { message: "synthetic judge failure" } }, { status: 400 })
    }
    const text =
      kind === "judge"
        ? JSON.stringify({
            label: payload.includes("Generated answer: blue umbrella") ? "CORRECT" : "WRONG",
          })
        : payload.includes("UNIQUE_EVIDENCE")
          ? "blue umbrella"
          : "unknown"
    return Response.json({
      id: "response",
      created_at: 1_700_000_000,
      model: "gpt-4o",
      output: [
        {
          type: "message",
          role: "assistant",
          id: "message",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      ],
      usage: { input_tokens: 100, output_tokens: 5 },
    })
  }
  globalThis.fetch = Object.assign(fakeFetch, { preconnect: originalFetch.preconnect })
})

afterEach(() => {
  globalThis.fetch = originalFetch
  config.openaiApiKey = originalApiKey
  process.chdir(originalCwd)
  rmSync(directory, { recursive: true, force: true })
})

function loadReport(depth: number): BenchmarkResult {
  return JSON.parse(readFileSync(`data/runs/experiment-k${depth}/report.json`, "utf8"))
}

test("CLI sweeps identical questions with zero memory requests and reports the measured tradeoff", async () => {
  const source = readFileSync(manager.getCheckpointPath("source"), "utf8")
  await sweepCommand(["--from", "source", "--sweep-id", "experiment", "--depths", "0,1,2"])
  const reports = [0, 1, 2].map(loadReport)
  const answers = requests.filter(({ kind }) => kind === "answer")
  expect(requests).toHaveLength(6)
  expect(answers[0].text).not.toContain("UNIQUE_EVIDENCE")
  expect(answers[1].text).toContain("UNIQUE_EVIDENCE")
  expect(answers[1].text).not.toContain("DISTRACTOR")
  expect(answers[2].text).toContain("DISTRACTOR")
  expect(reports.map(({ summary }) => summary.accuracy)).toEqual([0, 1, 1])
  const tokens = reports.map((report) => report.tokens!.avgContextTokens)
  expect(tokens[0]).toBe(0)
  expect(tokens[2]).toBeGreaterThan(tokens[1])
  for (const report of reports) {
    expect(report.contextSweep?.sourceDigest).toBe(reports[0].contextSweep?.sourceDigest)
    expect(report.contextSweep?.sourceRunId).toBe("source")
    expect(report.evaluations.map((evaluation) => evaluation.questionId)).toEqual([questionId])
    expect(report.latency.search.count).toBe(0)
    expect(report.retrieval).toBeUndefined()
    expect(report.memscore).toBeUndefined()
  }
  expect(readFileSync(manager.getCheckpointPath("source"), "utf8")).toBe(source)
  await runContextSweep(options)
  expect(requests).toHaveLength(6)
})

test("resumes after a judge failure without regenerating the saved answer", async () => {
  failJudge = true
  await expect(runContextSweep(options)).rejects.toThrow("synthetic judge failure")
  expect(manager.load("experiment-k0")?.status).toBe("failed")
  expect(manager.load("experiment-k0")?.questions[questionId].phases.answer.status).toBe(
    "completed"
  )
  failJudge = false
  const reports = await runContextSweep(options)
  expect(reports).toHaveLength(3)
  expect(requests.filter(({ kind }) => kind === "answer")).toHaveLength(3)
  expect(requests.filter(({ kind }) => kind === "judge")).toHaveLength(4)
})

test("rejects incomplete retrieval and excessive depths before calling a model", async () => {
  await expect(runContextSweep({ ...options, depths: [0, 3] })).rejects.toThrow("2 results")
  const source = manager.load("source")!
  manager.updatePhase(source, questionId, "search", { status: "pending" })
  await manager.flush(source.runId)
  await expect(runContextSweep(options)).rejects.toThrow("no completed search snapshot")
  expect(requests).toHaveLength(0)
})

test("refuses to mix variants with a changed source snapshot", async () => {
  await runContextSweep(options)
  requests.length = 0
  const source = manager.load("source")!
  manager.updatePhase(source, questionId, "search", {
    results: [{ memory: secondResult }, { memory: firstResult }],
  })
  await manager.flush(source.runId)
  await expect(runContextSweep(options)).rejects.toThrow("different inputs")
  expect(requests).toHaveLength(0)
})

test("two invocations of the same sweep cannot both run paid phases", async () => {
  const active = runContextSweep(options)
  await expect(runContextSweep(options)).rejects.toThrow("already running")
  await active
  expect(requests).toHaveLength(6)
})
