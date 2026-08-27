import { describe, expect, test } from "bun:test"
import {
  aggregateLongMemEvalV2,
  buildStrictJudgeMessages,
  evaluateDeterministicSpec,
  evaluateLongMemEvalV2,
  extractBoxedAnswer,
  isUnknownAnswer,
  multipleChoiceMatch,
  multipleChoiceSetMatch,
  normalizePhrase,
  normalizedPhraseSetMatch,
  normalizedPhraseSetMatchOrdered,
  parseEvaluationSpec,
  parseStrictJudgeResponse,
  splitPhrases,
  StrictJudgeError,
  type LongMemEvalV2AggregateRecord,
  type StrictJudgeRequest,
} from "./index"

describe("answer parsing", () => {
  test("uses the final box and supports nested braces", () => {
    expect(extractBoxedAnswer("first \\boxed{wrong}; final \\boxed{A {nested} value}")).toBe(
      "A {nested} value"
    )
  })

  test("falls back exactly like the reference parser", () => {
    expect(extractBoxedAnswer("  plain answer  ")).toBe("plain answer")
    expect(extractBoxedAnswer("prefix \\boxed{unfinished")).toBe("unfinished")
    expect(extractBoxedAnswer("prefix \\boxed{}")).toBe("prefix \\boxed{}")
  })

  test("UNKNOWN requires an exact case-insensitive answer", () => {
    expect(isUnknownAnswer(" UNKNOWN ")).toBeTrue()
    expect(isUnknownAnswer("unknown")).toBeTrue()
    expect(isUnknownAnswer("unknown because context is missing")).toBeFalse()
  })
})

describe("evaluation spec parsing and deterministic evaluators", () => {
  const phraseSpec =
    "norm_phrase_set_match|lower=true|normalize_hyphen=true|strip_punct=true|separators=,;|require_non_empty=true"

  test("parses every option form used by the dataset", () => {
    expect(parseEvaluationSpec(phraseSpec)).toEqual({
      name: "norm_phrase_set_match",
      options: {
        lower: true,
        normalize_hyphen: true,
        strip_punct: true,
        separators: [",", ";"],
        require_non_empty: true,
      },
    })
    expect(
      parseEvaluationSpec('norm_phrase_set_match|separators=["::",";"]|require_non_empty=false')
        .options
    ).toEqual({ separators: ["::", ";"], require_non_empty: false })
  })

  test("rejects empty, unknown, malformed, and duplicate specs", () => {
    expect(() => parseEvaluationSpec("")).toThrow("non-empty")
    expect(() => parseEvaluationSpec("not_a_real_evaluator")).toThrow("Unknown")
    expect(() => parseEvaluationSpec("mc_choice_match|broken")).toThrow("Invalid")
    expect(() =>
      parseEvaluationSpec("mc_choice_match|require_non_empty=true|require_non_empty=false")
    ).toThrow("Duplicate")
    expect(() => parseEvaluationSpec('norm_phrase_set_match|separators=[1,","]')).toThrow(
      "array of strings"
    )
  })

  test("normalizes punctuation, Unicode, hyphens, underscores, and whitespace", () => {
    expect(normalizePhrase("  CAFÉ_name—value; X-Y  ")).toBe("café namevalue x y")
    expect(splitPhrases("Alpha, beta;GAMMA", { separators: [",", ";"] })).toEqual([
      "alpha",
      "beta",
      "gamma",
    ])
    expect(splitPhrases(" Alpha, Beta ", { separators: [] })).toEqual(["alpha beta"])
  })

  test("normalized phrase-set match requires every whole phrase", () => {
    expect(normalizedPhraseSetMatch("Beta then alpha-value!", "alpha value; beta")).toBeTrue()
    expect(normalizedPhraseSetMatch("concatenate", "cat")).toBeFalse()
    expect(normalizedPhraseSetMatch("café menu", "café")).toBeTrue()
    expect(normalizedPhraseSetMatch("", "")).toBeFalse()
    expect(
      normalizedPhraseSetMatch("", "", {
        require_non_empty: false,
      })
    ).toBeTrue()
  })

  test("ordered phrase-set match preserves required order and repetition", () => {
    expect(normalizedPhraseSetMatchOrdered("first then second", "first;second")).toBeTrue()
    expect(normalizedPhraseSetMatchOrdered("second then first", "first;second")).toBeFalse()
    expect(normalizedPhraseSetMatchOrdered("one and one again", "one;one")).toBeTrue()
  })

  test("matches single-choice answers with official cleanup", () => {
    expect(multipleChoiceMatch("\\boxed{option b.}", "B")).toBeTrue()
    expect(multipleChoiceMatch("Choice A.", "a")).toBeTrue()
    expect(multipleChoiceMatch("The answer is A", "A")).toBeFalse()
    expect(multipleChoiceMatch("", "")).toBeFalse()
  })

  test("matches multi-choice letters as a set and ignores official filler words", () => {
    expect(multipleChoiceSetMatch("Final choices: C and A", "AC")).toBeTrue()
    expect(multipleChoiceSetMatch("A, A, C", "CA")).toBeTrue()
    expect(multipleChoiceSetMatch("A, B, C", "AC")).toBeFalse()
    expect(multipleChoiceSetMatch("", "")).toBeFalse()
  })

  test("dispatches all four deterministic evaluator names", () => {
    expect(
      evaluateDeterministicSpec(parseEvaluationSpec(phraseSpec), "Alpha beta", "alpha;beta")
    ).toBeTrue()
    expect(
      evaluateDeterministicSpec(
        parseEvaluationSpec("norm_phrase_set_match_ordered|separators=;|require_non_empty=true"),
        "alpha beta",
        "alpha;beta"
      )
    ).toBeTrue()
    expect(
      evaluateDeterministicSpec(
        parseEvaluationSpec("mc_choice_match|require_non_empty=true"),
        "option C.",
        "C"
      )
    ).toBeTrue()
    expect(
      evaluateDeterministicSpec(
        parseEvaluationSpec("mc_choice_set_match|require_non_empty=true"),
        "A and C",
        "CA"
      )
    ).toBeTrue()
  })
})

