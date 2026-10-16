export const BEAM_KENDALL_TAU_IMPLEMENTATION = "scipy-compatible-tau-b-fail-closed-v1"
export const BEAM_EVENT_EXTRACTION_VERSION = "authors-literal-newline-split-v2"
export const BEAM_EVENT_ORDERING_SCORING_VERSION =
  "paper-table-tau-norm-primary-authors-f1-product-diagnostic-v1"

export interface BeamEventAlignmentAttempt {
  predictedIndex: number
  referenceIndex: number
  predictedEvent: string
  referenceEvent: string
  equivalent: boolean
}

export interface BeamEventAlignment {
  predictedIndex: number
  predictedEvent: string
  referenceIndex?: number
  referenceEvent?: string
}

export interface BeamEventRankItem {
  id: string
  kind: "reference" | "unmatched-prediction"
  referenceIndex?: number
  predictedIndex?: number
  event: string
}

export interface BeamEventRankVectors {
  union: BeamEventRankItem[]
  referenceRanks: number[]
  predictedRanks: number[]
  bottomTieRank: number
}

export interface KendallTauBResult {
  concordantPairs: number
  discordantPairs: number
  tiesOnlyInReference: number
  tiesOnlyInPrediction: number
  tiesInBoth: number
  denominator: number
  tauB: number
  degenerate: boolean
}

export interface BeamEventOrderingScore {
  referenceEvents: string[]
  predictedEvents: string[]
  canonicalPredictedEvents: string[]
  alignmentAttempts: BeamEventAlignmentAttempt[]
  alignments: BeamEventAlignment[]
  missingReferenceEvents: Array<{ referenceIndex: number; event: string }>
  unmatchedPredictedEvents: Array<{ predictedIndex: number; event: string }>
  rankVectors: BeamEventRankVectors
  kendall: KendallTauBResult
  normalizedKendallTauB: number
  matchedCount: number
  precision: number
  recall: number
  f1: number
  finalScore: number
}

export type BeamEventEquivalence = (input: {
  predictedIndex: number
  referenceIndex: number
  predictedEvent: string
  referenceEvent: string
}) => Promise<boolean>

export function extractBeamPredictedEvents(answer: string): string[] {
  // Exact authors' scorer semantics: llm_response.split("\n"). Blank lines,
  // surrounding whitespace, duplicates, and a trailing empty line all remain
  // score-bearing events.
  return answer.split("\n")
}

export async function alignBeamEvents(
  referenceEvents: readonly string[],
  predictedEvents: readonly string[],
  equivalent: BeamEventEquivalence
): Promise<{
  attempts: BeamEventAlignmentAttempt[]
  alignments: BeamEventAlignment[]
}> {
  const usedReferenceIndices = new Set<number>()
  const attempts: BeamEventAlignmentAttempt[] = []
  const alignments: BeamEventAlignment[] = []

  for (let predictedIndex = 0; predictedIndex < predictedEvents.length; predictedIndex++) {
    const predictedEvent = predictedEvents[predictedIndex]!
    let matchedReferenceIndex: number | undefined

    for (let referenceIndex = 0; referenceIndex < referenceEvents.length; referenceIndex++) {
      if (usedReferenceIndices.has(referenceIndex)) continue

      const referenceEvent = referenceEvents[referenceIndex]!
      const isEquivalent = await equivalent({
        predictedIndex,
        referenceIndex,
        predictedEvent,
        referenceEvent,
      })

      attempts.push({
        predictedIndex,
        referenceIndex,
        predictedEvent,
        referenceEvent,
        equivalent: isEquivalent,
      })

      if (isEquivalent) {
        matchedReferenceIndex = referenceIndex
        usedReferenceIndices.add(referenceIndex)
        break
      }
    }

    alignments.push({
      predictedIndex,
      predictedEvent,
      ...(matchedReferenceIndex === undefined
        ? {}
        : {
            referenceIndex: matchedReferenceIndex,
            referenceEvent: referenceEvents[matchedReferenceIndex]!,
          }),
    })
  }

  return { attempts, alignments }
}

