import { describe, expect, test } from "bun:test"
import { buildJudgePrompt } from "./base"
import {
  ABSTENTION_JUDGE_PROMPT,
  DEFAULT_JUDGE_PROMPT,
  PREFERENCE_JUDGE_PROMPT,
  TEMPORAL_JUDGE_PROMPT,
} from "../prompts/defaults"
import { isAbstentionQuestionId } from "../benchmarks/longmemeval"

describe("isAbstentionQuestionId", () => {
  test("detects the LongMemEval abstention suffix", () => {
    expect(isAbstentionQuestionId("0862e8bf_abs")).toBe(true)
    expect(isAbstentionQuestionId("gpt4_372c3eed_abs")).toBe(true)
  })

  test("leaves answerable question ids alone", () => {
    expect(isAbstentionQuestionId("0862e8bf")).toBe(false)
    expect(isAbstentionQuestionId("gpt4_372c3eed")).toBe(false)
  })
})

describe("buildJudgePrompt", () => {
  const base = {
    question: "How many chapters of my hamster care book did I read?",
    groundTruth: "You did not mention this information. You mentioned your cat Luna.",
    hypothesis: "I don't know.",
  }

  test("uses the abstention rubric when the benchmark flags the question", () => {
    const prompt = buildJudgePrompt({
      ...base,
      questionType: "single-session-user",
      isAbstention: true,
    })

    expect(prompt).toContain(ABSTENTION_JUDGE_PROMPT)
    expect(prompt).toContain("Explanation: ")
    expect(prompt).not.toContain("Ground Truth Answer: ")
  })

  test("keeps exact-answer rubrics for answerable questions of the same type", () => {
    const prompt = buildJudgePrompt({ ...base, questionType: "single-session-user" })

    expect(prompt).toContain(DEFAULT_JUDGE_PROMPT)
    expect(prompt).toContain("Ground Truth Answer: ")
  })

  test("still routes abstention by question type for LoCoMo and ConvoMem", () => {
    expect(buildJudgePrompt({ ...base, questionType: "adversarial" })).toContain(
      ABSTENTION_JUDGE_PROMPT
    )
    expect(buildJudgePrompt({ ...base, questionType: "abstention_evidence" })).toContain(
      ABSTENTION_JUDGE_PROMPT
    )
  })

  test("does not disturb the other type-specific rubrics", () => {
    expect(buildJudgePrompt({ ...base, questionType: "temporal-reasoning" })).toContain(
      TEMPORAL_JUDGE_PROMPT
    )

    const preferencePrompt = buildJudgePrompt({
      ...base,
      questionType: "single-session-preference",
    })
    expect(preferencePrompt).toContain(PREFERENCE_JUDGE_PROMPT)
    expect(preferencePrompt).toContain("Rubric: ")
  })
})