describe("strict LLM judge prompts and response parsing", () => {
  test("builds the strict abstention and gotcha prompts", () => {
    const common = {
      question: "Question text",
      referenceAnswer: "Reference text",
      modelFullResponse: "Full response",
      modelFinalAnswer: "Final answer",
    }
    const abstention = buildStrictJudgeMessages("llm_abstention_checker", common)
    expect(abstention.kind).toBe("abstention")
    expect(abstention.messages[0].content).toContain("flawed-premise")
    expect(abstention.messages[1].content).toContain("generic UNKNOWN")
    expect(abstention.messages[1].content).toContain("Question text")

    const gotcha = buildStrictJudgeMessages("llm_gotchas_checker", common)
    expect(gotcha.kind).toBe("gotcha")
    expect(gotcha.messages[0].content).toContain("at least one correct insight")
    expect(gotcha.messages[1].content).toContain("any point")
  })

  test("parses strict JSON, fenced JSON, embedded JSON, and JSON-like fallbacks", () => {
    expect(parseStrictJudgeResponse('{"label":1,"reason":"correct insight"}')).toEqual({
      label: 1,
      rationale: "correct insight",
    })
    expect(
      parseStrictJudgeResponse('```json\n{"label":"0","reason":"contradiction"}\n```')
    ).toEqual({ label: 0, rationale: "contradiction" })
    expect(parseStrictJudgeResponse('prefix {"label": 1, "reason": "ok"} suffix').label).toBe(1)
    expect(parseStrictJudgeResponse("{'label': 0, 'reason': 'bad json'}")).toEqual({
      label: 0,
      rationale: "{'label': 0, 'reason': 'bad json'}",
    })
    expect(parseStrictJudgeResponse("label = 1 because it matches").label).toBe(1)
  })

  test("rejects empty, non-binary, and unparseable judge responses", () => {
    expect(() => parseStrictJudgeResponse("")).toThrow("Empty")
    expect(() => parseStrictJudgeResponse('{"label":2,"reason":"invalid"}')).toThrow(
      "Could not parse"
    )
    expect(() => parseStrictJudgeResponse("looks good")).toThrow("Could not parse")
  })
})

