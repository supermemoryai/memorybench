import { describe, expect, test } from "bun:test"
import type { RunCheckpoint } from "../src/types/checkpoint"
import { getRunListIdentity } from "../src/server/run-identity"

describe("run-list identity", () => {
  test("exposes benchmark scope and immutable dataset/protocol identity", () => {
    const checkpoint = {
      benchmarkScope: { displayName: "BEAM 1M", includedTiers: ["1M"], coverage: "subset" },
      datasetIdentity: { datasetFingerprint: "dataset-fingerprint" },
      benchmarkInputFingerprint: "benchmark-input-digest",
      selectedQuestionIdsDigest: "question-set-digest",
      protocolIdentity: { id: "beam-paper", version: "1.1.0" },
      providerPromptFingerprint: "provider-prompt-digest",
    } as RunCheckpoint

    expect(getRunListIdentity(checkpoint)).toEqual({
      benchmarkScope: checkpoint.benchmarkScope,
      datasetIdentity: checkpoint.datasetIdentity,
      benchmarkInputFingerprint: "benchmark-input-digest",
      selectedQuestionIdsDigest: "question-set-digest",
      protocolIdentity: checkpoint.protocolIdentity,
      providerPromptFingerprint: "provider-prompt-digest",
    })
  })
})
