import type { RunCheckpoint } from "../types/checkpoint"

/** Identity fields every run-list row must expose for like-for-like interpretation. */
export function getRunListIdentity(checkpoint: RunCheckpoint) {
  return {
    benchmarkScope: checkpoint.benchmarkScope,
    datasetIdentity: checkpoint.datasetIdentity,
    benchmarkInputFingerprint: checkpoint.benchmarkInputFingerprint,
    selectedQuestionIdsDigest: checkpoint.selectedQuestionIdsDigest,
    protocolIdentity: checkpoint.protocolIdentity,
    providerPromptFingerprint: checkpoint.providerPromptFingerprint,
  }
}
