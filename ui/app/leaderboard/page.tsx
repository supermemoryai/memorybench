"use client"

import { useState, useEffect, useMemo } from "react"
import Link from "next/link"
import { getLeaderboard, removeFromLeaderboard, type LeaderboardEntry } from "@/lib/api"
import { FilterBar } from "@/components/filter-bar"
import { DataTable, type Column } from "@/components/data-table"
import { DropdownMenu } from "@/components/dropdown-menu"
import { EmptyState, TrophyIcon } from "@/components/empty-state"

export default function LeaderboardPage() {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Filters
  const [search, setSearch] = useState("")
  const [selectedProviders, setSelectedProviders] = useState<string[]>([])
  const [selectedBenchmarks, setSelectedBenchmarks] = useState<string[]>([])

  useEffect(() => {
    loadLeaderboard()
  }, [])

  async function loadLeaderboard() {
    try {
      setLoading(true)
      const data = await getLeaderboard()
      setEntries(data.entries)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load leaderboard")
    } finally {
      setLoading(false)
    }
  }

  async function handleRemove(id: number) {
    if (!confirm("Remove this entry from the leaderboard?")) return

    try {
      await removeFromLeaderboard(id)
      setEntries(entries.filter((e) => e.id !== id))
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to remove entry")
    }
  }

  // Get unique providers and benchmarks for filter options
  const providers = useMemo(() => {
    const counts: Record<string, number> = {}
    entries.forEach((e) => {
      counts[e.provider] = (counts[e.provider] || 0) + 1
    })
    return Object.entries(counts).map(([value, count]) => ({
      value,
      label: value,
      count,
    }))
  }, [entries])

  const benchmarks = useMemo(() => {
    const counts: Record<string, number> = {}
    entries.forEach((e) => {
      counts[e.benchmark] = (counts[e.benchmark] || 0) + 1
    })
    return Object.entries(counts).map(([value, count]) => ({
      value,
      label: value,
      count,
    }))
  }, [entries])

  // Filter entries
  const filteredEntries = useMemo(() => {
    return entries.filter((e) => {
      // Search filter
      if (search) {
        const searchLower = search.toLowerCase()
        const matchesSearch =
          e.version.toLowerCase().includes(searchLower) ||
          e.runId.toLowerCase().includes(searchLower) ||
          e.provider.toLowerCase().includes(searchLower)
        if (!matchesSearch) return false
      }

      // Provider filter
      if (selectedProviders.length > 0 && !selectedProviders.includes(e.provider)) {
        return false
      }

      // Benchmark filter
      if (selectedBenchmarks.length > 0 && !selectedBenchmarks.includes(e.benchmark)) {
        return false
      }

      return true
    })
  }, [entries, search, selectedProviders, selectedBenchmarks])

  // Get question types and registry - only when exactly one benchmark is selected
  const { visibleQuestionTypes, typeRegistry } = useMemo((): {
    visibleQuestionTypes: string[]
    typeRegistry: LeaderboardEntry["questionTypeRegistry"]
  } => {
    if (selectedBenchmarks.length !== 1) {
      return { visibleQuestionTypes: [], typeRegistry: null }
    }

    // Get all question types present in filtered entries for the selected benchmark
    const types = new Set<string>()
    let registry: LeaderboardEntry["questionTypeRegistry"] = null

    filteredEntries.forEach((e) => {
      Object.keys(e.byQuestionType).forEach((t) => types.add(t))
      if (!registry && e.questionTypeRegistry) {
        registry = e.questionTypeRegistry
      }
    })

    return {
      visibleQuestionTypes: Array.from(types).sort(),
      typeRegistry: registry,
    }
  }, [selectedBenchmarks, filteredEntries])

  // Build columns
  const columns: Column<LeaderboardEntry>[] = useMemo(() => {
    const cols: Column<LeaderboardEntry>[] = [
      {
        key: "rank",
        header: "Rank",
        width: "60px",
        render: (_, idx) => <span className="font-mono text-text-muted">{idx + 1}</span>,
      },
      {
        key: "provider",
        header: "Provider",
        render: (entry) => <span className="capitalize">{entry.provider}</span>,
      },
      {
        key: "benchmark",
        header: "Benchmark",
        render: (entry) => <span className="capitalize">{entry.benchmark}</span>,
      },
      {
        key: "version",
        header: "Version",
        render: (entry) => (
          <Link
            href={`/leaderboard/${entry.id}`}
            className="font-mono text-accent hover:underline cursor-pointer text-sm"
          >
            {entry.version}
          </Link>
        ),
      },
      {
        key: "date",
        header: "Date",
        render: (entry) => {
          const date = new Date(entry.addedAt)
          return (
            <span className="text-text-secondary font-mono text-xs">
              {date.getFullYear()}-{String(date.getMonth() + 1).padStart(2, "0")}
            </span>
          )
        },
      },
    ]

    // Add question type columns only when single benchmark is selected
    visibleQuestionTypes.forEach((type) => {
      const alias = typeRegistry?.[type]?.alias || type.replace(/[-_]/g, " ")
      cols.push({
        key: type,
        header: alias,
        align: "center",
        render: (entry) => {
          const stats = entry.byQuestionType[type]
          if (!stats) {
            return <span className="text-text-muted">—</span>
          }
          return <span className="font-mono">{(stats.accuracy * 100).toFixed(0)}%</span>
        },
      })
    })

    // Accuracy column (always last)
    cols.push({
      key: "accuracy",
      header: "Accuracy",
      align: "right",
      render: (entry) => (
        <span className="font-mono font-medium text-accent">
          {(entry.accuracy * 100).toFixed(1)}%
        </span>
      ),
    })

    // Actions column
    cols.push({
      key: "actions",
      header: "",
      width: "40px",
      align: "right",
      render: (entry) => (
        <DropdownMenu
          items={[
            {
              label: "view details",
              href: `/leaderboard/${entry.id}`,
            },
            { divider: true },
            {
              label: "remove from leaderboard",
              onClick: () => handleRemove(entry.id),
              danger: true,
            },
          ]}
        />
      ),
    })

    return cols
  }, [visibleQuestionTypes, typeRegistry])

  const clearFilters = () => {
    setSearch("")
    setSelectedProviders([])
    setSelectedBenchmarks([])
  }

  if (error) {
    return (
      <div className="animate-fade-in">
        <div className="mb-6">
          <h1 className="text-2xl font-display font-semibold text-text-primary">Leaderboard</h1>
        </div>
        <div className="text-center py-12">
          <p className="text-status-error">{error}</p>
          <button className="btn btn-secondary mt-3" onClick={loadLeaderboard}>
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-display font-semibold text-text-primary">Leaderboard</h1>
      </div>

      {/* Filter Bar */}
      {!loading && entries.length > 0 && (
        <div className="mb-0">
          <FilterBar
            totalCount={entries.length}
            filteredCount={filteredEntries.length}
            searchValue={search}
            onSearchChange={setSearch}
            searchPlaceholder="Search leaderboard..."
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
            ]}
            onClearAll={clearFilters}
          />
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="py-12 text-center">
          <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-text-secondary mt-3">Loading leaderboard...</p>
        </div>
      ) : entries.length === 0 ? (
        <EmptyState
          icon={<TrophyIcon />}
          title="No entries yet"
          description='Add runs to the leaderboard from the Runs page by clicking the three-dot menu on a completed run and selecting "Add to leaderboard".'
        />
      ) : (
        <DataTable
          columns={columns}
          data={filteredEntries}
          emptyMessage="No entries match your filters"
          getRowKey={(entry) => entry.id}
        />
      )}
    </div>
  )
}
