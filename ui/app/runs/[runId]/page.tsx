"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import Link from "next/link"
import { useParams, useSearchParams, useRouter } from "next/navigation"
import { getRun, getRunReport, stopRun, startRun, type RunDetail } from "@/lib/api"
import { formatDate, getStatusColor, cn } from "@/lib/utils"
import { PhaseProgress } from "@/components/phase-progress"
import { QuestionList } from "@/components/question-list"
import {
  StatsGrid,
  AccuracyByType,
  LatencyTable,
  RetrievalMetrics,
} from "@/components/benchmark-results"

type Tab = "overview" | "results"

const POLL_INTERVAL = 2000 // 2 seconds

export default function RunDetailPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()
  const runId = decodeURIComponent(params.runId as string)
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null)

  // Get tab from URL or default to "overview"
  const tabFromUrl = searchParams.get("tab") as Tab | null
  const initialTab: Tab =
    tabFromUrl && ["overview", "results"].includes(tabFromUrl) ? tabFromUrl : "overview"

  const [run, setRun] = useState<RunDetail | null>(null)
  const [report, setReport] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<Tab>(initialTab)
  const [terminating, setTerminating] = useState(false)

  // Check if run is in progress (include stopping to keep polling until fully stopped)
  const isInitializing = run?.status === "initializing"
  const isRunning =
    run?.status === "running" ||
    run?.status === "pending" ||
    run?.status === "stopping" ||
    isInitializing
  const isStopping = run?.status === "stopping"
  const isFailed = run?.status === "failed"
  const isPartial = run?.status === "partial"
  const canContinue = isFailed || isPartial

  const [continuing, setContinuing] = useState(false)

  async function handleContinue() {
    if (continuing || !run) return
    setContinuing(true)
    try {
      await startRun({
        provider: run.provider,
        benchmark: run.benchmark,
        runId: run.runId,
        judgeModel: run.judge,
        answeringModel: run.answeringModel,
      })
      await refreshData()
    } catch (e) {
      console.error("Failed to continue:", e)
    } finally {
      setContinuing(false)
    }
  }

  async function handleTerminate() {
    if (terminating) return
    setTerminating(true)
    try {
      await stopRun(runId)
      await refreshData()
    } catch (e) {
      console.error("Failed to terminate:", e)
    } finally {
      setTerminating(false)
    }
  }

  // Update URL when tab changes
  const handleTabChange = (tab: Tab) => {
    setActiveTab(tab)
    const newUrl =
      tab === "overview"
        ? `/runs/${encodeURIComponent(runId)}`
        : `/runs/${encodeURIComponent(runId)}?tab=${tab}`
    router.replace(newUrl, { scroll: false })
  }

  // Silent refresh (no loading state)
  const refreshData = useCallback(async () => {
    try {
      const [runData, reportData] = await Promise.all([
        getRun(runId),
        getRunReport(runId).catch(() => null),
      ])
      setRun(runData)
      setReport(reportData)
      setError(null)
    } catch (e) {
      // Silent fail on poll
    }
  }, [runId])

  // Initial load
  useEffect(() => {
    loadData()
  }, [runId])

  // Polling when run is in progress
  useEffect(() => {
    if (isRunning) {
      pollIntervalRef.current = setInterval(refreshData, POLL_INTERVAL)
    } else {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
        pollIntervalRef.current = null
      }
    }

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
      }
    }
  }, [isRunning, refreshData])

  async function loadData() {
    try {
      setLoading(true)
      const [runData, reportData] = await Promise.all([
        getRun(runId),
        getRunReport(runId).catch(() => null),
      ])
      setRun(runData)
      setReport(reportData)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load run")
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (error || !run) {
    return (
      <div className="text-center py-12">
        <p className="text-status-error">{error || "Run not found"}</p>
        <Link href="/runs" className="btn btn-secondary mt-4">
          Back to runs
        </Link>
      </div>
    )
  }

  // Show initializing state while benchmark is loading/downloading
  if (isInitializing) {
    return (
      <div className="animate-fade-in">
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 text-sm text-text-secondary mb-4">
          <Link href="/runs" className="hover:text-text-primary">
            Runs
          </Link>
          <span>/</span>
          <span className="text-text-primary font-mono">{runId}</span>
        </div>

        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-display font-semibold text-text-primary flex items-center gap-3">
            {runId}
            <span className="badge text-sm bg-accent/10 text-accent">initializing</span>
          </h1>
          <div className="flex items-center gap-4 mt-2 text-sm text-text-secondary">
            <span>
              <span className="text-text-muted">Provider:</span>{" "}
              <span className="capitalize">{run.provider}</span>
            </span>
            <span>
              <span className="text-text-muted">Benchmark:</span>{" "}
              <span className="capitalize">{run.benchmark}</span>
            </span>
          </div>
        </div>

        {/* Loading State */}
        <div className="flex flex-col items-center justify-center py-16 border border-border rounded-lg">
          <div className="w-10 h-10 border-2 border-accent border-t-transparent rounded-full animate-spin mb-4" />
          <p className="text-text-secondary text-lg">Loading benchmark dataset...</p>
          <p className="text-text-muted text-sm mt-2">
            This may take a moment for first-time downloads
          </p>
        </div>
      </div>
    )
  }

  const allQuestions = Object.values(run.questions)
  // Only count questions that have been evaluated
  const evaluatedQuestions = allQuestions.filter((q) => q.phases.evaluate.status === "completed")
  const failedQuestions = evaluatedQuestions.filter((q) => q.phases.evaluate.label === "incorrect")
  const accuracy =
    report?.summary?.accuracy ??
    (evaluatedQuestions.length > 0
      ? (evaluatedQuestions.filter((q) => q.phases.evaluate.score === 1).length /
          evaluatedQuestions.length) *
        100
      : 0)

  // Find error from failed phases
  const runError = (() => {
    for (const q of allQuestions) {
      const phases = q.phases as Record<string, { status?: string; error?: string }>
      for (const phase of ["ingest", "indexing", "search", "answer", "evaluate"]) {
        if (phases[phase]?.status === "failed" && phases[phase]?.error) {
          return phases[phase].error
        }
      }
    }
    return null
  })()

  return (
    <div className="animate-fade-in">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-text-secondary mb-4">
        <Link href="/runs" className="hover:text-text-primary">
          Runs
        </Link>
        <span>/</span>
        <span className="text-text-primary font-mono">{runId}</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-display font-semibold text-text-primary flex items-center gap-3">
            {runId}
            <span className={cn("badge text-sm", getStatusColor(run.status))}>{run.status}</span>
            {(isRunning || isStopping) && (
              <button
                onClick={handleTerminate}
                disabled={terminating || isStopping}
                className={cn(
                  "px-3 py-1 text-sm rounded transition-colors cursor-pointer",
                  "bg-status-error/10 text-status-error hover:bg-status-error/20",
                  (terminating || isStopping) && "opacity-50 cursor-not-allowed"
                )}
              >
                {terminating || isStopping ? "Stopping..." : "Terminate"}
              </button>
            )}
            {canContinue && (
              <button
                onClick={handleContinue}
                disabled={continuing}
                className={cn(
                  "px-3 py-1 text-sm rounded transition-colors cursor-pointer",
                  "bg-accent/10 text-accent hover:bg-accent/20",
                  continuing && "opacity-50 cursor-not-allowed"
                )}
              >
                {continuing ? "Resuming..." : "Continue"}
              </button>
            )}
          </h1>
          <div className="flex items-center gap-4 mt-2 text-sm text-text-secondary">
            <span>
              <span className="text-text-muted">Provider:</span>{" "}
              <span className="capitalize">{run.provider}</span>
            </span>
            <span>
              <span className="text-text-muted">Benchmark:</span>{" "}
              <span className="capitalize">{run.benchmark}</span>
            </span>
            <span>
              <span className="text-text-muted">Judge:</span> {run.judge}
            </span>
            <span>
              <span className="text-text-muted">Created:</span> {formatDate(run.createdAt)}
            </span>
          </div>
        </div>
      </div>

      {/* Error Display */}
      {runError && (
        <div className="my-8 flex justify-center">
          <div className="max-w-xl w-full px-5 py-4 border border-border rounded">
            <p className="text-sm font-mono">
              <span className="text-status-error font-semibold">Error</span>
              <span className="text-text-secondary"> {runError}</span>
            </p>
          </div>
        </div>
      )}

      {/* Phase Progress */}
      <PhaseProgress summary={run.summary} />

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border mt-8 mb-6">
        {(["overview", "results"] as Tab[]).map((tab) => (
          <button
            key={tab}
            className={cn(
              "px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px cursor-pointer",
              activeTab === tab
                ? "text-accent border-accent"
                : "text-text-secondary border-transparent hover:text-text-primary"
            )}
            onClick={() => handleTabChange(tab)}
          >
            {tab === "overview" && "Overview"}
            {tab === "results" && `Results (${evaluatedQuestions.length})`}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === "overview" && (
        <div className="space-y-6">
          <StatsGrid
            cards={[
              {
                label: "accuracy",
                value: accuracy ? `${accuracy.toFixed(1)}%` : "—",
                subtext: report
                  ? `${report.summary.correctCount}/${report.summary.totalQuestions} correct`
                  : undefined,
              },
              {
                label: "questions",
                value: run.summary.total,
                subtext: `${run.summary.evaluated} evaluated`,
              },
              {
                label: "judge model",
                value: run.judge,
                mono: true,
              },
              {
                label: "answering model",
                value: run.answeringModel || "—",
                mono: true,
              },
            ]}
          />
          <AccuracyByType byQuestionType={report?.byQuestionType} />
          <LatencyTable latency={report?.latency} />
          <RetrievalMetrics retrieval={report?.retrieval} byQuestionType={report?.byQuestionType} />
        </div>
      )}

      {activeTab === "results" && <QuestionList runId={runId} questions={evaluatedQuestions} />}
    </div>
  )
}
