"use client"

import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import {
  getCompare,
  getCompareReport,
  stopCompare,
  resumeCompare,
  type CompareDetail,
  type CompareReport,
  type CompareRunInfo,
} from "@/lib/api"
import { formatDate, getStatusColor, cn } from "@/lib/utils"
import { AccuracyBarChart } from "@/components/accuracy-bar-chart"
import { DataTable, type Column } from "@/components/data-table"
import { CircularProgress } from "@/components/circular-progress"
import { EmptyState, DocumentIcon } from "@/components/empty-state"
import { Tooltip } from "@/components/tooltip"

const POLL_INTERVAL = 2000 // 2 seconds

export default function CompareDetailPage() {
  const params = useParams()
  const router = useRouter()
  const compareId = decodeURIComponent(params.compareId as string)
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null)

  const [compare, setCompare] = useState<CompareDetail | null>(null)
  const [report, setReport] = useState<CompareReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [stopping, setStopping] = useState(false)
  const [continuing, setContinuing] = useState(false)

  // Check if comparison is in progress
  const isRunning = compare?.status === "running" || compare?.status === "pending"
  const isStopping = compare?.status === "stopping"
  const isPartial = compare?.status === "partial"
  const isFailed = compare?.status === "failed"
  const canStop = isRunning || isStopping
  const canContinue = isPartial || isFailed

  // Table columns for runs
  const runColumns: Column<CompareRunInfo>[] = useMemo(
    () => [
      {
        key: "runId",
        header: "Run ID",
        render: (run) => <span className="font-mono text-accent">{run.runId}</span>,
      },
      {
        key: "provider",
        header: "Provider",
        render: (run) => <span className="capitalize">{run.provider}</span>,
      },
      {
        key: "status",
        header: "Status",
        render: (run) => {
          const runIsActive =
            run.status === "running" ||
            run.status === "pending" ||
            run.status === "initializing" ||
            run.status === "stopping"
          const p = run.progress
          const total = p?.total || 0
          const phasesCompleted =
            (p?.ingested || 0) +
            (p?.indexed || 0) +
            (p?.searched || 0) +
            (p?.answered || 0) +
            (p?.evaluated || 0)
          const totalPhases = 5 * total
          const progress = totalPhases > 0 ? phasesCompleted / totalPhases : 0

          const episodes = p?.indexingEpisodes
          const hasEpisodeData = episodes && episodes.total > 0

          let phasesFullyComplete = 0
          if ((p?.ingested || 0) === total && total > 0) phasesFullyComplete++
          if ((p?.indexed || 0) === total && total > 0) phasesFullyComplete++
          if ((p?.searched || 0) === total && total > 0) phasesFullyComplete++
          if ((p?.answered || 0) === total && total > 0) phasesFullyComplete++
          if ((p?.evaluated || 0) === total && total > 0) phasesFullyComplete++

          const progressContent = (
            <div className="flex items-center gap-2">
              {runIsActive && <CircularProgress progress={progress} size={18} strokeWidth={2} />}
              <span className={cn("badge", getStatusColor(run.status))}>{run.status}</span>
              {runIsActive && total > 0 && (
                <span className="text-text-muted text-xs font-mono">{phasesFullyComplete}/5</span>
              )}
            </div>
          )

          if (hasEpisodeData && runIsActive) {
            const episodeProgress =
              episodes.total > 0 ? (episodes.completed / episodes.total) * 100 : 0
            return (
              <Tooltip
                content={
                  <div className="min-w-[120px]">
                    <div className="font-medium mb-1.5">Episodes Indexed</div>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1.5 bg-bg-elevated">
                        <div
                          className="h-full bg-accent"
                          style={{ width: `${episodeProgress}%` }}
                        />
                      </div>
                      <span className="font-mono text-text-primary">
                        {episodes.completed}/{episodes.total}
                      </span>
                    </div>
                    {episodes.failed > 0 && (
                      <div className="text-status-error mt-1">{episodes.failed} failed</div>
                    )}
                  </div>
                }
              >
                {progressContent}
              </Tooltip>
            )
          }

          return progressContent
        },
      },
      {
        key: "accuracy",
        header: "Accuracy",
        align: "right",
        render: (run) => {
          const accuracyPct =
            run.accuracy !== null && run.accuracy !== undefined
              ? (run.accuracy * 100).toFixed(0)
              : null
          return accuracyPct ? (
            <span className="font-mono">{accuracyPct}%</span>
          ) : (
            <span className="text-text-muted">—</span>
          )
        },
      },
      {
        key: "date",
        header: "Date",
        render: () => (
          <span className="text-text-secondary text-sm">
            {compare ? formatDate(compare.createdAt) : "—"}
          </span>
        ),
      },
    ],
    [compare]
  )

  // Silent refresh (no loading state)
  const refreshData = useCallback(async () => {
    try {
      const [compareData, reportData] = await Promise.all([
        getCompare(compareId),
        getCompareReport(compareId).catch(() => null),
      ])
      setCompare(compareData)
      setReport(reportData)
      setError(null)
    } catch (e) {
      // Silent fail on poll
    }
  }, [compareId])

  // Initial load
  useEffect(() => {
    loadData()
  }, [compareId])

  // Polling when comparison is in progress
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
      const [compareData, reportData] = await Promise.all([
        getCompare(compareId),
        getCompareReport(compareId).catch(() => null),
      ])
      setCompare(compareData)
      setReport(reportData)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load comparison")
    } finally {
      setLoading(false)
    }
  }

  async function handleStop() {
    if (stopping) return
    setStopping(true)
    try {
      await stopCompare(compareId)
      await refreshData()
    } catch (e) {
      console.error("Failed to stop:", e)
    } finally {
      setStopping(false)
    }
  }

  async function handleContinue() {
    if (continuing) return
    setContinuing(true)
    try {
      await resumeCompare(compareId)
      await refreshData()
    } catch (e) {
      console.error("Failed to continue:", e)
    } finally {
      setContinuing(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (error || !compare) {
    return (
      <div className="text-center py-12">
        <p className="text-status-error">{error || "Comparison not found"}</p>
        <Link href="/compare" className="btn btn-secondary mt-4">
          Back to comparisons
        </Link>
      </div>
    )
  }

  return (
    <div className="animate-fade-in">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-text-secondary mb-4">
        <Link href="/compare" className="hover:text-text-primary">
          Comparisons
        </Link>
        <span>/</span>
        <span className="text-text-primary font-mono">{compareId}</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-display font-semibold text-text-primary flex items-center gap-3">
            {compareId}
            <span className={cn("badge text-sm", getStatusColor(compare.status))}>
              {compare.status}
            </span>
            {canStop && (
              <button
                onClick={handleStop}
                disabled={stopping || isStopping}
                className={cn(
                  "px-3 py-1 text-sm rounded transition-colors cursor-pointer",
                  "bg-status-error/10 text-status-error hover:bg-status-error/20",
                  (stopping || isStopping) && "opacity-50 cursor-not-allowed"
                )}
              >
                {stopping || isStopping ? "Stopping..." : "Terminate"}
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
          <div className="flex items-center gap-4 mt-2 text-sm text-text-secondary flex-wrap">
            <div className="flex items-center gap-2">
              <span className="text-text-muted">Providers:</span>
              <div className="flex gap-2">
                {(compare.providers || compare.runs?.map((r) => r.provider) || []).map(
                  (provider) => (
                    <span
                      key={provider}
                      className="badge text-xs bg-accent/10 text-accent capitalize"
                    >
                      {provider}
                    </span>
                  )
                )}
              </div>
            </div>
            <span>
              <span className="text-text-muted">Benchmark:</span>{" "}
              <span className="capitalize">{compare.benchmark}</span>
            </span>
            <span>
              <span className="text-text-muted">Judge:</span> {compare.judge}
            </span>
            <span>
              <span className="text-text-muted">Created:</span> {formatDate(compare.createdAt)}
            </span>
          </div>

          {/* Run IDs - clickable links to individual runs */}
          {compare.runs && compare.runs.length > 0 && (
            <div className="flex gap-3 mt-3 flex-wrap">
              {compare.runs.map((run) => (
                <Link
                  key={run.runId}
                  href={`/runs/${encodeURIComponent(run.runId)}`}
                  target="_blank"
                  className="group flex flex-col items-start px-3 py-2 border border-border rounded hover:border-text-secondary transition-colors"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-xs text-accent group-hover:underline">
                      {run.runId.length > 16 ? `${run.runId.slice(0, 16)}...` : run.runId}
                    </span>
                    <svg
                      className="w-3 h-3 text-border group-hover:text-text-secondary transition-colors"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M4.5 19.5l15-15m0 0H8.25m11.25 0v11.25"
                      />
                    </svg>
                  </div>
                  <span className="text-[10px] text-text-muted capitalize mt-0.5">
                    {run.provider}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>

      {compare.runs && compare.runs.length > 0 && compare.status !== "completed" && (
        <div className="mb-8">
          <h2 className="text-lg font-medium text-text-primary mb-4">Runs</h2>
          <DataTable
            columns={runColumns}
            data={compare.runs}
            onRowClick={(run) => router.push(`/runs/${encodeURIComponent(run.runId)}`)}
            getRowKey={(run) => run.runId}
            connectToFilterBar={false}
          />
        </div>
      )}

      {/* Comparison Tables (when reports available) */}
      {report && report.reports.length > 0 && (
        <div className="space-y-8">
          {/* Overall Accuracy Table */}
          {/* Accuracy and Latency side by side */}
          <div className="flex gap-6">
            {/* Overall Accuracy - 35% width */}
            <div className="w-[35%]">
              <h3 className="text-sm font-medium text-text-primary font-display mb-3">Accuracy</h3>
              <div className="card">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left py-2 px-3 text-text-muted font-medium uppercase text-xs">
                        Provider
                      </th>
                      <th className="text-right py-2 px-3 text-text-muted font-medium uppercase text-xs">
                        Score
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      const rows = report.reports.map((r) => ({
                        provider: r.provider,
                        correct: r.report.summary?.correctCount ?? r.report.correctCount,
                        total: r.report.summary?.totalQuestions ?? r.report.totalQuestions,
                        accuracy: r.report.summary?.accuracy ?? r.report.accuracy,
                      }))
                      const validAccuracies = rows
                        .map((r) => r.accuracy)
                        .filter((a): a is number => a != null)
                      const bestAccuracy =
                        validAccuracies.length > 0 ? Math.max(...validAccuracies) : null
                      // Only highlight the FIRST occurrence of the best value
                      const firstBestIndex =
                        bestAccuracy != null
                          ? rows.findIndex((r) => r.accuracy === bestAccuracy)
                          : -1

                      return rows.map((row, index) => {
                        const isBest = index === firstBestIndex
                        return (
                          <tr key={row.provider} className="border-b border-border/50">
                            <td className="py-2 px-3 text-text-primary capitalize">
                              {row.provider}
                            </td>
                            <td className="py-2 px-3 text-right font-mono">
                              <span
                                className={
                                  isBest ? "text-status-success font-semibold" : "text-text-primary"
                                }
                              >
                                {row.accuracy != null ? `${(row.accuracy * 100).toFixed(1)}%` : "—"}
                              </span>
                              {row.correct != null && row.total != null && (
                                <span className="ml-2 text-text-muted text-xs">
                                  ({row.correct}/{row.total})
                                </span>
                              )}
                            </td>
                          </tr>
                        )
                      })
                    })()}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Latency - 65% width */}
            {report.reports.some((r) => r.report.latency || r.report.latencyStats) && (
              <div className="w-[65%]">
                <h3 className="text-sm font-medium text-text-primary font-display mb-3">
                  Latency (median ms)
                </h3>
                <div className="card">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border">
                          <th className="text-left py-2 px-3 text-text-muted font-medium uppercase text-xs">
                            Provider
                          </th>
                          <th className="text-right py-2 px-3 text-text-muted font-medium uppercase text-xs">
                            Ingest
                          </th>
                          <th className="text-right py-2 px-3 text-text-muted font-medium uppercase text-xs">
                            Index
                          </th>
                          <th className="text-right py-2 px-3 text-text-muted font-medium uppercase text-xs">
                            Search
                          </th>
                          <th className="text-right py-2 px-3 text-text-muted font-medium uppercase text-xs">
                            Answer
                          </th>
                          <th className="text-right py-2 px-3 text-text-muted font-medium uppercase text-xs">
                            Evaluate
                          </th>
                          <th className="text-right py-2 px-3 text-text-muted font-medium uppercase text-xs">
                            Total
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {(() => {
                          const phases = [
                            "ingest",
                            "indexing",
                            "search",
                            "answer",
                            "evaluate",
                            "total",
                          ] as const
                          const rows = report.reports
                            .filter((r) => r.report.latency || r.report.latencyStats)
                            .map((r) => ({
                              provider: r.provider,
                              latency: (r.report.latency || r.report.latencyStats)!,
                            }))

                          // Find best (lowest) for each phase and the FIRST index with that value
                          const bestByPhase = phases.reduce(
                            (acc, phase) => {
                              const values = rows.map((r) => r.latency[phase]?.median)
                              const validValues = values.filter(
                                (v) => v !== undefined && v !== null
                              ) as number[]
                              const bestValue =
                                validValues.length > 0 ? Math.min(...validValues) : Infinity
                              const firstBestIndex = values.findIndex((v) => v === bestValue)
                              acc[phase] = { value: bestValue, firstIndex: firstBestIndex }
                              return acc
                            },
                            {} as Record<string, { value: number; firstIndex: number }>
                          )

                          return rows.map((row, rowIndex) => (
                            <tr key={row.provider} className="border-b border-border/50">
                              <td className="py-2 px-3 text-text-primary capitalize">
                                {row.provider}
                              </td>
                              {phases.map((phase) => {
                                const value = row.latency[phase]?.median
                                // Only highlight the FIRST occurrence of the best value
                                const isBest = rowIndex === bestByPhase[phase].firstIndex
                                return (
                                  <td key={phase} className="py-2 px-3 text-right font-mono">
                                    {value !== undefined ? (
                                      <span
                                        className={
                                          isBest
                                            ? "text-white font-semibold"
                                            : "text-text-secondary"
                                        }
                                      >
                                        {value.toFixed(0)}
                                      </span>
                                    ) : (
                                      <span className="text-text-muted">—</span>
                                    )}
                                  </td>
                                )
                              })}
                            </tr>
                          ))
                        })()}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Retrieval Metrics Table */}
          {report.reports.some((r) => r.report.retrieval) && (
            <div>
              <h3 className="text-sm font-medium text-text-primary font-display mb-3">
                Retrieval Metrics
              </h3>
              <div className="card overflow-x-auto">
                <table className="w-full text-sm table-fixed">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="w-[14.28%] text-left py-2 px-3 text-text-muted font-medium uppercase text-xs">
                        Provider
                      </th>
                      <th className="w-[14.28%] text-right py-2 px-3 text-text-muted font-medium uppercase text-xs">
                        Hit@K
                      </th>
                      <th className="w-[14.28%] text-right py-2 px-3 text-text-muted font-medium uppercase text-xs">
                        Precision
                      </th>
                      <th className="w-[14.28%] text-right py-2 px-3 text-text-muted font-medium uppercase text-xs">
                        Recall
                      </th>
                      <th className="w-[14.28%] text-right py-2 px-3 text-text-muted font-medium uppercase text-xs">
                        F1
                      </th>
                      <th className="w-[14.28%] text-right py-2 px-3 text-text-muted font-medium uppercase text-xs">
                        MRR
                      </th>
                      <th className="w-[14.28%] text-right py-2 px-3 text-text-muted font-medium uppercase text-xs">
                        NDCG
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      const rows = report.reports
                        .filter((r) => r.report.retrieval)
                        .map((r) => ({
                          provider: r.provider,
                          retrieval: r.report.retrieval!,
                        }))

                      if (rows.length === 0) {
                        return (
                          <tr>
                            <td colSpan={7} className="py-4 px-3 text-center text-text-secondary">
                              Retrieval metrics not available
                            </td>
                          </tr>
                        )
                      }

                      // Find best values and FIRST index for each metric
                      const metrics = [
                        "hitAtK",
                        "precisionAtK",
                        "recallAtK",
                        "f1AtK",
                        "mrr",
                        "ndcg",
                      ] as const
                      const bestByMetric = metrics.reduce(
                        (acc, metric) => {
                          const values = rows.map((r) => r.retrieval[metric])
                          const bestValue = Math.max(...values)
                          const firstBestIndex = values.findIndex((v) => v === bestValue)
                          acc[metric] = { value: bestValue, firstIndex: firstBestIndex }
                          return acc
                        },
                        {} as Record<string, { value: number; firstIndex: number }>
                      )

                      return rows.map((row, rowIndex) => (
                        <tr key={row.provider} className="border-b border-border/50">
                          <td className="py-2 px-3 text-text-primary capitalize">{row.provider}</td>
                          <td className="py-2 px-3 text-right font-mono">
                            <span
                              className={
                                rowIndex === bestByMetric.hitAtK.firstIndex
                                  ? "text-white font-semibold"
                                  : "text-text-secondary"
                              }
                            >
                              {(row.retrieval.hitAtK * 100).toFixed(0)}%
                            </span>
                          </td>
                          <td className="py-2 px-3 text-right font-mono">
                            <span
                              className={
                                rowIndex === bestByMetric.precisionAtK.firstIndex
                                  ? "text-white font-semibold"
                                  : "text-text-secondary"
                              }
                            >
                              {(row.retrieval.precisionAtK * 100).toFixed(0)}%
                            </span>
                          </td>
                          <td className="py-2 px-3 text-right font-mono">
                            <span
                              className={
                                rowIndex === bestByMetric.recallAtK.firstIndex
                                  ? "text-white font-semibold"
                                  : "text-text-secondary"
                              }
                            >
                              {(row.retrieval.recallAtK * 100).toFixed(0)}%
                            </span>
                          </td>
                          <td className="py-2 px-3 text-right font-mono">
                            <span
                              className={
                                rowIndex === bestByMetric.f1AtK.firstIndex
                                  ? "text-white font-semibold"
                                  : "text-text-secondary"
                              }
                            >
                              {(row.retrieval.f1AtK * 100).toFixed(0)}%
                            </span>
                          </td>
                          <td className="py-2 px-3 text-right font-mono">
                            <span
                              className={
                                rowIndex === bestByMetric.mrr.firstIndex
                                  ? "text-white font-semibold"
                                  : "text-text-secondary"
                              }
                            >
                              {row.retrieval.mrr.toFixed(2)}
                            </span>
                          </td>
                          <td className="py-2 px-3 text-right font-mono">
                            <span
                              className={
                                rowIndex === bestByMetric.ndcg.firstIndex
                                  ? "text-white font-semibold"
                                  : "text-text-secondary"
                              }
                            >
                              {row.retrieval.ndcg.toFixed(2)}
                            </span>
                          </td>
                        </tr>
                      ))
                    })()}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* By Question Type - Table and Chart */}
          {report.reports.some(
            (r) => r.report.byQuestionType && Object.keys(r.report.byQuestionType).length > 0
          ) && (
            <div>
              <h3 className="text-sm font-medium text-text-primary font-display mb-3">
                Accuracy by Question Type
              </h3>
              <div className="flex gap-8 items-stretch" style={{ minHeight: 420 }}>
                {/* Left: Table (50%) */}
                <div className="w-[50%] flex flex-col">
                  <div className="flex-1 overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border">
                          <th className="text-left py-4 px-4 text-text-muted font-medium text-xs">
                            Categories
                          </th>
                          {report.reports.map((r) => (
                            <th
                              key={r.provider}
                              className="text-right py-4 px-4 text-text-muted font-medium text-xs capitalize"
                            >
                              {r.provider}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {(() => {
                          // Collect all question types
                          const allTypes = new Set<string>()
                          report.reports.forEach((r) => {
                            if (r.report.byQuestionType) {
                              Object.keys(r.report.byQuestionType).forEach((type) =>
                                allTypes.add(type)
                              )
                            }
                          })

                          const rows = Array.from(allTypes)
                            .sort()
                            .map((type) => {
                              const values = report.reports.map((r) => ({
                                provider: r.provider,
                                accuracy: r.report.byQuestionType?.[type]?.accuracy,
                              }))

                              const validValues = values
                                .map((v) => v.accuracy)
                                .filter((a) => a !== undefined) as number[]
                              const bestAccuracy =
                                validValues.length > 0 ? Math.max(...validValues) : undefined

                              // Find the index of the FIRST best value (for tie-breaking)
                              const firstBestIndex =
                                bestAccuracy !== undefined
                                  ? values.findIndex((v) => v.accuracy === bestAccuracy)
                                  : -1

                              return (
                                <tr key={type} className="border-b border-border/30">
                                  <td className="py-4 px-4 text-text-secondary">
                                    {type.replace(/[-_]/g, "-")}
                                  </td>
                                  {values.map(({ provider, accuracy }, index) => {
                                    // Only highlight the FIRST occurrence of the best value
                                    const isBest = index === firstBestIndex
                                    return (
                                      <td key={provider} className="py-4 px-4 text-right font-mono">
                                        {accuracy !== undefined ? (
                                          <span
                                            className={
                                              isBest
                                                ? "text-white font-semibold"
                                                : "text-text-secondary"
                                            }
                                          >
                                            {(accuracy * 100).toFixed(1)}%
                                          </span>
                                        ) : (
                                          <span className="text-text-muted">—</span>
                                        )}
                                      </td>
                                    )
                                  })}
                                </tr>
                              )
                            })

                          // Calculate overall accuracy for each provider
                          const overallValues = report.reports.map((r) => {
                            const accuracy = r.report.summary?.accuracy ?? r.report.accuracy
                            return {
                              provider: r.provider,
                              accuracy,
                            }
                          })

                          const validOverall = overallValues
                            .map((v) => v.accuracy)
                            .filter((a) => a !== undefined) as number[]
                          const bestOverall =
                            validOverall.length > 0 ? Math.max(...validOverall) : undefined
                          const firstBestOverallIndex =
                            bestOverall !== undefined
                              ? overallValues.findIndex((v) => v.accuracy === bestOverall)
                              : -1

                          return (
                            <>
                              {rows}
                              {/* Overall row */}
                              <tr className="border-t-2 border-border">
                                <td className="py-4 px-4 text-text-primary font-semibold">
                                  Overall
                                </td>
                                {overallValues.map(({ provider, accuracy }, index) => {
                                  const isBest = index === firstBestOverallIndex
                                  return (
                                    <td key={provider} className="py-4 px-4 text-right font-mono">
                                      {accuracy !== undefined ? (
                                        <span
                                          className={
                                            isBest
                                              ? "text-white font-semibold"
                                              : "text-text-secondary"
                                          }
                                        >
                                          {(accuracy * 100).toFixed(1)}%
                                        </span>
                                      ) : (
                                        <span className="text-text-muted">—</span>
                                      )}
                                    </td>
                                  )
                                })}
                              </tr>
                            </>
                          )
                        })()}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Right: Bar Chart (50%) */}
                <div className="w-[50%] flex flex-col">
                  {(() => {
                    // Prepare data for chart
                    const allTypes = new Set<string>()
                    report.reports.forEach((r) => {
                      if (r.report.byQuestionType) {
                        Object.keys(r.report.byQuestionType).forEach((type) => allTypes.add(type))
                      }
                    })

                    const chartData = Array.from(allTypes)
                      .sort()
                      .map((type) => ({
                        type,
                        values: report.reports.map((r) => ({
                          provider: r.provider,
                          accuracy: r.report.byQuestionType?.[type]?.accuracy,
                        })),
                      }))

                    const providers = report.reports.map((r) => r.provider)

                    return <AccuracyBarChart data={chartData} providers={providers} />
                  })()}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Empty state when no reports yet */}
      {!report && !isRunning && (
        <EmptyState
          icon={<DocumentIcon />}
          title="No comparison results yet"
          description="Results will appear here once the comparison runs complete."
        />
      )}
    </div>
  )
}
