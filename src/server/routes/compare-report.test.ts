import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { batchManager, type CompareManifest } from "../../orchestrator/batch"
import type { BenchmarkResult } from "../../types/unified"
import { logger } from "../../utils/logger"
import { handleCompareRoutes } from "./compare"

const manifest: CompareManifest = {
  compareId: "fixture",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  benchmark: "locomo",
  judge: "gpt-4o",
  answeringModel: "gpt-4o",
  targetQuestionIds: ["easy", "hard"],
  runs: [
    { provider: "mem0", runId: "first" },
    { provider: "supermemory", runId: "second" },
  ],
}

function reportFor(run: (typeof manifest.runs)[number], ids: readonly string[]): BenchmarkResult {
  const latency = { min: 0, max: 0, mean: 0, median: 0, p95: 0, p99: 0, stdDev: 0, count: 0 }
  return {
    ...run,
    dataSourceRunId: run.runId,
    benchmark: manifest.benchmark,
    judge: manifest.judge,
    answeringModel: manifest.answeringModel,
    timestamp: manifest.createdAt,
    summary: { totalQuestions: ids.length, correctCount: ids.length, accuracy: 1 },
    latency: {
      ingest: latency,
      indexing: latency,
      search: latency,
      answer: latency,
      evaluate: latency,
      total: latency,
    },
    byQuestionType: {},
    evaluations: ids.map((questionId) => ({
      questionId,
      questionType: "fixture",
      question: "?",
      groundTruth: "answer",
      hypothesis: "answer",
      explanation: "",
      score: 1,
      label: "correct",
      searchResults: [],
      searchDurationMs: 0,
      answerDurationMs: 0,
      totalDurationMs: 0,
    })),
  }
}

function useReports(second: BenchmarkResult | null, comparison = manifest) {
  spyOn(batchManager, "loadManifest").mockReturnValue(comparison)
  spyOn(batchManager, "loadReport").mockImplementation((runId) =>
    runId === "first" ? reportFor(manifest.runs[0], ["easy", "hard"]) : second
  )
}

async function comparisonReport() {
  const url = new URL("http://localhost/api/compare/fixture/report")
  const response = await handleCompareRoutes(new Request(url), url)
  expect(response?.status).toBe(200)
  return response!.json()
}

afterEach(() => mock.restore())

test.each([
  { label: "a missing provider report", ids: null, matched: 0 },
  { label: "a partial cohort", ids: ["easy"], matched: 1 },
  { label: "a different cohort with the same size", ids: ["easy", "other"], matched: 1 },
  { label: "duplicate rows with the same size", ids: ["easy", "easy"], matched: 1 },
])("withholds rankings with $label", async ({ ids, matched }) => {
  useReports(ids && reportFor(manifest.runs[1], ids))
  const result = await comparisonReport()
  expect(result.reports).toEqual([])
  expect(result.targetQuestionCount).toBe(2)
  expect(result.coverage[1]).toMatchObject({
    provider: "supermemory",
    matchedQuestions: matched,
    issue: expect.any(String),
  })
})

test("withholds a report generated with a different judge", async () => {
  const report = reportFor(manifest.runs[1], ["easy", "hard"])
  useReports({ ...report, judge: "another-judge" })
  const result = await comparisonReport()
  expect(result.reports).toEqual([])
  expect(result.coverage[1].issue).toContain("run metadata")
})

test("does not compare reused IDs with different reference answers", async () => {
  const report = reportFor(manifest.runs[1], ["easy", "hard"])
  report.evaluations[1].groundTruth = "different answer"
  useReports(report)
  const result = await comparisonReport()
  expect(result.reports).toEqual([])
  expect(result.coverage[1].issue).toBe("Question content differs for hard")
})

test("does not infer a comparison cohort from the reports when the manifest has none", async () => {
  useReports(reportFor(manifest.runs[1], ["easy", "hard"]), {
    ...manifest,
    targetQuestionIds: [],
  })
  const result = await comparisonReport()
  expect(result.reports).toEqual([])
  expect(result.unavailableReason).toContain("unique target question IDs")
})

test("accepts the full cohort in a different order", async () => {
  useReports(reportFor(manifest.runs[1], ["hard", "easy"]))
  const result = await comparisonReport()
  expect(result.reports.map((entry: { provider: string }) => entry.provider)).toEqual([
    "mem0",
    "supermemory",
  ])
  expect(
    result.coverage.every(
      (row: { matchedQuestions: number; issue?: string }) =>
        row.matchedQuestions === 2 && row.issue === undefined
    )
  ).toBe(true)
})

test("the CLI withholds winner tables when a provider is missing", () => {
  useReports(null)
  const warn = spyOn(logger, "warn").mockImplementation(() => {})
  const output = spyOn(console, "log").mockImplementation(() => {})
  batchManager.printComparisonReport(manifest)
  expect(warn.mock.calls.flat().join("\n")).toContain("supermemory")
  expect(output.mock.calls.flat().join("\n")).not.toContain("OVERALL ACCURACY")
})
