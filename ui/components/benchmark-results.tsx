"use client"

import { useState, useMemo } from "react"
import { cn } from "@/lib/utils"
import { MultiSelect } from "@/components/multi-select"

function Tooltip({ text, children }: { text: string; children: React.ReactNode }) {
  const [show, setShow] = useState(false)

  return (
    <span
      className="relative inline-block"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      {show && (
        <span
          className="absolute z-50 left-0 bottom-full mb-1 px-2 py-1 text-xs text-text-secondary bg-bg-primary border border-border whitespace-nowrap"
          style={{ boxShadow: "0 2px 8px rgba(52, 52, 52, 0.5)" }}
        >
          {text}
        </span>
      )}
    </span>
  )
}

export interface StatCardProps {
  label: string
  value: string | number
  subtext?: string
  mono?: boolean
}

export function StatCard({ label, value, subtext, mono }: StatCardProps) {
  return (
    <div className="card">
      <div className="text-xs text-text-muted uppercase tracking-wide mb-1">{label}</div>
      <div
        className={cn("text-lg font-medium text-text-primary truncate", mono && "font-mono")}
        title={typeof value === "string" ? value : undefined}
      >
        {value}
      </div>
      {subtext && <div className="text-xs text-text-secondary mt-1">{subtext}</div>}
    </div>
  )
}

export interface StatsGridProps {
  cards: StatCardProps[]
}

export function StatsGrid({ cards }: StatsGridProps) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map((card, idx) => (
        <StatCard key={idx} {...card} />
      ))}
    </div>
  )
}

export interface QuestionTypeStats {
  accuracy: number
  correct: number
  total: number
}

export interface AccuracyByTypeProps {
  byQuestionType: Record<string, QuestionTypeStats>
}