describe("official evaluator dispatch and artifacts", () => {
  test("scores deterministic specs from the parsed boxed answer", async () => {
    const result = await evaluateLongMemEvalV2({
      questionId: "q-det",
      questionType: "static-environment",
      question: "Which values?",
      responseText: "Reasoning. \\boxed{Alpha; beta}",
      groundTruth: "alpha,beta",
      evalFunction:
        "norm_phrase_set_match|lower=true|normalize_hyphen=true|strip_punct=true|separators=,;|require_non_empty=true",
      createdAt: "2026-07-27T00:00:00.000Z",
    })
    expect(result.answer).toBe("Alpha; beta")
    expect(result.score).toBe(1)
    expect(result.label).toBe("correct")
    expect(result.request).toBeUndefined()
    expect(result.evaluatorFingerprint).toHaveLength(64)
  })

  test("forces exact UNKNOWN incorrect after official judge dispatch", async () => {
    let calls = 0
    const result = await evaluateLongMemEvalV2({
      questionId: "q-unknown",
      questionType: "static-environment-abs",
      question: "A flawed question",
      responseText: "\\boxed{UNKNOWN}",
      groundTruth: "The premise is wrong",
      evalFunction: "llm_abstention_checker|require_non_empty=true",
      judge: async () => {
        calls += 1
        return {
          text: '{"label":1,"reason":"judge label is overridden"}',
          rawResponse: { id: "unknown-judge-response" },
        }
      },
    })
    expect(calls).toBe(1)
    expect(result.score).toBe(0)
    expect(result.rationale).toContain("forced incorrect")
    expect(result.rawResponse).toEqual({ id: "unknown-judge-response" })
  })

  test("injects the strict judge and retains request, raw response, and rationale", async () => {
    let captured: StrictJudgeRequest | undefined
    const rawResponse = {
      id: "judge-response-1",
      choices: [{ message: { content: '{"label":1,"reason":"same core flaw"}' } }],
    }
    const result = await evaluateLongMemEvalV2({
      questionId: "q-abstention",
      questionType: "dynamic-environment-abs",
      question: "What impossible state occurred?",
      responseText: "The premise is inconsistent. \\boxed{No such state occurred}",
      groundTruth: "No such state occurred because the premise is inconsistent",
      evalFunction: "llm_abstention_checker|require_non_empty=true",
      evaluatorModel: "gpt-5.2",
      evaluatorSettings: {
        reasoningEffort: "medium",
        maxCompletionTokens: 2048,
      },
      judge: async (request) => {
        captured = request
        return {
          text: '{"label":1,"reason":"same core flaw"}',
          rawResponse,
        }
      },
    })
    expect(captured?.kind).toBe("abstention")
    expect(captured?.messages[1].content).toContain("No such state occurred")
    expect(result.score).toBe(1)
    expect(result.request?.model).toBe("gpt-5.2")
    expect(result.rawResponse).toEqual(rawResponse)
    expect(result.rationale).toBe("same core flaw")
  })

  test("dispatches the gotcha judge independently", async () => {
    const result = await evaluateLongMemEvalV2({
      questionId: "q-gotcha",
      questionType: "errors-gotchas",
      question: "What is the gotcha?",
      responseText: "\\boxed{The visible toggle is read-only}",
      groundTruth: "The toggle cannot be edited from this screen",
      evalFunction: "llm_gotchas_checker|require_non_empty=true",
      judge: async (request) => {
        expect(request.kind).toBe("gotcha")
        return { text: '{"label":0,"reason":"direction is wrong"}' }
      },
    })
    expect(result.score).toBe(0)
    expect(result.rationale).toBe("direction is wrong")
  })

  test("retains judge request and raw response on failures", async () => {
    try {
      await evaluateLongMemEvalV2({
        questionId: "q-bad-judge",
        questionType: "errors-gotchas",
        question: "What is the gotcha?",
        responseText: "A non-empty answer",
        groundTruth: "The reference",
        evalFunction: "llm_gotchas_checker|require_non_empty=true",
        judge: async () => ({
          text: "unparseable",
          rawResponse: { provider: "raw-unparseable" },
        }),
      })
      throw new Error("expected evaluateLongMemEvalV2 to throw")
    } catch (error) {
      expect(error).toBeInstanceOf(StrictJudgeError)
      const judgeError = error as StrictJudgeError
      expect(judgeError.request.kind).toBe("gotcha")
      expect(judgeError.rawResponse).toEqual({ provider: "raw-unparseable" })
    }
  })

  test("requires an injected callback and validates judge question categories", async () => {
    await expect(
      evaluateLongMemEvalV2({
        questionId: "q-missing",
        questionType: "procedure-abs",
        question: "Question",
        responseText: "Answer",
        groundTruth: "Reference",
        evalFunction: "llm_abstention_checker|require_non_empty=true",
      })
    ).rejects.toBeInstanceOf(StrictJudgeError)

    await expect(
      evaluateLongMemEvalV2({
        questionId: "q-wrong-category",
        questionType: "procedure",
        question: "Question",
        responseText: "Answer",
        groundTruth: "Reference",
        evalFunction: "llm_abstention_checker|require_non_empty=true",
        judge: async () => ({ text: '{"label":1,"reason":"x"}' }),
      })
    ).rejects.toThrow("-abs")
  })
})

