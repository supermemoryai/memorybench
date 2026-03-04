export interface ConcurrencyConfig {
  default: number
  ingest?: number
  indexing?: number
  search?: number
  answer?: number
  evaluate?: number
}

export type PhaseId = "ingest" | "indexing" | "search" | "answer" | "evaluate"

export type PhaseConcurrencyMap = {
  [K in PhaseId]: number
}

export function resolveConcurrency(
  phase: PhaseId,
  cliConfig?: ConcurrencyConfig,
  providerDefault?: ConcurrencyConfig
): number {
  // Priority 1: CLI per-phase flag
  if (cliConfig && cliConfig[phase] !== undefined) {
    return cliConfig[phase]!
  }

  // Priority 2: CLI default flag
  if (cliConfig?.default !== undefined) {
    return cliConfig.default
  }

  // Priority 3: Provider per-phase default
  if (providerDefault && providerDefault[phase] !== undefined) {
    return providerDefault[phase]!
  }

  // Priority 4: Provider default
  if (providerDefault?.default !== undefined) {
    return providerDefault.default
  }

  // Priority 5: Global default (sequential)
  return 1
}
