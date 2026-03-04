"use client"

import { useState, useEffect, useMemo, useRef, useCallback } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { getRuns, deleteRun, stopRun, startRun, addToLeaderboard, type RunSummary } from "@/lib/api"
import { formatDate, getStatusColor, cn } from "@/lib/utils"
import { FilterBar } from "@/components/filter-bar"
import { DataTable, type Column } from "@/components/data-table"
import { RunActionsMenu } from "@/components/run-actions-menu"
import { CircularProgress } from "@/components/circular-progress"
import { EmptyState, ListIcon } from "@/components/empty-state"

const POLL_INTERVAL = 2000 // 2 seconds

export default function RunsPage() {
  const router = useRouter()
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null)

  // Filters
  const [search, setSearch] = useState("")
  const [selectedProviders, setSelectedProviders] = useState<string[]>([])
  const [selectedBenchmarks, setSelectedBenchmarks] = useState<string[]>([])
  const [selectedStatuses, setSelectedStatuses] = useState<string[]>([])

  // Check if any run is in progress
  const hasRunningRuns = useMemo(() => {
    return runs.some(
      (r) => r.status === "running" || r.status === "pending" || r.status === "initializing"
    )
  }, [runs])

  // Silent refresh (no loading state)
  const refreshRuns = useCallback(async () => {
    try {
      const data = await getRuns()
      setRuns(data)
      setError(null)
    } catch (e) {
      // Silent fail on poll
    }
  }, [])

  // Initial load
  useEffect(() => {
    loadRuns()
  }, [])

  // Polling when runs are in progress
  useEffect(() => {
    if (hasRunningRuns) {
      pollIntervalRef.current = setInterval(refreshRuns, POLL_INTERVAL)
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
  }, [hasRunningRuns, refreshRuns])

  async function loadRuns() {
    try {
      setLoading(true)
      const data = await getRuns()
      setRuns(data)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load runs")
    } finally {
      setLoading(false)
    }
  }

  async function handleDelete(runId: string) {
    if (!confirm(`Delete run "${runId}"? This cannot be undone.`)) return

    try {
      await deleteRun(runId)
      setRuns((prev) => prev.filter((r) => r.runId !== runId))
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to delete run")
    }
  }

  async function handleTerminate(runId: string) {
    try {
      await stopRun(runId)
      await refreshRuns()
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to terminate run")
    }
  }

  async function handleAddToLeaderboard(runId: string, data: { version?: string; notes?: string }) {
    await addToLeaderboard(runId, data)
    router.push("/leaderboard")
  }

  async function handleContinue(run: RunSummary) {
    try {
      await startRun({
        provider: run.provider,
        benchmark: run.benchmark,
        runId: run.runId,
        judgeModel: run.judge,
        answeringModel: run.answeringModel,
      })
      await refreshRuns()
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to continue run")
    }
  }

  // Get unique values for filter options
  const providers = useMemo(() => {
    const counts: Record<string, number> = {}
    runs.forEach((r) => {
      counts[r.provider] = (counts[r.provider] || 0) + 1
    })
    return Object.entries(counts).map(([value, count]) => ({
      value,
      label: value,
      count,
    }))
  }, [runs])

  const benchmarks = useMemo(() => {
    const counts: Record<string, number> = {}
    runs.forEach((r) => {
      counts[r.benchmark] = (counts[r.benchmark] || 0) + 1
    })
    return Object.entries(counts).map(([value, count]) => ({
      value,
      label: value,
      count,
    }))
  }, [runs])

  const statuses = useMemo(() => {
    const counts: Record<string, number> = {}
    runs.forEach((r) => {
      counts[r.status] = (counts[r.status] || 0) + 1
    })
    return Object.entries(counts).map(([value, count]) => ({
      value,
      label: value,
      count,
    }))
  }, [runs])

  // Filter runs
  const filteredRuns = useMemo(() => {
    return runs.filter((run) => {
      // Search filter
      if (search) {
        const searchLower = search.toLowerCase()
        const matchesSearch =
          run.runId.toLowerCase().includes(searchLower) ||
          run.provider.toLowerCase().includes(searchLower) ||
          run.benchmark.toLowerCase().includes(searchLower)
        if (!matchesSearch) return false
      }

      // Provider filter
      if (selectedProviders.length > 0 && !selectedProviders.includes(run.provider)) {
        return false
      }

      // Benchmark filter
      if (selectedBenchmarks.length > 0 && !selectedBenchmarks.includes(run.benchmark)) {
        return false
      }

      // Status filter
      if (selectedStatuses.length > 0 && !selectedStatuses.includes(run.status)) {
        return false
      }

      return true
    })
  }, [runs, search, selectedProviders, selectedBenchmarks, selectedStatuses])

  // Build columns
  const columns: Column<RunSummary>[] = useMemo(
    () => [
      {
        key: "runId",
        header: "Run ID",
        render: (run) => (
          <Link
            href={`/runs/${encodeURIComponent(run.runId)}`}
            className="font-mono text-accent hover:underline cursor-pointer"
          >
            {run.runId}
          </Link>
        ),
      },
      {
        key: "provider",
        header: "Provider",
        render: (run) => <span className="capitalize">{run.provider}</span>,
      },
      {
        key: "benchmark",
        header: "Benchmark",
        render: (run) => <span className="capitalize">{run.benchmark}</span>,
      },
      {
        key: "status",
        header: "Status",
        render: (run) => {
          const isRunning =
            run.status === "running" ||
            run.status === "pending" ||
            run.status === "initializing" ||
            run.status === "stopping"
          const s = run.summary
          const phasesCompleted = s.ingested + s.indexed + s.searched + s.answered + s.evaluated
          const totalPhases = 5 * s.total
          const progress = totalPhases > 0 ? phasesCompleted / totalPhases : 0

          let phasesFullyComplete = 0
          if (s.ingested === s.total) phasesFullyComplete++
          if (s.indexed === s.total) phasesFullyComplete++
          if (s.searched === s.total) phasesFullyComplete++
          if (s.answered === s.total) phasesFullyComplete++
          if (s.evaluated === s.total) phasesFullyComplete++

          return (
            <div className="flex items-center gap-2">
              {isRunning && <CircularProgress progress={progress} size={18} strokeWidth={2} />}
              <span className={cn("badge", getStatusColor(run.status))}>{run.status}</span>
              {isRunning && s.total > 0 && (
                <span className="text-text-muted text-xs font-mono">{phasesFullyComplete}/5</span>
              )}
            </div>
          )
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
        render: (run) => (
          <span className="text-text-secondary text-sm">{formatDate(run.createdAt)}</span>
        ),
      },
      {
        key: "actions",
        header: "",
        width: "40px",
        align: "right",
        render: (run) => (
          <RunActionsMenu
            runId={run.runId}
            provider={run.provider}
            benchmark={run.benchmark}
            status={run.status}
            onAddToLeaderboard={(data) => handleAddToLeaderboard(run.runId, data)}
            onDelete={() => handleDelete(run.runId)}
            onTerminate={() => handleTerminate(run.runId)}
            onContinue={() => handleContinue(run)}
          />
        ),
      },
    ],
    []
  )

  const clearFilters = () => {
    setSearch("")
    setSelectedProviders([])
    setSelectedBenchmarks([])
    setSelectedStatuses([])
  }

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-display font-semibold text-text-primary">Runs</h1>
      </div>

      {/* Filter Bar */}
      {!loading && runs.length > 0 && (
        <div className="mb-0">
          <FilterBar
            totalCount={runs.length}
            filteredCount={filteredRuns.length}
            searchValue={search}
            onSearchChange={setSearch}
            searchPlaceholder="Search runs..."
            filters={[
              {
                key: "providers",
                label: "Select providers",
                options: providers,
                selected: selectedProviders,
                onChange: setSelectedProviders,
              },
              {
                key: "benchmarks",
                label: "Select benchmarks",
                options: benchmarks,
                selected: selectedBenchmarks,
                onChange: setSelectedBenchmarks,
              },
              {
                key: "statuses",
                label: "Select status",
                options: statuses,
                selected: selectedStatuses,
                onChange: setSelectedStatuses,
              },
            ]}
            onClearAll={clearFilters}
          />
        </div>
      )}

      {/* Content */}
      {loading ? (
        <div className="py-12 text-center">
          <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-text-secondary mt-3">Loading runs...</p>
        </div>
      ) : error ? (
        <div className="py-12 text-center">
          <p className="text-status-error">{error}</p>
          <button className="btn btn-secondary mt-3" onClick={loadRuns}>
            Retry
          </button>
        </div>
      ) : runs.length === 0 ? (
        <EmptyState
          icon={<ListIcon />}
          title="No runs yet"
          action={
            <Link
              href="/runs/new"
              className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium transition-all font-display tracking-tight text-white border border-transparent hover:border-white/30"
              style={{
                background: "linear-gradient(135deg, rgb(38, 123, 241) 40%, rgb(21, 70, 139) 100%)",
                boxShadow:
                  "rgba(255, 255, 255, 0.25) 2px 2px 8px 0px inset, rgba(0, 0, 0, 0.15) -2px -2px 7px 0px inset",
              }}
            >
              <span className="text-lg leading-none">+</span>
              <span>New Run</span>
            </Link>
          }
        />
      ) : (
        <DataTable
          columns={columns}
          data={filteredRuns}
          emptyMessage="No runs match your filters"
          getRowKey={(run) => run.runId}
        />
      )}
    </div>
  )
}
