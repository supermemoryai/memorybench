"use client"

import { useState, useEffect, useMemo, useRef, useCallback } from "react"
import Link from "next/link"
import { getCompares, deleteCompare, type CompareSummary } from "@/lib/api"
import { formatDate, getStatusColor, cn } from "@/lib/utils"
import { FilterBar } from "@/components/filter-bar"
import { DataTable, type Column } from "@/components/data-table"
import { CompareActionsMenu } from "@/components/compare-actions-menu"
import { CircularProgress } from "@/components/circular-progress"
import { EmptyState, ChartIcon } from "@/components/empty-state"

const POLL_INTERVAL = 2000 // 2 seconds

export default function ComparesPage() {
  const [compares, setCompares] = useState<CompareSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null)

  // Filters
  const [search, setSearch] = useState("")
  const [selectedBenchmarks, setSelectedBenchmarks] = useState<string[]>([])
  const [selectedStatuses, setSelectedStatuses] = useState<string[]>([])

  // Check if any comparison is in progress
  const hasRunningCompares = useMemo(() => {
    return compares.some((c) => c.status === "running" || c.status === "pending")
  }, [compares])

  // Silent refresh (no loading state)
  const refreshCompares = useCallback(async () => {
    try {
      const data = await getCompares()
      setCompares(data)
      setError(null)
    } catch (e) {
      // Silent fail on poll
    }
  }, [])

  // Initial load
  useEffect(() => {
    loadCompares()
  }, [])

  // Polling when comparisons are in progress
  useEffect(() => {
    if (hasRunningCompares) {
      pollIntervalRef.current = setInterval(refreshCompares, POLL_INTERVAL)
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
  }, [hasRunningCompares, refreshCompares])

  async function loadCompares() {
    try {
      setLoading(true)
      const data = await getCompares()
      setCompares(data)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load comparisons")
    } finally {
      setLoading(false)
    }
  }

  async function handleDelete(compareId: string) {
    if (!confirm(`Delete comparison "${compareId}"? This cannot be undone.`)) return

    try {
      await deleteCompare(compareId)
      setCompares((prev) => prev.filter((c) => c.compareId !== compareId))
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to delete comparison")
    }
  }

  // Get unique values for filter options
  const benchmarks = useMemo(() => {
    const counts: Record<string, number> = {}
    compares.forEach((c) => {
      counts[c.benchmark] = (counts[c.benchmark] || 0) + 1
    })
    return Object.entries(counts).map(([value, count]) => ({
      value,
      label: value,
      count,
    }))
  }, [compares])

  const statuses = useMemo(() => {
    const counts: Record<string, number> = {}
    compares.forEach((c) => {
      counts[c.status] = (counts[c.status] || 0) + 1
    })
    return Object.entries(counts).map(([value, count]) => ({
      value,
      label: value,
      count,
    }))
  }, [compares])

  // Filter comparisons
  const filteredCompares = useMemo(() => {
    return compares.filter((compare) => {
      // Search filter
      if (search) {
        const searchLower = search.toLowerCase()
        const matchesSearch =
          compare.compareId.toLowerCase().includes(searchLower) ||
          compare.providers.some((p) => p.toLowerCase().includes(searchLower)) ||
          compare.benchmark.toLowerCase().includes(searchLower)
        if (!matchesSearch) return false
      }

      // Benchmark filter
      if (selectedBenchmarks.length > 0 && !selectedBenchmarks.includes(compare.benchmark)) {
        return false
      }

      // Status filter
      if (selectedStatuses.length > 0 && !selectedStatuses.includes(compare.status)) {
        return false
      }

      return true
    })
  }, [compares, search, selectedBenchmarks, selectedStatuses])

  // Build columns
  const columns: Column<CompareSummary>[] = useMemo(
    () => [
      {
        key: "compareId",
        header: "Compare ID",
        render: (compare) => (
          <Link
            href={`/compare/${encodeURIComponent(compare.compareId)}`}
            className="font-mono text-accent hover:underline cursor-pointer"
          >
            {compare.compareId}
          </Link>
        ),
      },
      {
        key: "providers",
        header: "Providers",
        render: (compare) => (
          <div className="flex flex-wrap gap-1.5">
            {compare.providers.map((provider, idx) => (
              <span
                key={idx}
                className="inline-flex items-center px-2 py-0.5 text-xs font-medium bg-[#222222] text-text-secondary font-display rounded-sm"
              >
                {provider}
              </span>
            ))}
          </div>
        ),
      },
      {
        key: "benchmark",
        header: "Benchmark",
        render: (compare) => <span className="capitalize">{compare.benchmark}</span>,
      },
      {
        key: "status",
        header: "Status",
        render: (compare) => {
          const isRunning = compare.status === "running" || compare.status === "pending"

          // Calculate overall progress from all runs
          let progress = 0
          let phasesFullyComplete = 0
          if (compare.runProgress && compare.runProgress.length > 0) {
            let totalPhasesCompleted = 0
            let totalPhases = 0
            let allRunsPhasesComplete = 0

            for (const run of compare.runProgress) {
              const p = run.progress
              const total = p?.total || 0
              if (total > 0) {
                totalPhasesCompleted +=
                  (p.ingested || 0) +
                  (p.indexed || 0) +
                  (p.searched || 0) +
                  (p.answered || 0) +
                  (p.evaluated || 0)
                totalPhases += 5 * total

                // Count fully complete phases for this run
                let runPhasesComplete = 0
                if (p.ingested === total) runPhasesComplete++
                if (p.indexed === total) runPhasesComplete++
                if (p.searched === total) runPhasesComplete++
                if (p.answered === total) runPhasesComplete++
                if (p.evaluated === total) runPhasesComplete++
                allRunsPhasesComplete += runPhasesComplete
              }
            }

            progress = totalPhases > 0 ? totalPhasesCompleted / totalPhases : 0
            // Average phases complete across all runs
            phasesFullyComplete =
              compare.runProgress.length > 0
                ? Math.floor(allRunsPhasesComplete / compare.runProgress.length)
                : 0
          }

          return (
            <div className="flex items-center gap-2">
              {isRunning && <CircularProgress progress={progress} size={18} strokeWidth={2} />}
              <span className={cn("badge", getStatusColor(compare.status))}>{compare.status}</span>
              {isRunning && compare.runProgress && compare.runProgress.length > 0 && (
                <span className="text-text-muted text-xs font-mono">{phasesFullyComplete}/5</span>
              )}
            </div>
          )
        },
      },
      {
        key: "date",
        header: "Date",
        render: (compare) => (
          <span className="text-text-secondary text-sm">{formatDate(compare.createdAt)}</span>
        ),
      },
      {
        key: "actions",
        header: "",
        width: "40px",
        align: "right",
        render: (compare) => (
          <CompareActionsMenu
            compareId={compare.compareId}
            onDelete={() => handleDelete(compare.compareId)}
          />
        ),
      },
    ],
    []
  )

  const clearFilters = () => {
    setSearch("")
    setSelectedBenchmarks([])
    setSelectedStatuses([])
  }

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-display font-semibold text-text-primary">Comparisons</h1>
      </div>

      {/* Filter Bar */}
      {!loading && compares.length > 0 && (
        <div className="mb-0">
          <FilterBar
            totalCount={compares.length}
            filteredCount={filteredCompares.length}
            searchValue={search}
            onSearchChange={setSearch}
            searchPlaceholder="Search comparisons..."
            filters={[
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
          <p className="text-text-secondary mt-3">Loading comparisons...</p>
        </div>
      ) : error ? (
        <div className="py-12 text-center">
          <p className="text-status-error">{error}</p>
          <button className="btn btn-secondary mt-3" onClick={loadCompares}>
            Retry
          </button>
        </div>
      ) : compares.length === 0 ? (
        <EmptyState
          icon={<ChartIcon />}
          title="No comparisons yet"
          description="Click the Compare button on the left panel to compare multiple providers against the same benchmark."
        />
      ) : (
        <DataTable
          columns={columns}
          data={filteredCompares}
          emptyMessage="No comparisons match your filters"
          getRowKey={(compare) => compare.compareId}
        />
      )}
    </div>
  )
}
