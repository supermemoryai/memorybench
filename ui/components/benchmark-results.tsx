"use client"

import { useState, useMemo } from "react"
import { cn, isEvaluationFailed, isEvaluationPassed } from "@/lib/utils"
import { MultiSelect } from "@/components/multi-select"
import type { BuildReport, QuestionMetric, RunCostReport } from "@/lib/api"

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

export function BuildMetricsTable({ builds }: { builds?: BuildReport | null }) {
  if (!builds) return null

  return (
    <div className="card">
      <h3 className="text-sm font-medium text-text-primary mb-1">Build Metrics</h3>
      <p className="text-xs text-text-muted mb-4">
        One-time cost per container; never multiplied by question count.
      </p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatCard label="containers" value={builds.uniqueBuildCount} />
        <StatCard label="build work" value={`${builds.sumContainerBuildWorkMs}ms`} />
        <StatCard label="phase wall-clock" value={`${builds.buildPhaseWallClockMs}ms`} />
        <StatCard
          label="known build cost"
          value={builds.totalBuildCostUsd == null ? "—" : `$${builds.totalBuildCostUsd.toFixed(4)}`}
          subtext={`${builds.knownCostBuildCount}/${builds.totalCostBuildCount} costs known`}
        />
      </div>
      {builds.items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 px-3 text-text-muted font-medium uppercase text-xs">
                  container
                </th>
                <th className="text-right py-2 px-3 text-text-muted font-medium uppercase text-xs">
                  ingest
                </th>
                <th className="text-right py-2 px-3 text-text-muted font-medium uppercase text-xs">
                  index
                </th>
                <th className="text-right py-2 px-3 text-text-muted font-medium uppercase text-xs">
                  wall-clock
                </th>
                <th className="text-right py-2 px-3 text-text-muted font-medium uppercase text-xs">
                  work
                </th>
                <th className="text-right py-2 px-3 text-text-muted font-medium uppercase text-xs">
                  cost
                </th>
              </tr>
            </thead>
            <tbody>
              {builds.items.map((build) => (
                <tr key={build.buildId} className="border-b border-border/50">
                  <td className="py-2 px-3 text-text-primary font-mono text-xs">
                    {build.containerTag}
                    {build.reused && <span className="ml-2 text-text-muted">reused</span>}
                    {!build.reused && build.reusedPhases?.ingest && (
                      <span className="ml-2 text-text-muted">ingest reused</span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-right font-mono text-text-secondary">
                    {build.ingestLatencyMs}ms
                  </td>
                  <td className="py-2 px-3 text-right font-mono text-text-secondary">
                    {build.indexingLatencyMs}ms
                  </td>
                  <td className="py-2 px-3 text-right font-mono text-text-secondary">
                    {build.buildWallClockMs}ms
                  </td>
                  <td className="py-2 px-3 text-right font-mono text-text-secondary">
                    {build.buildWorkMs}ms
                  </td>
                  <td className="py-2 px-3 text-right font-mono text-text-secondary">
                    {build.costUsd == null ? "—" : `$${build.costUsd.toFixed(4)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export function QuestionMetricsSummary({
  metrics,
  costs,
}: {
  metrics?: QuestionMetric[] | null
  costs?: RunCostReport | null
}) {
  if (!metrics?.length) return null
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
  const amortized = metrics
    .map((metric) => metric.amortizedOnlinePlusBuildWorkMs)
    .filter((value): value is number => value != null)
  const allocationDenominators = Array.from(
    new Set(
      metrics
        .map((metric) => metric.buildAllocationQuestionCount)
        .filter((value): value is number => value != null)
    )
  ).sort((left, right) => left - right)
  const summarizeCosts = (values: Array<number | null>): RunCostReport["query"] => {
    const known = values.filter((value): value is number => value != null)
    return {
      totalCostUsd:
        values.length > 0 && known.length === values.length
          ? known.reduce((sum, value) => sum + value, 0)
          : null,
      knownCostCount: known.length,
      totalCostCount: values.length,
    }
  }
  const effectiveCosts =
    costs ??
    ({
      query: summarizeCosts(metrics.map((metric) => metric.queryCostUsd)),
      evaluation: summarizeCosts(metrics.map((metric) => metric.evaluationCostUsd)),
    } satisfies RunCostReport)
  const evaluationUsage = metrics
    .map((metric) => metric.evaluationUsage)
    .filter((usage): usage is NonNullable<typeof usage> => usage != null)
  const sumEvaluationUsage = (field: keyof (typeof evaluationUsage)[number]) =>
    evaluationUsage.reduce((sum, usage) => sum + (usage[field] ?? 0), 0)
  const evaluationRequestCount = sumEvaluationUsage("requestCount")
  const completeTokenUsageCount = sumEvaluationUsage("tokenUsageCompleteRequestCount")
  const partialTokenUsageCount = sumEvaluationUsage("tokenUsagePartialRequestCount")
  const unknownTokenUsageCount = sumEvaluationUsage("tokenUsageUnknownRequestCount")
  const classifiedTokenUsageCount =
    completeTokenUsageCount + partialTokenUsageCount + unknownTokenUsageCount
  const formatCost = (value: number | null) => (value == null ? "—" : `$${value.toFixed(4)}`)
  const amortizationSubtext =
    allocationDenominators.length === 0
      ? "online + allocated build work; denominator unavailable"
      : allocationDenominators.length === 1
        ? `online + build work ÷ ${allocationDenominators[0]} completed question${allocationDenominators[0] === 1 ? "" : "s"} for its build`
        : `online + build work ÷ per-build completed-question counts (${allocationDenominators.join(", ")})`
  const recordedRetrievalMetrics = metrics.filter((metric) =>
    [
      metric.configuredTopK,
      metric.rawReturnedCount,
      metric.normalizedCount,
      metric.answerEvidenceCount,
    ].some((value) => value != null)
  )
  const onlyNumbers = (values: Array<number | undefined>) =>
    values.filter((value): value is number => value != null)
  const uniqueTopK = Array.from(
    new Set(onlyNumbers(recordedRetrievalMetrics.map((metric) => metric.configuredTopK)))
  ).sort((a, b) => a - b)
  const uniqueProviderLimits = Array.from(
    new Set(onlyNumbers(recordedRetrievalMetrics.map((metric) => metric.providerRequestLimit)))
  ).sort((a, b) => a - b)
  const formatContractValue = (values: number[]) =>
    values.length === 0
      ? "—"
      : values.length === 1
        ? String(values[0])
        : `mixed (${values.join(", ")})`
  const formatMean = (values: Array<number | undefined>) => {
    const recorded = onlyNumbers(values)
    return recorded.length > 0 ? mean(recorded).toFixed(1) : "—"
  }
  const totalDropped = recordedRetrievalMetrics.reduce(
    (sum, metric) => sum + (metric.droppedCount ?? 0),
    0
  )

  return (
    <div className="card">
      <h3 className="text-sm font-medium text-text-primary mb-1">Per-question Metrics</h3>
      <p className="text-xs text-text-muted mb-4">
        Online query and offline evaluation are reported separately from build work.
      </p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label="online query mean"
          value={`${mean(metrics.map((metric) => metric.onlineQueryLatencyMs)).toFixed(1)}ms`}
        />
        <StatCard
          label="evaluation mean"
          value={`${mean(metrics.map((metric) => metric.evaluationLatencyMs)).toFixed(1)}ms`}
        />
        <StatCard
          label="amortized mean"
          value={amortized.length > 0 ? `${mean(amortized).toFixed(1)}ms` : "—"}
          subtext={amortizationSubtext}
        />
        <StatCard
          label="query / eval total cost"
          value={`${formatCost(effectiveCosts.query.totalCostUsd)} / ${formatCost(effectiveCosts.evaluation.totalCostUsd)}`}
          subtext={`${effectiveCosts.query.knownCostCount}/${effectiveCosts.query.totalCostCount} query, ${effectiveCosts.evaluation.knownCostCount}/${effectiveCosts.evaluation.totalCostCount} eval known`}
        />
        {evaluationRequestCount > 0 && (
          <StatCard
            label="evaluation requests"
            value={evaluationRequestCount}
            subtext={
              classifiedTokenUsageCount > 0
                ? `${completeTokenUsageCount} complete, ${partialTokenUsageCount} partial, ${unknownTokenUsageCount} unknown token usage`
                : "token-usage coverage unavailable for this report"
            }
          />
        )}
      </div>
      {recordedRetrievalMetrics.length > 0 && (
        <>
          <h4 className="text-xs text-text-muted uppercase tracking-wide mt-5 mb-3">
            Retrieval contract
          </h4>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard
              label="configured top-k"
              value={formatContractValue(uniqueTopK)}
              subtext={`provider request limit ${formatContractValue(uniqueProviderLimits)}`}
            />
            <StatCard
              label="raw / normalized mean"
              value={`${formatMean(recordedRetrievalMetrics.map((metric) => metric.rawReturnedCount))} / ${formatMean(recordedRetrievalMetrics.map((metric) => metric.normalizedCount))}`}
              subtext={`${totalDropped} result${totalDropped === 1 ? "" : "s"} dropped during normalization`}
            />
            <StatCard
              label="evidence / cutoff mean"
              value={`${formatMean(recordedRetrievalMetrics.map((metric) => metric.answerEvidenceCount))} / ${formatMean(recordedRetrievalMetrics.map((metric) => metric.answerCutoff))}`}
              subtext="results actually placed in the answer prompt"
            />
            <StatCard
              label="context tokens mean"
              value={formatMean(recordedRetrievalMetrics.map((metric) => metric.contextTokens))}
              subtext="retrieved-context prompt tokens"
            />
          </div>
        </>
      )}
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
  qualityBySlice?: Record<string, Record<string, number>>
}

export function AccuracyByType({ byQuestionType, qualityBySlice }: AccuracyByTypeProps) {
  const types = Array.from(
    new Set([
      ...Object.keys(byQuestionType || {}),
      ...Object.keys(qualityBySlice || {}).filter((type) => !type.startsWith("tier:")),
    ])
  ).sort()
  if (types.length === 0) return null

  return (
    <div className="card">
      <h3 className="text-sm font-medium text-text-primary mb-4">Quality by Question Type</h3>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {types.map((type) => {
          const stats = byQuestionType?.[type]
          const averageScore = qualityBySlice?.[type]?.averageScore
          const passAccuracy = qualityBySlice?.[type]?.passAccuracy ?? stats?.accuracy
          const displayValue = averageScore ?? stats?.accuracy
          return (
            <div key={type} className="bg-bg-primary p-3 rounded border border-border">
              <div className="text-xs text-text-muted uppercase tracking-wide mb-1">
                {type.replace(/[-_]/g, " ")}
              </div>
              <div className="text-xl font-mono text-text-primary">
                {displayValue != null ? `${(displayValue * 100).toFixed(0)}%` : "—"}
              </div>
              <div className="text-xs text-text-secondary">
                {averageScore != null
                  ? `avg score${passAccuracy != null ? ` · ${(passAccuracy * 100).toFixed(0)}% pass` : ""}`
                  : stats
                    ? `${stats.correct}/${stats.total}`
                    : "average score unavailable"}
              </div>
            </div>
          )
        })}
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
              <th className="text-left py-2 px-3 text-text-muted font-medium uppercase text-xs">
                scope
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
                const scope =
                  phase === "ingest" || phase === "indexing"
                    ? "build / container"
                    : phase === "evaluate"
                      ? "offline / question"
                      : "online / question"
                const phaseLabel = phase === "total" ? "online total" : phase
                return (
                  <tr key={phase} className="border-b border-border/50">
                    <td className="py-2 px-3 text-text-primary capitalize">{phaseLabel}</td>
                    <td className="py-2 px-3 text-text-muted text-xs">{scope}</td>
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
  primaryScore?: number
  passed?: boolean
  label?: string
  explanation?: string
  metrics?: Record<string, number>
  details?: Record<string, unknown>
  evaluation?: {
    primaryScore?: number
    passed?: boolean
    label?: string
    explanation?: string
    metrics?: Record<string, number>
    details?: Record<string, unknown>
  }
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
    return evaluations.filter((e) => isEvaluationFailed(e)).length
  }, [evaluations])

  const filtered = useMemo(() => {
    return evaluations.filter((e) => {
      if (showFailuresOnly && !isEvaluationFailed(e)) {
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
            const isCorrect = isEvaluationPassed(evaluation)
            const isLast = idx === filtered.length - 1
            const primaryScore =
              evaluation.evaluation?.primaryScore ?? evaluation.primaryScore ?? evaluation.score
            const metrics = evaluation.evaluation?.metrics ?? evaluation.metrics
            const details = evaluation.evaluation?.details ?? evaluation.details
            const explanation = evaluation.evaluation?.explanation ?? evaluation.explanation

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
                    {evaluation.label || (isCorrect ? "correct" : "incorrect")}
                  </span>

                  {primaryScore != null && (
                    <span className="text-xs font-mono text-text-secondary flex-shrink-0">
                      {primaryScore.toFixed(3)}
                    </span>
                  )}

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

                    {metrics && Object.keys(metrics).length > 0 && (
                      <div className="min-w-0">
                        <div className="text-xs text-text-muted uppercase tracking-wide mb-1">
                          Protocol metrics
                        </div>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                          {Object.entries(metrics).map(([metric, value]) => (
                            <div key={metric} className="bg-bg-elevated p-2 rounded">
                              <div className="text-[10px] text-text-muted uppercase break-words">
                                {metric}
                              </div>
                              <div className="text-sm font-mono text-text-primary">
                                {Number.isFinite(value) ? value.toFixed(4) : String(value)}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {explanation && (
                      <div className="min-w-0">
                        <div className="text-xs text-text-muted uppercase tracking-wide mb-1">
                          Explanation
                        </div>
                        <div className="text-sm text-text-secondary break-words">{explanation}</div>
                      </div>
                    )}

                    {details && Object.keys(details).length > 0 && (
                      <div className="min-w-0">
                        <div className="text-xs text-text-muted uppercase tracking-wide mb-1">
                          Protocol details
                        </div>
                        <pre className="text-xs text-text-secondary font-mono bg-bg-elevated p-3 rounded overflow-x-auto max-h-[320px] overflow-y-auto">
                          {JSON.stringify(details, null, 2)}
                        </pre>
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