export function AccuracyByType({ byQuestionType }: AccuracyByTypeProps) {
  if (!byQuestionType || Object.keys(byQuestionType).length === 0) {
    return null
  }

  return (
    <div className="card">
      <h3 className="text-sm font-medium text-text-primary mb-4">Accuracy by Question Type</h3>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {Object.entries(byQuestionType).map(([type, stats]) => (
          <div key={type} className="bg-bg-primary p-3 rounded border border-border">
            <div className="text-xs text-text-muted uppercase tracking-wide mb-1">
              {type.replace(/[-_]/g, " ")}
            </div>
            <div className="text-xl font-mono text-text-primary">
              {(stats.accuracy * 100).toFixed(0)}%
            </div>
            <div className="text-xs text-text-secondary">
              {stats.correct}/{stats.total}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export interface LatencyStats {
  min: number
  max: number
  mean: number
  median: number
  p95: number
  p99: number
}

export interface RetrievalStats {
  hitAtK: number
  precisionAtK: number
  recallAtK: number
  f1AtK: number
  mrr: number
  ndcg: number
  k: number
}

export interface LatencyTableProps {
  latency?: {
    ingest?: LatencyStats
    indexing?: LatencyStats
    search?: LatencyStats
    answer?: LatencyStats
    evaluate?: LatencyStats
    total?: LatencyStats
  } | null
}

export function LatencyTable({ latency }: LatencyTableProps) {
  if (!latency) return null

  return (
    <div className="card">
      <h3 className="text-sm font-medium text-text-primary mb-4">Latency Stats (ms)</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="text-left py-2 px-3 text-text-muted font-medium uppercase text-xs">
                phase
              </th>
              <th className="text-right py-2 px-3 text-text-muted font-medium uppercase text-xs">
                min
              </th>
              <th className="text-right py-2 px-3 text-text-muted font-medium uppercase text-xs">
                max
              </th>
              <th className="text-right py-2 px-3 text-text-muted font-medium uppercase text-xs">
                mean
              </th>
              <th className="text-right py-2 px-3 text-text-muted font-medium uppercase text-xs">
                median
              </th>
              <th className="text-right py-2 px-3 text-text-muted font-medium uppercase text-xs">
                p95
              </th>
              <th className="text-right py-2 px-3 text-text-muted font-medium uppercase text-xs">
                p99
              </th>
            </tr>
          </thead>
          <tbody>
            {(["ingest", "indexing", "search", "answer", "evaluate", "total"] as const).map(
              (phase) => {
                const stats = latency[phase]
                if (!stats) return null
                return (
                  <tr key={phase} className="border-b border-border/50">
                    <td className="py-2 px-3 text-text-primary capitalize">{phase}</td>
                    <td className="py-2 px-3 text-right font-mono text-text-secondary">
                      {stats.min}
                    </td>
                    <td className="py-2 px-3 text-right font-mono text-text-secondary">
                      {stats.max}
                    </td>
                    <td className="py-2 px-3 text-right font-mono text-text-secondary">
                      {stats.mean}
                    </td>
                    <td className="py-2 px-3 text-right font-mono text-text-primary">
                      {stats.median}
                    </td>
                    <td className="py-2 px-3 text-right font-mono text-text-secondary">
                      {stats.p95}
                    </td>
                    <td className="py-2 px-3 text-right font-mono text-text-secondary">
                      {stats.p99}
                    </td>
                  </tr>
                )
              }
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export interface RetrievalMetricsProps {
  retrieval?: RetrievalStats | null
  byQuestionType?: Record<string, { retrieval?: RetrievalStats }> | null
}

export function RetrievalMetrics({ retrieval, byQuestionType }: RetrievalMetricsProps) {
  if (!retrieval) return null

  const questionTypes = byQuestionType
    ? Object.entries(byQuestionType).filter(([_, stats]) => stats.retrieval)
    : []

  return (
    <div className="card">
      <h3 className="text-sm font-medium text-text-primary mb-4">
        Retrieval Quality (K={retrieval.k})
      </h3>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-bg-primary p-3 rounded border border-border">
          <div className="text-xs text-text-muted uppercase tracking-wide mb-1">
            Hit@{retrieval.k}
          </div>
          <div className="text-xl font-mono text-text-primary">
            {(retrieval.hitAtK * 100).toFixed(0)}%
          </div>
          <div className="text-xs text-text-secondary">found relevant</div>
        </div>
        <div className="bg-bg-primary p-3 rounded border border-border">
          <div className="text-xs text-text-muted uppercase tracking-wide mb-1">MRR</div>
          <div className="text-xl font-mono text-text-primary">{retrieval.mrr.toFixed(2)}</div>
          <div className="text-xs text-text-secondary">mean reciprocal rank</div>
        </div>
        <div className="bg-bg-primary p-3 rounded border border-border">
          <div className="text-xs text-text-muted uppercase tracking-wide mb-1">NDCG</div>
          <div className="text-xl font-mono text-text-primary">{retrieval.ndcg.toFixed(2)}</div>
          <div className="text-xs text-text-secondary">ranking quality</div>
        </div>
        <div className="bg-bg-primary p-3 rounded border border-border">
          <div className="text-xs text-text-muted uppercase tracking-wide mb-1">
            F1@{retrieval.k}
          </div>
          <div className="text-xl font-mono text-text-primary">
            {(retrieval.f1AtK * 100).toFixed(0)}%
          </div>
          <div className="text-xs text-text-secondary">precision-recall balance</div>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="text-left py-2 px-3 text-text-muted font-medium uppercase text-xs">
                metric
              </th>
              <th className="text-right py-2 px-3 text-text-muted font-medium uppercase text-xs">
                overall
              </th>
              {questionTypes.map(([type]) => (
                <th
                  key={type}
                  className="text-right py-2 px-3 text-text-muted font-medium uppercase text-xs"
                >
                  {type.replace(/[-_]/g, " ")}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(["hitAtK", "precisionAtK", "recallAtK", "f1AtK", "mrr", "ndcg"] as const).map(
              (metric) => {
                const labels: Record<string, string> = {
                  hitAtK: `Hit@${retrieval.k}`,
                  precisionAtK: "Precision",
                  recallAtK: "Recall",
                  f1AtK: "F1",
                  mrr: "MRR",
                  ndcg: "NDCG",
                }
                const tooltips: Record<string, string> = {
                  hitAtK: "found at least one relevant result",
                  precisionAtK: "relevant results out of retrieved",
                  recallAtK: "found relevant content",
                  f1AtK: "precision-recall balance",
                  mrr: "mean reciprocal rank",
                  ndcg: "ranking quality score",
                }
                const isPercentage = ["hitAtK", "precisionAtK", "recallAtK", "f1AtK"].includes(
                  metric
                )
                const format = (v: number) =>
                  isPercentage ? `${(v * 100).toFixed(1)}%` : v.toFixed(3)

                return (
                  <tr key={metric} className="border-b border-border/50">
                    <td className="py-2 px-3 text-text-primary">
                      <Tooltip text={tooltips[metric]}>{labels[metric]}</Tooltip>
                    </td>
                    <td className="py-2 px-3 text-right font-mono text-text-primary">
                      {format(retrieval[metric])}
                    </td>
                    {questionTypes.map(([type, stats]) => (
                      <td key={type} className="py-2 px-3 text-right font-mono text-text-secondary">
                        {stats.retrieval ? format(stats.retrieval[metric]) : "—"}
                      </td>
                    ))}
                  </tr>
                )
              }
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export interface EvaluationResult {
  questionId: string
  questionType: string
  question?: string
  groundTruth: string
  hypothesis?: string
  score?: number
  label?: string
  explanation?: string
}

export interface EvaluationListProps {
  evaluations: EvaluationResult[]
  onViewDetails?: (questionId: string) => void
}

export function EvaluationList({ evaluations, onViewDetails }: EvaluationListProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [selectedTypes, setSelectedTypes] = useState<string[]>([])
  const [showFailuresOnly, setShowFailuresOnly] = useState(false)

  const questionTypes = useMemo(() => {
    const counts: Record<string, number> = {}
    evaluations.forEach((e) => {
      const type = e.questionType || "unknown"
      counts[type] = (counts[type] || 0) + 1
    })
    return Object.entries(counts).map(([value, count]) => ({
      value,
      label: value.replace(/[-_]/g, " "),
      count,
    }))
  }, [evaluations])

  const failureCount = useMemo(() => {
    return evaluations.filter((e) => e.label === "incorrect" || e.score === 0).length
  }, [evaluations])

  const filtered = useMemo(() => {
    return evaluations.filter((e) => {
      if (showFailuresOnly && e.label !== "incorrect" && e.score !== 0) {
        return false
      }

      if (search) {
        const searchLower = search.toLowerCase()
        const matchesSearch =
          e.questionId.toLowerCase().includes(searchLower) ||
          (e.question?.toLowerCase().includes(searchLower) ?? false) ||
          e.groundTruth.toLowerCase().includes(searchLower) ||
          (e.hypothesis?.toLowerCase().includes(searchLower) ?? false)
        if (!matchesSearch) return false
      }

      const type = e.questionType || "unknown"
      if (selectedTypes.length > 0 && !selectedTypes.includes(type)) {
        return false
      }

      return true
    })
  }, [evaluations, search, selectedTypes, showFailuresOnly])

  const hasActiveFilters = search || selectedTypes.length > 0 || showFailuresOnly

  if (evaluations.length === 0) {
    return <div className="text-center py-8 text-text-secondary">No results available</div>
  }

  return (
    <div>
      <div className="mb-4">
        <div className="flex items-center justify-between text-sm px-1 mb-2">
          <span className="text-text-secondary">
            Showing {filtered.length} of {evaluations.length}{" "}
            {evaluations.length === 1 ? "result" : "results"}
          </span>
          <button
            type="button"
            className={cn(
              "text-text-muted hover:text-text-primary transition-colors cursor-pointer",
              !hasActiveFilters && "opacity-50"
            )}
            onClick={() => {
              setSearch("")
              setSelectedTypes([])
              setShowFailuresOnly(false)
            }}
          >
            Clear filters
          </button>
        </div>

        <div className="inline-flex border border-[#333333] rounded">
          <div className="w-[200px] border-r border-[#333333]">
            <div className="relative h-[40px] flex items-center">
              <svg
                className="absolute left-3 w-4 h-4 text-text-muted"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
              <input
                type="text"
                placeholder="Search results..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full h-full pl-9 pr-3 text-sm bg-transparent text-text-primary placeholder-text-muted focus:outline-none cursor-text"
              />
            </div>
          </div>

          <div className="w-[180px] border-r border-[#333333]">
            <MultiSelect
              label="Select question types"
              options={questionTypes}
              selected={selectedTypes}
              onChange={setSelectedTypes}
              placeholder="All types"
            />
          </div>

          <button
            type="button"
            className={cn(
              "w-[120px] h-[40px] flex items-center justify-center gap-2 text-sm transition-colors cursor-pointer",
              showFailuresOnly
                ? "bg-status-error/10 text-status-error"
                : "text-text-muted hover:text-text-primary"
            )}
            onClick={() => setShowFailuresOnly(!showFailuresOnly)}
          >
            <span>Failures</span>
            <span
              className={cn(
                "text-xs px-1.5 py-0.5 rounded",
                showFailuresOnly ? "bg-status-error/20" : "bg-bg-elevated"
              )}
            >
              {failureCount}
            </span>
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-8 text-text-secondary">
          {showFailuresOnly ? "No failures found" : "No results match your filters"}
        </div>
      ) : (
        <div className="border border-border rounded overflow-hidden">
          {filtered.map((evaluation, idx) => {
            const isExpanded = expandedId === evaluation.questionId
            const isCorrect = evaluation.score === 1 || evaluation.label === "correct"
            const isLast = idx === filtered.length - 1

            return (
              <div
                key={evaluation.questionId}
                className={cn(
                  "bg-bg-secondary cursor-pointer transition-colors hover:bg-bg-elevated",
                  !isLast && !isExpanded && "border-b border-border"
                )}
              >
                <div
                  className="px-4 py-3 flex items-center gap-3"
                  onClick={() => setExpandedId(isExpanded ? null : evaluation.questionId)}
                >
                  <div
                    className={cn(
                      "w-2 h-2 rounded-full flex-shrink-0",
                      isCorrect ? "bg-status-success" : "bg-status-error"
                    )}
                  />

                  <span className="font-mono text-sm text-text-secondary w-[140px] flex-shrink-0">
                    {evaluation.questionId}
                  </span>

                  <span className="text-xs px-2 py-0.5 rounded bg-bg-primary text-text-muted flex-shrink-0">
                    {evaluation.questionType?.replace(/[-_]/g, " ")}
                  </span>

                  <span className="text-sm text-text-primary flex-1 min-w-0 truncate">
                    {evaluation.question || evaluation.groundTruth}
                  </span>

                  <span
                    className={cn(
                      "text-sm font-medium flex-shrink-0",
                      isCorrect ? "text-status-success" : "text-status-error"
                    )}
                  >
                    {evaluation.label}
                  </span>

                  {onViewDetails && (
                    <button
                      className="text-xs text-text-muted hover:text-accent transition-colors cursor-pointer flex-shrink-0"
                      onClick={(e) => {
                        e.stopPropagation()
                        onViewDetails(evaluation.questionId)
                      }}
                    >
                      View details
                    </button>
                  )}

                  <svg
                    className={cn(
                      "w-4 h-4 text-text-muted transition-transform flex-shrink-0",
                      isExpanded && "rotate-180"
                    )}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </div>

                {isExpanded && (
                  <div
                    className={cn(
                      "px-4 py-4 space-y-4 bg-bg-primary border-t border-border overflow-hidden",
                      !isLast && "border-b border-border"
                    )}
                  >
                    {evaluation.question && (
                      <div className="min-w-0">
                        <div className="text-xs text-text-muted uppercase tracking-wide mb-1">
                          Question
                        </div>
                        <div className="text-sm text-text-primary break-words">
                          {evaluation.question}
                        </div>
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-4 min-w-0">
                      <div className="min-w-0">
                        <div className="text-xs text-text-muted uppercase tracking-wide mb-1">
                          Ground Truth
                        </div>
                        <div className="text-sm text-text-primary font-mono bg-bg-elevated p-2 rounded break-words">
                          {evaluation.groundTruth}
                        </div>
                      </div>
                      <div className="min-w-0">
                        <div className="text-xs text-text-muted uppercase tracking-wide mb-1">
                          Model Answer
                        </div>
                        <div className="text-sm text-text-primary font-mono bg-bg-elevated p-2 rounded break-words">
                          {evaluation.hypothesis || "—"}
                        </div>
                      </div>
                    </div>

                    {evaluation.explanation && (
                      <div className="min-w-0">
                        <div className="text-xs text-text-muted uppercase tracking-wide mb-1">
                          Explanation
                        </div>
                        <div className="text-sm text-text-secondary break-words">
                          {evaluation.explanation}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
