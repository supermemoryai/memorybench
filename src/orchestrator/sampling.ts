import type { SamplingConfig } from "../types/checkpoint"

/** The only question fields sampling needs. */
export interface SelectableQuestion {
  questionId: string
  questionType: string
}

export interface SamplingSelection {
  /** Question IDs to run, in selection order. */
  questionIds: string[]
  /** The seed actually used, present only when the selection was randomised. */
  seed?: number
}

const UINT32 = 0x100000000

/**
 * mulberry32: a small PRNG with 32 bits of state, deterministic for a given
 * seed. Determinism is the point — a sampled run records its seed, so the same
 * subset can be re-selected later or handed to another provider.
 */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / UINT32
  }
}

/** A fresh seed for a run that did not ask for a specific one. */
export function randomSeed(): number {
  return Math.floor(Math.random() * UINT32)
}

/**
 * Fisher–Yates: every permutation equally likely.
 *
 * `[...arr].sort(() => Math.random() - 0.5)` is not a shuffle. The comparator
 * ignores its arguments, which violates the consistency `sort` requires, so the
 * permutation depends on the engine's sort algorithm and leaves elements near
 * their original positions far more often than chance. For a sampler that then
 * takes the first N, that bias lands squarely on the selected slice.
 */
export function shuffle<T>(items: readonly T[], rand: () => number = Math.random): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * Resolve a sampling config into the concrete set of questions to run.
 *
 * Shared by the single-run orchestrator and the batch comparison path so both
 * select identically — the two had drifting copies of this logic.
 */
export function selectQuestionsBySampling(
  allQuestions: SelectableQuestion[],
  sampling: SamplingConfig
): SamplingSelection {
  if (sampling.mode === "full") {
    return { questionIds: allQuestions.map((q) => q.questionId) }
  }

  if (sampling.mode === "limit" && sampling.limit) {
    return { questionIds: allQuestions.slice(0, sampling.limit).map((q) => q.questionId) }
  }

  if (sampling.mode === "sample" && sampling.perCategory) {
    // A Map keeps insertion order for every key; a plain object would reorder
    // integer-like question types ahead of the rest.
    const byType = new Map<string, SelectableQuestion[]>()
    for (const q of allQuestions) {
      const bucket = byType.get(q.questionType)
      if (bucket) bucket.push(q)
      else byType.set(q.questionType, [q])
    }

    // One generator across all categories, so the seed reproduces the selection
    // as a whole rather than each category in isolation.
    const seed = sampling.sampleType === "random" ? (sampling.seed ?? randomSeed()) : undefined
    const rand = seed === undefined ? undefined : createSeededRandom(seed)

    const questionIds: string[] = []
    for (const questions of byType.values()) {
      const ordered = rand ? shuffle(questions, rand) : questions
      questionIds.push(...ordered.slice(0, sampling.perCategory).map((q) => q.questionId))
    }
    return { questionIds, seed }
  }

  return { questionIds: allQuestions.map((q) => q.questionId) }
}
