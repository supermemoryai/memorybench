import { describe, expect, test } from "bun:test"
import type { SamplingConfig } from "../types/checkpoint"
import {
  createSeededRandom,
  selectQuestionsBySampling,
  shuffle,
  type SelectableQuestion,
} from "./sampling"

const TRIALS = 12000
const PERMUTATION_SIZE = 6
const EXPECTED_PER_CELL = TRIALS / PERMUTATION_SIZE // 2000

// ±150 is ~3.7 standard deviations for this many trials (σ ≈ 41), and the seeded
// runs below are deterministic, so this cannot flake.
const TOLERANCE = 150

const BASE = [0, 1, 2, 3, 4, 5]

/**
 * counts[element][position] over many trials. A uniform shuffle puts every
 * element in every position equally often.
 */
function positionCounts(permute: (trial: number) => number[]): number[][] {
  const counts = Array.from({ length: PERMUTATION_SIZE }, () => new Array(PERMUTATION_SIZE).fill(0))
  for (let trial = 0; trial < TRIALS; trial++) {
    const permuted = permute(trial)
    for (let position = 0; position < PERMUTATION_SIZE; position++) {
      counts[permuted[position]][position]++
    }
  }
  return counts
}

function maxDeviation(counts: number[][]): number {
  return Math.max(...counts.flat().map((c) => Math.abs(c - EXPECTED_PER_CELL)))
}

function questions(spec: Record<string, number>): SelectableQuestion[] {
  const out: SelectableQuestion[] = []
  for (const [questionType, count] of Object.entries(spec)) {
    for (let i = 0; i < count; i++) {
      out.push({ questionId: `${questionType}-${i}`, questionType })
    }
  }
  return out
}

const sample = (overrides: Partial<SamplingConfig> = {}): SamplingConfig => ({
  mode: "sample",
  sampleType: "random",
  perCategory: 3,
  ...overrides,
})

describe("shuffle", () => {
  test("returns a permutation and leaves the input untouched", () => {
    const input = [...BASE]
    const result = shuffle(input, createSeededRandom(7))

    expect([...result].sort()).toEqual(BASE)
    expect(input).toEqual(BASE)
    expect(result).not.toBe(input)
  })

  test("places every element in every position equally often", () => {
    const counts = positionCounts((trial) => shuffle(BASE, createSeededRandom(trial + 1)))

    expect(maxDeviation(counts)).toBeLessThan(TOLERANCE)
  })

  test("the `sort(() => Math.random() - 0.5)` it replaces is measurably biased", () => {
    // The defect this module exists to fix, kept as a characterisation test: the
    // comparator ignores its arguments, so elements stay near their original
    // positions far more often than chance. Deviations here run past 1000 —
    // 25x the standard deviation of a genuine shuffle — while a uniform shuffle
    // clears TOLERANCE above.
    const counts = positionCounts(() => [...BASE].sort(() => Math.random() - 0.5))

    expect(maxDeviation(counts)).toBeGreaterThan(300)
  })

  test("handles empty and single-element inputs", () => {
    expect(shuffle([], createSeededRandom(1))).toEqual([])
    expect(shuffle(["only"], createSeededRandom(1))).toEqual(["only"])
  })
})

describe("createSeededRandom", () => {
  test("is reproducible for a given seed and differs across seeds", () => {
    const first = Array.from({ length: 5 }, createSeededRandom(99))
    const again = Array.from({ length: 5 }, createSeededRandom(99))
    const other = Array.from({ length: 5 }, createSeededRandom(100))

    expect(again).toEqual(first)
    expect(other).not.toEqual(first)
  })

  test("stays within [0, 1)", () => {
    const rand = createSeededRandom(12345)
    for (let i = 0; i < 5000; i++) {
      const value = rand()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })
})

describe("selectQuestionsBySampling", () => {
  const pool = questions({ "single-session": 8, "multi-session": 8, temporal: 8 })

  test("full mode selects every question in order", () => {
    const selection = selectQuestionsBySampling(pool, { mode: "full" })

    expect(selection.questionIds).toEqual(pool.map((q) => q.questionId))
    expect(selection.seed).toBeUndefined()
  })

  test("limit mode takes the first N overall", () => {
    const selection = selectQuestionsBySampling(pool, { mode: "limit", limit: 4 })

    expect(selection.questionIds).toEqual([
      "single-session-0",
      "single-session-1",
      "single-session-2",
      "single-session-3",
    ])
  })

  test("consecutive sampling takes the first N of each category and needs no seed", () => {
    const selection = selectQuestionsBySampling(
      pool,
      sample({ sampleType: "consecutive", perCategory: 2 })
    )

    expect(selection.questionIds).toEqual([
      "single-session-0",
      "single-session-1",
      "multi-session-0",
      "multi-session-1",
      "temporal-0",
      "temporal-1",
    ])
    expect(selection.seed).toBeUndefined()
  })

  test("random sampling takes N per category without duplicates", () => {
    const selection = selectQuestionsBySampling(pool, sample({ seed: 2024 }))

    expect(selection.questionIds).toHaveLength(9)
    expect(new Set(selection.questionIds).size).toBe(9)
    for (const type of ["single-session", "multi-session", "temporal"]) {
      expect(selection.questionIds.filter((id) => id.startsWith(type))).toHaveLength(3)
    }
  })

  test("the same seed reproduces the same subset in the same order", () => {
    const first = selectQuestionsBySampling(pool, sample({ seed: 2024 }))
    const again = selectQuestionsBySampling(pool, sample({ seed: 2024 }))

    expect(again.questionIds).toEqual(first.questionIds)
    expect(again.seed).toBe(2024)
  })

  test("a different seed selects a different subset", () => {
    const first = selectQuestionsBySampling(pool, sample({ seed: 1 }))
    const other = selectQuestionsBySampling(pool, sample({ seed: 2 }))

    expect(other.questionIds).not.toEqual(first.questionIds)
  })

  test("generates and reports a seed when none is supplied", () => {
    const selection = selectQuestionsBySampling(pool, sample())

    expect(selection.seed).toBeDefined()
    expect(Number.isInteger(selection.seed)).toBe(true)

    // The reported seed is enough to reproduce the run.
    const replayed = selectQuestionsBySampling(pool, sample({ seed: selection.seed }))
    expect(replayed.questionIds).toEqual(selection.questionIds)
  })

  test("random sampling reaches questions beyond the first N of a category", () => {
    // The bias this fixes showed up as the front of each category being selected
    // far more often than the tail. Across seeds, every question should be
    // reachable.
    const seen = new Set<string>()
    for (let seed = 0; seed < 200; seed++) {
      for (const id of selectQuestionsBySampling(pool, sample({ seed })).questionIds) {
        seen.add(id)
      }
    }

    expect(seen.size).toBe(pool.length)
  })

  test("takes the whole category when it holds fewer than perCategory questions", () => {
    const small = questions({ rare: 2 })
    const selection = selectQuestionsBySampling(small, sample({ perCategory: 5, seed: 3 }))

    expect(selection.questionIds.sort()).toEqual(["rare-0", "rare-1"])
  })

  test("keeps category order stable for integer-like question types", () => {
    // A plain object would hand back "1" before "10"; insertion order is what
    // callers see for consecutive sampling.
    const numeric = [
      { questionId: "b", questionType: "10" },
      { questionId: "a", questionType: "1" },
    ]
    const selection = selectQuestionsBySampling(
      numeric,
      sample({ sampleType: "consecutive", perCategory: 1 })
    )

    expect(selection.questionIds).toEqual(["b", "a"])
  })
})