describe("official aggregation", () => {
  const deterministic =
    "norm_phrase_set_match|lower=true|normalize_hyphen=true|strip_punct=true|separators=,;|require_non_empty=true"
  const records: LongMemEvalV2AggregateRecord[] = [
    {
      questionId: "static",
      questionType: "static-environment",
      evalFunction: deterministic,
      status: "completed",
      score: 1,
    },
    {
      questionId: "dynamic",
      questionType: "dynamic-environment",
      evalFunction: deterministic,
      status: "completed",
      score: 0,
    },
    {
      questionId: "procedure",
      questionType: "procedure",
      evalFunction: deterministic,
      status: "pending",
    },
    {
      questionId: "gotcha",
      questionType: "errors-gotchas",
      evalFunction: "llm_gotchas_checker|require_non_empty=true",
      status: "completed",
      score: 1,
    },
    {
      questionId: "static-abs",
      questionType: "static-environment-abs",
      evalFunction: "llm_abstention_checker|require_non_empty=true",
      status: "completed",
      score: 1,
    },
    {
      questionId: "dynamic-abs",
      questionType: "dynamic-environment-abs",
      evalFunction: "llm_abstention_checker|require_non_empty=true",
      status: "failed",
    },
    {
      questionId: "procedure-abs",
      questionType: "procedure-abs",
      evalFunction: "llm_abstention_checker|require_non_empty=true",
      status: "completed",
      score: 0,
      isUnknown: true,
    },
  ]

  test("uses every target question in the official denominator", () => {
    const aggregate = aggregateLongMemEvalV2(records)
    expect(aggregate.overall).toEqual({
      overall_full_set: 3 / 7,
      overall_non_abstention_only: 2 / 4,
      overall_abstention_only: 1 / 3,
      count_all_questions: 7,
      count_non_abstention: 4,
      count_abstention: 3,
    })
    expect(aggregate.execution).toEqual({
      completed: 5,
      failed: 1,
      pending: 1,
      blocked: 0,
    })
  })

  test("preserves category and abstention breakdown semantics", () => {
    const aggregate = aggregateLongMemEvalV2(records)
    expect(aggregate.non_abstention_by_category.static.pct_correct).toBe(1)
    expect(aggregate.non_abstention_by_category.dynamic.pct_answered_wrong).toBe(1)
    expect(aggregate.non_abstention_by_category.procedure.count_failed_or_incomplete).toBe(1)
    expect(aggregate.non_abstention_by_category.gotchas.pct_correct).toBe(1)
    expect(aggregate.abstention_overall).toEqual({
      count: 3,
      pct_correct: 1 / 3,
      pct_answered_wrong: 1 / 3,
      pct_unknown: 1 / 3,
      count_failed_or_incomplete: 1,
    })
    expect(aggregate.combined_abstention_by_category.static.pct_correct).toBe(1)
    expect(aggregate.combined_abstention_by_category.procedure.pct_unknown).toBe(0.5)
  })

  test("rejects invalid aggregate inputs", () => {
    expect(() => aggregateLongMemEvalV2([])).toThrow("No records")
    expect(() => aggregateLongMemEvalV2([records[0], records[0]])).toThrow("Duplicate")
    expect(() =>
      aggregateLongMemEvalV2([
        {
          questionId: "bad-type",
          questionType: "unknown-category",
          evalFunction: deterministic,
          status: "completed",
          score: 0,
        },
      ])
    ).toThrow("Unexpected question_type")
    expect(() =>
      aggregateLongMemEvalV2([
        {
          questionId: "missing-score",
          questionType: "static-environment",
          evalFunction: deterministic,
          status: "completed",
        },
      ])
    ).toThrow("missing a binary score")
  })
})
