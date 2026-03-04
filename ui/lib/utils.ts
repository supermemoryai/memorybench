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

export function calculateAccuracy(
  summary: { total: number; evaluated: number } & Record<string, number>,
  questions?: Record<string, any>
): number | null {
  if (!questions || summary.evaluated === 0) return null

  const evaluated = Object.values(questions).filter(
    (q: any) => q.phases?.evaluate?.status === "completed"
  )
  if (evaluated.length === 0) return null

  const correct = evaluated.filter((q: any) => q.phases?.evaluate?.score === 1).length
  return (correct / evaluated.length) * 100
}
