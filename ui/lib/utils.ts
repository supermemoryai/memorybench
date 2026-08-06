export function cn(...classes: (string | boolean | undefined | null)[]): string {
  return classes.filter(Boolean).join(" ")
}

export function formatDate(date: string): string {
  const now = new Date()
  const d = new Date(date)
  const diffMs = now.getTime() - d.getTime()
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHour = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHour / 24)

  // Less than 1 minute
  if (diffSec < 60) {
    return diffSec <= 5 ? "just now" : `${diffSec}s ago`
  }

  // Less than 1 hour
  if (diffMin < 60) {
    return `${diffMin}m ago`
  }

  // Less than 6 hours
  if (diffHour < 6) {
    return `${diffHour}h ago`
  }

  // Same day - just show time
  const isToday = d.toDateString() === now.toDateString()
  if (isToday) {
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
  }

  // This year - show month day + time
  if (d.getFullYear() === now.getFullYear()) {
    return (
      d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
      " " +
      d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    )
  }

  // Different year - show full date
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

export function getBenchmarkDisplayName(
  benchmark: string,
  scope?: Record<string, unknown> | { displayName?: string }
): string {
  if (typeof scope?.displayName === "string" && scope.displayName.trim()) {
    return scope.displayName
  }
  const names: Record<string, string> = {
    "beam-1m": "BEAM 1M",
    "beam-10m": "BEAM 10M",
    "beam-1m-10m": "BEAM 1M/10M",
  }
  return names[benchmark] ?? benchmark
}

export function getStatusColor(status: string): string {
  switch (status) {
    case "completed":
      return "badge-success"
    case "failed":
      return "badge-error"
    case "running":
    case "in_progress":
    case "initializing":
      return "badge-running"
    case "partial":
      return "badge-warning"
    default:
      return "badge-neutral"
  }
}

export interface EvaluationCompatibility {
  passed?: boolean
  label?: string
  score?: number
  primaryScore?: number
  evaluation?: EvaluationCompatibility
}

/** Resolve protocol-native judgments first, then compatibility mirrors and legacy binary scores. */
export function getEvaluationPassState(
  value?: EvaluationCompatibility | null
): boolean | undefined {
  const protocolEvaluation = value?.evaluation
  if (typeof protocolEvaluation?.passed === "boolean") return protocolEvaluation.passed
  if (typeof value?.passed === "boolean") return value.passed

  for (const label of [protocolEvaluation?.label, value?.label]) {
    if (typeof label !== "string") continue
    const normalized = label.toLowerCase()
    if (normalized === "pass" || normalized === "correct") return true
    if (normalized === "fail" || normalized === "incorrect" || normalized === "wrong") {
      return false
    }
  }

  const legacyScore = value?.score ?? protocolEvaluation?.primaryScore ?? value?.primaryScore
  return typeof legacyScore === "number" ? legacyScore === 1 : undefined
}

export function isEvaluationPassed(value?: EvaluationCompatibility | null): boolean {
  return getEvaluationPassState(value) === true
}

export function isEvaluationFailed(value?: EvaluationCompatibility | null): boolean {
  return getEvaluationPassState(value) === false
}

export type PipelinePhaseKey = "ingested" | "indexed" | "searched" | "answered" | "evaluated"

export interface PipelineSummary {
  total: number
  builds?: number
  ingested: number
  indexed: number
  searched: number
  answered: number
  evaluated: number
}

/** Shared-build runs count ingest/index per build; legacy summaries counted every phase per question. */
export function getPipelinePhaseTotal(summary: PipelineSummary, phase: PipelinePhaseKey): number {
  return phase === "ingested" || phase === "indexed"
    ? (summary.builds ?? summary.total)
    : summary.total
}

export function getPipelineProgress(summary: PipelineSummary): {
  progress: number
  phasesFullyComplete: number
} {
  const phases: PipelinePhaseKey[] = ["ingested", "indexed", "searched", "answered", "evaluated"]
  let completedWork = 0
  let totalWork = 0
  let phasesFullyComplete = 0

  for (const phase of phases) {
    const phaseTotal = getPipelinePhaseTotal(summary, phase)
    const completed = summary[phase]
    completedWork += Math.min(completed, phaseTotal)
    totalWork += phaseTotal
    if (phaseTotal > 0 && completed >= phaseTotal) phasesFullyComplete++
  }

  return {
    progress: totalWork > 0 ? completedWork / totalWork : 0,
    phasesFullyComplete,
  }
}

export function calculateAccuracy(
  summary: { total: number; evaluated: number } & Record<string, number>,
  questions?: Record<string, any>
): number | null {
  if (!questions || summary.evaluated === 0) return null

  const evaluated = Object.values(questions).filter(
    (q: any) => q.phases?.evaluate?.status === "completed"
  )
  if (evaluated.length === 0) return null

  const correct = evaluated.filter((q: any) => isEvaluationPassed(q.phases?.evaluate)).length
  return (correct / evaluated.length) * 100
}