export function buildBeamEventRankVectors(
  referenceEvents: readonly string[],
  predictedEvents: readonly string[],
  alignments: readonly BeamEventAlignment[]
): BeamEventRankVectors {
  if (alignments.length !== predictedEvents.length) {
    throw new Error(
      `Expected one event alignment per prediction (${predictedEvents.length}), got ${alignments.length}`
    )
  }

  const matchedPredictionByReference = new Map<number, number>()
  const alignmentByPrediction = new Map<number, BeamEventAlignment>()

  for (const alignment of alignments) {
    if (alignment.predictedIndex < 0 || alignment.predictedIndex >= predictedEvents.length) {
      throw new Error(`Invalid predicted event index: ${alignment.predictedIndex}`)
    }
    if (alignmentByPrediction.has(alignment.predictedIndex)) {
      throw new Error(`Predicted event ${alignment.predictedIndex} was aligned more than once`)
    }
    if (predictedEvents[alignment.predictedIndex] !== alignment.predictedEvent) {
      throw new Error(
        `Predicted event ${alignment.predictedIndex} content does not match alignment`
      )
    }
    alignmentByPrediction.set(alignment.predictedIndex, alignment)

    if (alignment.referenceIndex !== undefined) {
      if (alignment.referenceIndex < 0 || alignment.referenceIndex >= referenceEvents.length) {
        throw new Error(`Invalid reference event index: ${alignment.referenceIndex}`)
      }
      if (referenceEvents[alignment.referenceIndex] !== alignment.referenceEvent) {
        throw new Error(
          `Reference event ${alignment.referenceIndex} content does not match alignment`
        )
      }
      if (matchedPredictionByReference.has(alignment.referenceIndex)) {
        throw new Error(`Reference event ${alignment.referenceIndex} was matched more than once`)
      }
      matchedPredictionByReference.set(alignment.referenceIndex, alignment.predictedIndex)
    }
  }

  for (let predictedIndex = 0; predictedIndex < predictedEvents.length; predictedIndex++) {
    if (!alignmentByPrediction.has(predictedIndex)) {
      throw new Error(`Missing alignment for predicted event ${predictedIndex}`)
    }
  }

  const canonicalPredictedEvents = predictedEvents.map((predictedEvent, predictedIndex) => {
    const referenceIndex = alignmentByPrediction.get(predictedIndex)!.referenceIndex
    return referenceIndex === undefined ? predictedEvent : referenceEvents[referenceIndex]!
  })

  // Exact authors' event_ordering_score semantics:
  // union = list(dict.fromkeys(reference_canon + system_canon))
  // ranks = {item: i + 1 for i, item in enumerate(sequence)}
  // The union keeps the first duplicate, while the rank map keeps the last.
  const unionEvents = [...new Set([...referenceEvents, ...canonicalPredictedEvents])]
  const union: BeamEventRankItem[] = unionEvents.map((event) => {
    const referenceIndex = referenceEvents.indexOf(event)
    if (referenceIndex >= 0) {
      return { id: `reference:${referenceIndex}`, kind: "reference", referenceIndex, event }
    }
    const predictedIndex = canonicalPredictedEvents.indexOf(event)
    return {
      id: `prediction:${predictedIndex}`,
      kind: "unmatched-prediction",
      predictedIndex,
      event,
    }
  })

  const bottomTieRank = union.length + 1
  const toRanks = (sequence: readonly string[]) => {
    const ranks = new Map<string, number>()
    sequence.forEach((event, index) => ranks.set(event, index + 1))
    return unionEvents.map((event) => ranks.get(event) ?? bottomTieRank)
  }

  return {
    union,
    referenceRanks: toRanks(referenceEvents),
    predictedRanks: toRanks(canonicalPredictedEvents),
    bottomTieRank,
  }
}

export function computeKendallTauB(
  referenceRanks: readonly number[],
  predictedRanks: readonly number[]
): KendallTauBResult {
  if (referenceRanks.length !== predictedRanks.length) {
    throw new Error(
      `Kendall tau rank vectors must have equal length (${referenceRanks.length} !== ${predictedRanks.length})`
    )
  }
  if (
    referenceRanks.some((rank) => !Number.isFinite(rank)) ||
    predictedRanks.some((rank) => !Number.isFinite(rank))
  ) {
    throw new Error("Kendall tau rank vectors must contain only finite numbers")
  }

  let concordantPairs = 0
  let discordantPairs = 0
  let tiesOnlyInReference = 0
  let tiesOnlyInPrediction = 0
  let tiesInBoth = 0

  for (let left = 0; left < referenceRanks.length; left++) {
    for (let right = left + 1; right < referenceRanks.length; right++) {
      const referenceSign = Math.sign(referenceRanks[left]! - referenceRanks[right]!)
      const predictedSign = Math.sign(predictedRanks[left]! - predictedRanks[right]!)

      if (referenceSign === 0 && predictedSign === 0) {
        tiesInBoth++
      } else if (referenceSign === 0) {
        tiesOnlyInReference++
      } else if (predictedSign === 0) {
        tiesOnlyInPrediction++
      } else if (referenceSign === predictedSign) {
        concordantPairs++
      } else {
        discordantPairs++
      }
    }
  }

  const denominator = Math.sqrt(
    (concordantPairs + discordantPairs + tiesOnlyInReference) *
      (concordantPairs + discordantPairs + tiesOnlyInPrediction)
  )

  const degenerate = denominator === 0
  // scipy.stats.kendalltau (used by the pinned authors' evaluator) returns NaN
  // when tau-b has no denominator. Preserve that semantic here; the caller
  // fails closed instead of inventing a perfect or fully-incorrect score.
  const tauB = degenerate ? Number.NaN : (concordantPairs - discordantPairs) / denominator

  return {
    concordantPairs,
    discordantPairs,
    tiesOnlyInReference,
    tiesOnlyInPrediction,
    tiesInBoth,
    denominator,
    tauB,
    degenerate,
  }
}

