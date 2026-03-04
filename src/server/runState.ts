// Shared run state for tracking active runs and stop signals
// Used by both server routes and orchestrator phases

export type RunState = {
  status: "running" | "stopping"
  startedAt: string
  benchmark?: string
}

// In-memory map of active runs
export const activeRuns = new Map<string, RunState>()

// Check if a run should stop
export function shouldStop(runId: string): boolean {
  const state = activeRuns.get(runId)
  return state?.status === "stopping"
}

// Mark a run as stopping
export function requestStop(runId: string): boolean {
  const state = activeRuns.get(runId)
  if (!state) return false
  state.status = "stopping"
  return true
}

// Start tracking a run
export function startRun(runId: string, benchmark?: string): void {
  activeRuns.set(runId, {
    status: "running",
    startedAt: new Date().toISOString(),
    benchmark,
  })
}

// Stop tracking a run
export function endRun(runId: string): void {
  activeRuns.delete(runId)
}

// Check if a run is active
export function isRunActive(runId: string): boolean {
  return activeRuns.has(runId)
}

// Get run state
export function getRunState(runId: string): RunState | undefined {
  return activeRuns.get(runId)
}

// Get all active runs with their benchmarks
export function getActiveRunsWithBenchmarks(): Array<{ runId: string; benchmark: string }> {
  const result: Array<{ runId: string; benchmark: string }> = []
  for (const [runId, state] of activeRuns) {
    if (state.benchmark) {
      result.push({ runId, benchmark: state.benchmark })
    }
  }
  return result
}