export function scoreAlignedBeamEvents(input: {
  referenceEvents: readonly string[]
  predictedEvents: readonly string[]
  attempts?: readonly BeamEventAlignmentAttempt[]
  alignments: readonly BeamEventAlignment[]
}): BeamEventOrderingScore {
  const rankVectors = buildBeamEventRankVectors(
    input.referenceEvents,
    input.predictedEvents,
    input.alignments
  )
  const kendall = computeKendallTauB(rankVectors.referenceRanks, rankVectors.predictedRanks)
  if (!Number.isFinite(kendall.tauB)) {
    throw new Error(
      "BEAM paper Kendall tau-b is undefined for degenerate rank vectors; refusing to invent a score"
    )
  }
  const normalizedKendallTauB = (kendall.tauB + 1) / 2
  const canonicalPredictedEvents = input.predictedEvents.map((predictedEvent, predictedIndex) => {
    const alignment = input.alignments.find(
      (candidate) => candidate.predictedIndex === predictedIndex
    )
    return alignment?.referenceIndex === undefined
      ? predictedEvent
      : input.referenceEvents[alignment.referenceIndex]!
  })
  const referenceSet = new Set(input.referenceEvents)
  const predictedSet = new Set(canonicalPredictedEvents)
  const matchedCount = [...referenceSet].filter((event) => predictedSet.has(event)).length
  const falsePositiveCount = canonicalPredictedEvents.filter(
    (event) => !referenceSet.has(event)
  ).length
  const falseNegativeCount = input.referenceEvents.filter(
    (event) => !predictedSet.has(event)
  ).length
  const missingReferenceEvents = input.referenceEvents.flatMap((event, referenceIndex) =>
    predictedSet.has(event) ? [] : [{ referenceIndex, event }]
  )
  const unmatchedPredictedEvents = input.alignments.flatMap((alignment) =>
    alignment.referenceIndex === undefined
      ? [{ predictedIndex: alignment.predictedIndex, event: alignment.predictedEvent }]
      : []
  )
  const precision =
    matchedCount + falsePositiveCount > 0 ? matchedCount / (matchedCount + falsePositiveCount) : 0
  const recall =
    matchedCount + falseNegativeCount > 0 ? matchedCount / (matchedCount + falseNegativeCount) : 0
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0
  // The pinned authors helper calculates this product, but report_results.py
  // uses tau_norm for the published Table 1 value. Retain the product only as
  // an auditable diagnostic; the protocol selects the paper-table score.
  const finalScore = normalizedKendallTauB * f1

  return {
    referenceEvents: [...input.referenceEvents],
    predictedEvents: [...input.predictedEvents],
    canonicalPredictedEvents,
    alignmentAttempts: [...(input.attempts ?? [])],
    alignments: [...input.alignments],
    missingReferenceEvents,
    unmatchedPredictedEvents,
    rankVectors,
    kendall,
    normalizedKendallTauB,
    matchedCount,
    precision,
    recall,
    f1,
    finalScore,
  }
}

export async function evaluateBeamEventOrdering(input: {
  referenceEvents: readonly string[]
  predictedEvents: readonly string[]
  equivalent: BeamEventEquivalence
}): Promise<BeamEventOrderingScore> {
  const { attempts, alignments } = await alignBeamEvents(
    input.referenceEvents,
    input.predictedEvents,
    input.equivalent
  )

  return scoreAlignedBeamEvents({
    referenceEvents: input.referenceEvents,
    predictedEvents: input.predictedEvents,
    attempts,
    alignments,
  })
}
