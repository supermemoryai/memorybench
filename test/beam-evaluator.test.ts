import { describe, expect, test } from "bun:test"
import type {
  EvaluationRuntime,
  QuestionEvaluation,
  StructuredModelRequest,
} from "../src/types/protocol"
import type { JudgeInput, JudgeResult } from "../src/types/judge"
import type { UnifiedQuestion, UnifiedSearchResult } from "../src/types/unified"
import {
  BEAM_ABILITY_IDS,
  BEAM_EVENT_EQUIVALENCE_SCHEMA,
  BEAM_EVENT_ORDERING_SCORING_VERSION,
  BEAM_EVALUATOR_IDENTITY,
  BEAM_AGGREGATION_IMPLEMENTATION_SHA256,
  BEAM_STRUCTURED_OUTPUT_SCHEMA_SHA256,
  BEAM_NUGGET_JUDGMENT_SCHEMA,
  BEAM_PASS_THRESHOLD,
  BEAM_PAPER_PROTOCOL_VERSION,
  BEAM_RETRIEVAL_TOP_K_VALUES,
  BeamPaperProtocol,
  alignBeamEvents,
  computeKendallTauB,
  extractBeamPredictedEvents,
  scoreAlignedBeamEvents,
} from "../src/protocols/beam-paper"

class ScriptedRuntime implements EvaluationRuntime {
  readonly requests: StructuredModelRequest<unknown>[] = []
  private readonly outputs: unknown[]

  constructor(outputs: unknown[]) {
    this.outputs = [...outputs]
  }

  async evaluateLegacy(_input: JudgeInput): Promise<JudgeResult> {
    throw new Error("Legacy evaluation is not expected in BEAM tests")
  }

  async generateStructured<T>(request: StructuredModelRequest<T>): Promise<T> {
    this.requests.push(request as StructuredModelRequest<unknown>)
    if (this.outputs.length === 0) throw new Error("No scripted structured output remains")
    return request.schema.parse(this.outputs.shift())
  }
}

class ExactEventRuntime implements EvaluationRuntime {
  readonly requests: StructuredModelRequest<unknown>[] = []

  async evaluateLegacy(_input: JudgeInput): Promise<JudgeResult> {
    throw new Error("Legacy evaluation is not expected in BEAM tests")
  }

  async generateStructured<T>(request: StructuredModelRequest<T>): Promise<T> {
    this.requests.push(request as StructuredModelRequest<unknown>)
    const match = request.prompt.match(/^First snippet: ([\s\S]*) \n Second snippet: ([\s\S]*)$/u)
    if (!match) throw new Error(`Unexpected event prompt: ${request.prompt}`)
    return request.schema.parse({ answer: match[1] === match[2] ? "YES" : "NO" })
  }
}

function makeQuestion(
  input: {
    id?: string
    type?: string
    question?: string
    rubric?: unknown
    scale?: "1M" | "10M"
  } = {}
): UnifiedQuestion {
  return {
    questionId: input.id ?? "beam-1m-1-abstention-0",
    question: input.question ?? "What happened?",
    questionType: input.type ?? "abstention",
    groundTruth: "ground truth",
    haystackSessionIds: ["session-1"],
    metadata: {
      rubric: input.rubric ?? ["First nugget"],
      ...(input.scale ? { scale: input.scale } : {}),
    },
  }
}

function evaluateInput(question: UnifiedQuestion, hypothesis: string) {
  const protocol = new BeamPaperProtocol()
  return {
    protocol,
    input: {
      question,
      hypothesis,
      results: [],
      retrieval: protocol.createRetrievalPlan({ question }),
    },
  }
}

function makeEvaluation(question: UnifiedQuestion, score: number): QuestionEvaluation {
  return {
    questionId: question.questionId,
    questionType: question.questionType,
    primaryScore: score,
    passed: score >= BEAM_PASS_THRESHOLD,
    label: score >= BEAM_PASS_THRESHOLD ? "pass" : "fail",
    explanation: "fixture",
  }
}

describe("BEAM paper nugget evaluation", () => {
  test("preserves 0, 0.5, and 1 and averages without rounding", async () => {
    const question = makeQuestion({
      question: "Which requirements were met?",
      rubric: ["Nugget alpha", "Nugget beta", "Nugget gamma"],
    })
    const runtime = new ScriptedRuntime([
      { score: 0, reason: "absent" },
      { score: 0.5, reason: "partial" },
      { score: 1, reason: "complete" },
    ])
    const { protocol, input } = evaluateInput(question, "Model answer")

    const result = await protocol.evaluateQuestion(input, runtime)

    expect(result.primaryScore).toBe(0.5)
    expect(result.passed).toBe(true)
    expect(result.label).toBe("pass")
    expect(runtime.requests).toHaveLength(3)
    expect(runtime.requests.map((request) => request.schemaName)).toEqual([
      "beam_nugget_judgment",
      "beam_nugget_judgment",
      "beam_nugget_judgment",
    ])

    const prompts = runtime.requests.map((request) => request.prompt)
    expect(prompts[0]).toContain("Which requirements were met?")
    expect(prompts[0]).toContain("Nugget alpha")
    expect(prompts[0]).not.toContain("Nugget beta")
    expect(prompts[1]).toContain("Nugget beta")
    expect(prompts[1]).not.toContain("Nugget alpha")
    expect(prompts[2]).toContain("Model answer")

    const details = result.details as { nuggetJudgments: unknown[] }
    expect(details.nuggetJudgments).toEqual([
      { nugget: "Nugget alpha", score: 0, reason: "absent" },
      { nugget: "Nugget beta", score: 0.5, reason: "partial" },
      { nugget: "Nugget gamma", score: 1, reason: "complete" },
    ])
  })

  test("checkpoints every nugget and resumes without repeating paid judgments", async () => {
    const question = makeQuestion({ rubric: ["one", "two", "three"] })
    const first = evaluateInput(question, "answer")
    const firstRuntime = new ScriptedRuntime([{ score: 1, reason: "done one" }])
    let progress: Record<string, unknown> | undefined

    await expect(
      first.protocol.evaluateQuestion(
        {
          ...first.input,
          onProtocolProgress: async (next) => {
            progress = structuredClone(next)
          },
        },
        firstRuntime
      )
    ).rejects.toThrow("No scripted structured output remains")
    expect((progress?.judgments as unknown[]).length).toBe(1)

    const resumedRuntime = new ScriptedRuntime([
      { score: 0.5, reason: "done two" },
      { score: 0, reason: "done three" },
    ])
    const resumed = await first.protocol.evaluateQuestion(
      { ...first.input, protocolProgress: progress },
      resumedRuntime
    )

    expect(resumedRuntime.requests).toHaveLength(2)
    expect(resumed.primaryScore).toBe(0.5)
  })

  test("strict schemas reject clamped, missing, malformed, and extra output", () => {
    expect(BEAM_NUGGET_JUDGMENT_SCHEMA.safeParse({ score: 0.75, reason: "close" }).success).toBe(
      false
    )
    expect(BEAM_NUGGET_JUDGMENT_SCHEMA.safeParse({ score: 1 }).success).toBe(false)
    expect(BEAM_NUGGET_JUDGMENT_SCHEMA.safeParse({ score: "1", reason: "string" }).success).toBe(
      false
    )
    expect(
      BEAM_NUGGET_JUDGMENT_SCHEMA.safeParse({ score: 1, reason: "ok", extra: true }).success
    ).toBe(false)
    expect(BEAM_EVENT_EQUIVALENCE_SCHEMA.safeParse({ answer: "yes" }).success).toBe(false)
    expect(BEAM_EVENT_EQUIVALENCE_SCHEMA.safeParse({ answer: "YES" }).success).toBe(true)
  })

  test("fails closed on missing or malformed rubric metadata", async () => {
    const protocol = new BeamPaperProtocol()
    for (const rubric of [undefined, [], [""], ["valid", 1]]) {
      const question = makeQuestion({ rubric })
      if (rubric === undefined) question.metadata = {}
      expect(() => protocol.validateQuestion(question)).toThrow("non-empty string rubric")
    }
  })

  test("rejects a degenerate event-ordering rubric before any model call", () => {
    const protocol = new BeamPaperProtocol()
    const question = makeQuestion({
      id: "singleton-event-rubric",
      type: "event_ordering",
      rubric: ["Only one event"],
    })

    expect(() => protocol.validateQuestion(question)).toThrow(
      "at least two reference events for Kendall tau-b"
    )
  })
})

describe("BEAM paper event ordering", () => {
  test("scores perfect and reversed event sequences as 1 and 0", async () => {
    const question = makeQuestion({
      id: "event-question",
      type: "event_ordering",
      rubric: ["A", "B", "C"],
    })

    const perfect = evaluateInput(question, "A\nB\nC")
    const perfectResult = await perfect.protocol.evaluateQuestion(
      perfect.input,
      new ExactEventRuntime()
    )
    expect(perfectResult.primaryScore).toBe(1)
    expect(perfectResult.passed).toBe(true)

    const reversed = evaluateInput(question, "C\nB\nA")
    const reversedResult = await reversed.protocol.evaluateQuestion(
      reversed.input,
      new ExactEventRuntime()
    )
    expect(reversedResult.primaryScore).toBe(0)
    expect(reversedResult.passed).toBe(false)
  })

  test("checkpoints event-pair equivalence and reuses it after resume", async () => {
    const question = makeQuestion({
      id: "event-resume",
      type: "event_ordering",
      rubric: ["A", "B", "C"],
    })
    const first = evaluateInput(question, "A\nB\nC")
    let progress: Record<string, unknown> | undefined

    await expect(
      first.protocol.evaluateQuestion(
        {
          ...first.input,
          onProtocolProgress: async (next) => {
            progress = structuredClone(next)
          },
        },
        new ScriptedRuntime([{ answer: "YES" }])
      )
    ).rejects.toThrow("No scripted structured output remains")
    expect((progress?.judgments as unknown[]).length).toBe(1)

    const resumedRuntime = new ScriptedRuntime([{ answer: "YES" }, { answer: "YES" }])
    const resumed = await first.protocol.evaluateQuestion(
      { ...first.input, protocolProgress: progress },
      resumedRuntime
    )

    expect(resumedRuntime.requests).toHaveLength(2)
    expect(resumed.primaryScore).toBe(1)
  })

  test("uses the union rank vectors for partial and missing sequences", async () => {
    const question = makeQuestion({
      id: "partial-event-question",
      type: "event_ordering",
      rubric: ["A", "B", "C"],
    })
    const partial = evaluateInput(question, "A\nC")
    const result = await partial.protocol.evaluateQuestion(partial.input, new ExactEventRuntime())
    const event = (result.details as { eventOrdering: { rankVectors: unknown } }).eventOrdering as {
      rankVectors: { referenceRanks: number[]; predictedRanks: number[] }
      missingReferenceEvents: unknown[]
    }

    expect(result.primaryScore).toBeCloseTo(2 / 3, 12)
    expect(result.passed).toBe(true)
    expect(result.metrics?.normalizedKendallTauB).toBeCloseTo(2 / 3, 12)
    expect(result.metrics?.eventF1).toBeCloseTo(0.8, 12)
    expect(result.metrics?.authorsHelperFinalScore).toBeCloseTo(8 / 15, 12)
    expect(event.rankVectors.referenceRanks).toEqual([1, 2, 3])
    expect(event.rankVectors.predictedRanks).toEqual([1, 4, 2])
    expect(event.missingReferenceEvents).toEqual([{ referenceIndex: 1, event: "B" }])

    const oneMatched = scoreAlignedBeamEvents({
      referenceEvents: ["A", "B", "C"],
      predictedEvents: ["A"],
      alignments: [
        { predictedIndex: 0, predictedEvent: "A", referenceIndex: 0, referenceEvent: "A" },
      ],
    })
    expect(oneMatched.normalizedKendallTauB).toBeCloseTo(0.9082482904638631, 12)
    expect(oneMatched.f1).toBe(0.5)
    expect(oneMatched.finalScore).toBeCloseTo(0.45412414523193156, 12)
    expect(oneMatched.rankVectors.predictedRanks).toEqual([1, 4, 4])
  })

  test("keeps the authors helper F1 product diagnostic while Table 1 uses tau", async () => {
    const question = makeQuestion({
      id: "partial-precision-recall-event-question",
      type: "event_ordering",
      rubric: ["A", "B", "C"],
    })
    const value = evaluateInput(question, "A\nC\nX")
    const result = await value.protocol.evaluateQuestion(value.input, new ExactEventRuntime())

    expect(result.metrics?.normalizedKendallTauB).toBeCloseTo(2 / 3, 12)
    expect(result.metrics?.eventPrecision).toBeCloseTo(2 / 3, 12)
    expect(result.metrics?.eventRecall).toBeCloseTo(2 / 3, 12)
    expect(result.metrics?.eventF1).toBeCloseTo(2 / 3, 12)
    expect(result.metrics?.authorsHelperFinalScore).toBeCloseTo(4 / 9, 12)
    expect(result.primaryScore).toBeCloseTo(2 / 3, 12)
    expect(result.passed).toBe(true)

    const eventOrdering = (result.details as { eventOrdering: { finalScore: number } })
      .eventOrdering
    expect(eventOrdering.finalScore).toBeCloseTo(4 / 9, 12)
  })

  test("matches the authors' duplicate-line union and last-rank semantics", async () => {
    const { attempts, alignments } = await alignBeamEvents(
      ["A", "B"],
      ["A", "A", "B"],
      async ({ referenceEvent, predictedEvent }) => referenceEvent === predictedEvent
    )

    expect(attempts).toHaveLength(3)
    expect(alignments).toEqual([
      {
        predictedIndex: 0,
        predictedEvent: "A",
        referenceIndex: 0,
        referenceEvent: "A",
      },
      { predictedIndex: 1, predictedEvent: "A" },
      {
        predictedIndex: 2,
        predictedEvent: "B",
        referenceIndex: 1,
        referenceEvent: "B",
      },
    ])

    const score = scoreAlignedBeamEvents({
      referenceEvents: ["A", "B"],
      predictedEvents: ["A", "A", "B"],
      attempts,
      alignments,
    })
    expect(score.unmatchedPredictedEvents).toEqual([{ predictedIndex: 1, event: "A" }])
    expect(score.canonicalPredictedEvents).toEqual(["A", "A", "B"])
    expect(score.rankVectors.union.map((item) => item.id)).toEqual(["reference:0", "reference:1"])
    expect(score.rankVectors.predictedRanks).toEqual([2, 3])
    expect(score.normalizedKendallTauB).toBe(1)
    expect(score.f1).toBe(1)
    expect(score.finalScore).toBe(1)
  })

  test("matches the authors' literal newline split, including blank events", async () => {
    expect(extractBeamPredictedEvents("A\n\nB")).toEqual(["A", "", "B"])
    expect(extractBeamPredictedEvents("")).toEqual([""])

    const question = makeQuestion({
      id: "blank-event-question",
      type: "event_ordering",
      rubric: ["A", "B"],
    })
    const value = evaluateInput(question, "A\n\nB")
    const result = await value.protocol.evaluateQuestion(value.input, new ExactEventRuntime())
    expect(result.primaryScore).toBeCloseTo(2 / 3, 12)
    expect(result.metrics?.authorsHelperFinalScore).toBeCloseTo(8 / 15, 12)

    let progress: Record<string, unknown> | undefined
    await expect(
      value.protocol.evaluateQuestion(
        {
          ...value.input,
          onProtocolProgress: async (next) => {
            progress = structuredClone(next)
          },
        },
        new ScriptedRuntime([{ answer: "YES" }, { answer: "NO" }])
      )
    ).rejects.toThrow("No scripted structured output remains")
    expect(
      (progress!.judgments as Array<{ predictedEvent: string }>).some(
        (judgment) => judgment.predictedEvent === ""
      )
    ).toBe(true)

    const resumed = await value.protocol.evaluateQuestion(
      { ...value.input, protocolProgress: progress },
      new ScriptedRuntime([{ answer: "YES" }])
    )
    expect(resumed.primaryScore).toBeCloseTo(2 / 3, 12)
    expect(resumed.metrics?.authorsHelperFinalScore).toBeCloseTo(8 / 15, 12)
  })

  test("matches the authors' undefined tau-b edge and fails closed instead of inventing a score", () => {
    const identicalSingleton = computeKendallTauB([1], [1])
    expect(identicalSingleton.degenerate).toBe(true)
    expect(Number.isNaN(identicalSingleton.tauB)).toBe(true)

    expect(() =>
      scoreAlignedBeamEvents({
        referenceEvents: ["A", "B"],
        predictedEvents: [],
        alignments: [],
      })
    ).toThrow("undefined for degenerate rank vectors")
  })
})

describe("BEAM paper aggregation and identity", () => {
  test("reports fractional average and PASS-at-0.5 separately", () => {
    const protocol = new BeamPaperProtocol()
    const questions = [0, 1, 2].map((index) =>
      makeQuestion({ id: `q-${index}`, type: "abstention" })
    )
    const evaluations = [0, 0.5, 1].map((score, index) => makeEvaluation(questions[index]!, score))

    const report = protocol.aggregateQuality({ questions, evaluations })

    expect(report.primaryMetric).toEqual({
      key: "beamScorePartial",
      value: 0.5,
      higherIsBetter: true,
    })
    expect(report.metrics.passAccuracy).toBeCloseTo(2 / 3, 12)
    expect(report.bySlice?.abstention.averageScore).toBe(0.5)
    expect(report.bySlice?.abstention.passAccuracy).toBeCloseTo(2 / 3, 12)

    const boundaryQuestions = [0.499, 0.5].map((score) =>
      makeQuestion({ id: `boundary-${score}`, type: "abstention" })
    )
    const boundary = protocol.aggregateQuality({
      questions: boundaryQuestions,
      evaluations: boundaryQuestions.map((question, index) =>
        makeEvaluation(question, [0.499, 0.5][index]!)
      ),
    })
    expect(boundary.metrics.passAccuracy).toBe(0.5)
  })

  test("reports each tier independently and labels cross-tier macro aggregation", () => {
    const protocol = new BeamPaperProtocol()
    const questions: UnifiedQuestion[] = []
    const evaluations: QuestionEvaluation[] = []
    for (const ability of BEAM_ABILITY_IDS) {
      for (let index = 0; index < 2; index++) {
        const question = makeQuestion({
          id: `1m-${ability}-${index}`,
          type: ability,
          scale: "1M",
        })
        questions.push(question)
        evaluations.push(makeEvaluation(question, 1))
      }
      const question = makeQuestion({ id: `10m-${ability}`, type: ability, scale: "10M" })
      questions.push(question)
      evaluations.push(makeEvaluation(question, 0))
    }

    const report = protocol.aggregateQuality({ questions, evaluations })

    expect(report.primaryMetric).toBeUndefined()
    expect(report.metrics.beamScore1MPartial).toBe(1)
    expect(report.metrics.beamScore10MPartial).toBe(0)
    expect(report.metrics.beamTierMacroAverageSecondaryPartial).toBe(0.5)
    expect(report.metrics.beamAbilityPooledAverage).toBeCloseTo(2 / 3, 12)
    expect(report.metrics.beamQuestionMicroAverage).toBeCloseTo(2 / 3, 12)
    expect(report.bySlice?.["tier:1M"].averageScore).toBe(1)
    expect(report.bySlice?.["tier:10M"].averageScore).toBe(0)
    expect(report.bySlice?.["tier:1M/ability:abstention"].questionCount).toBe(2)
  })

  test("macro-averages the ten abilities instead of question-weighting", () => {
    const protocol = new BeamPaperProtocol()
    const questions: UnifiedQuestion[] = []
    const evaluations: QuestionEvaluation[] = []

    for (const ability of BEAM_ABILITY_IDS) {
      const count = ability === "abstention" ? 9 : 1
      const score = ability === "abstention" ? 1 : 0
      for (let index = 0; index < count; index++) {
        const question = makeQuestion({ id: `${ability}-${index}`, type: ability })
        questions.push(question)
        evaluations.push(makeEvaluation(question, score))
      }
    }

    const report = protocol.aggregateQuality({ questions, evaluations })

    expect(report.primaryMetric?.key).toBe("beamScorePartial")
    expect(report.primaryMetric?.value).toBeCloseTo(0.1, 12)
    expect(report.metrics.passAccuracy).toBe(0.5)
    expect(report.bySlice?.abstention.averageScore).toBe(1)
    expect(report.bySlice?.event_ordering.averageScore).toBe(0)
  })

  test("reserves the official beamScore key for a complete public tier", () => {
    const protocol = new BeamPaperProtocol()
    const questions: UnifiedQuestion[] = []
    const evaluations: QuestionEvaluation[] = []

    for (const ability of BEAM_ABILITY_IDS) {
      for (let index = 0; index < 70; index++) {
        const question = makeQuestion({
          id: `official-1m-${ability}-${index}`,
          type: ability,
          scale: "1M",
        })
        questions.push(question)
        evaluations.push(makeEvaluation(question, 0.75))
      }
    }

    const report = protocol.aggregateQuality({ questions, evaluations })
    expect(report.primaryMetric).toEqual({
      key: "beamScore",
      value: 0.75,
      higherIsBetter: true,
    })
    expect(report.metrics.beamScore1M).toBe(0.75)
    expect(report.metrics.officialQuestionSet1M).toBe(1)

    const partial = protocol.aggregateQuality({
      questions: questions.slice(0, 20),
      evaluations: evaluations.slice(0, 20),
    })
    expect(partial.primaryMetric?.key).toBe("beamScorePartial")
    expect(partial.metrics.beamScore1MPartial).toBe(0.75)
    expect(partial.metrics.officialQuestionSet1M).toBe(0)
  })

  test("defaults to Top-K 5, allows paper ablations, and fingerprints config", () => {
    const defaultProtocol = new BeamPaperProtocol()
    expect(defaultProtocol.retrievalTopK).toBe(5)
    expect(defaultProtocol.auxiliaryRetrievalEvaluation).toBe("disabled")
    expect(defaultProtocol.identity.version).toBe(BEAM_PAPER_PROTOCOL_VERSION)
    expect(BEAM_PAPER_PROTOCOL_VERSION).toBe("1.5.0")
    expect(BEAM_EVALUATOR_IDENTITY.eventOrderingScoringVersion).toBe(
      BEAM_EVENT_ORDERING_SCORING_VERSION
    )

    for (const topK of BEAM_RETRIEVAL_TOP_K_VALUES) {
      const protocol = new BeamPaperProtocol({ retrievalTopK: topK })
      const question = makeQuestion()
      const retrieval = protocol.createRetrievalPlan({ question })
      expect(retrieval).toMatchObject({
        requestedTopK: topK,
        answerCutoff: topK,
      })
      const results: UnifiedSearchResult[] = Array.from({ length: 25 }, (_, index) => ({
        id: `evidence-${index}`,
        rank: index + 1,
        text: `Evidence ${index}`,
        provider: "filesystem",
        resultType: "chunk",
      }))
      expect(
        protocol.createAnswerPlan({ question, sessions: [], results, retrieval })
          .answerEvidenceCount
      ).toBe(topK)
      expect(protocol.identity.evaluatorHash).toHaveLength(64)
      expect(protocol.identity.details?.evaluatorIdentity).toEqual(BEAM_EVALUATOR_IDENTITY)
    }

    expect(new BeamPaperProtocol({ retrievalTopK: 5 }).identity.configFingerprint).not.toBe(
      new BeamPaperProtocol({ retrievalTopK: 10 }).identity.configFingerprint
    )
    expect(BEAM_EVALUATOR_IDENTITY.nuggetPromptSha256).toBe(
      "5318eec79b7c650bbd532009636e67af066116b9a9d13dbad794c0850e1189dd"
    )
    expect(BEAM_EVALUATOR_IDENTITY.eventEquivalencePromptSha256).toBe(
      "3460ec68c19c6974d998b610af5143559748b02cd4a5273590a236646cd247ad"
    )
    expect(BEAM_AGGREGATION_IMPLEMENTATION_SHA256).toHaveLength(64)
    expect(BEAM_EVALUATOR_IDENTITY.structuredOutputSchemaSha256).toBe(
      BEAM_STRUCTURED_OUTPUT_SCHEMA_SHA256
    )
    expect(
      (
        new BeamPaperProtocol().identity.details?.aggregation as {
          implementationSha256: string
        }
      ).implementationSha256
    ).toBe(BEAM_AGGREGATION_IMPLEMENTATION_SHA256)
    expect(() => new BeamPaperProtocol({ retrievalTopK: 100 })).toThrow("must be one of")
  })

  test("fingerprints method-only protocol orchestration drift", () => {
    class ChangedAnswerPlanProtocol extends BeamPaperProtocol {
      override createAnswerPlan(input: Parameters<BeamPaperProtocol["createAnswerPlan"]>[0]) {
        return super.createAnswerPlan(input)
      }
    }

    const base = new BeamPaperProtocol()
    const changed = new ChangedAnswerPlanProtocol()
    expect(changed.identity.answerPromptHash).not.toBe(base.identity.answerPromptHash)
    expect(changed.identity.implementationFingerprint).not.toBe(
      base.identity.implementationFingerprint
    )
  })

  test("renders the approved BEAM session document without inventing a date", () => {
    const protocol = new BeamPaperProtocol()
    const question = makeQuestion()
    const withDate = protocol.createIngestionPlan({
      question,
      sessions: [
        {
          sessionId: "session-1",
          messages: [
            { role: "user", content: "Hello" },
            { role: "assistant", content: "Hi" },
          ],
          metadata: { date: "2024-03-01" },
        },
      ],
    })
    expect(withDate[0]).toEqual({
      customId: "session-1",
      content: "DOCUMENT_DATE: 2024-03-01\n\n[USER]\nHello\n\n[ASSISTANT]\nHi",
      metadata: { sessionId: "session-1", documentDate: "2024-03-01" },
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
      ],
    })

    const withoutDate = protocol.createIngestionPlan({
      question,
      sessions: [
        {
          sessionId: "session-2",
          messages: [
            { role: "user", content: "No date here" },
            { role: "assistant", content: "Acknowledged" },
          ],
        },
      ],
    })
    expect(withoutDate[0]?.content).toBe("[USER]\nNo date here\n\n[ASSISTANT]\nAcknowledged")
    expect(withoutDate[0]?.metadata).toEqual({ sessionId: "session-2" })

    expect(() =>
      protocol.createIngestionPlan({
        question,
        sessions: [
          {
            sessionId: "session-invalid-date",
            messages: [
              { role: "user", content: "Impossible date" },
              { role: "assistant", content: "Acknowledged" },
            ],
            metadata: { documentDate: "2024-02-30" },
          },
        ],
      })
    ).toThrow("invalid document date")

    expect(() =>
      protocol.createIngestionPlan({
        question,
        sessions: [
          {
            sessionId: "session-conflicting-dates",
            messages: [
              { role: "user", content: "Conflicting date" },
              { role: "assistant", content: "Acknowledged" },
            ],
            metadata: { documentDate: "2024-03-01", date: "2024-03-02" },
          },
        ],
      })
    ).toThrow("conflicting document dates")

    expect(() =>
      protocol.createIngestionPlan({
        question,
        sessions: [
          {
            sessionId: "session-malformed-date",
            messages: [
              { role: "user", content: "Malformed date" },
              { role: "assistant", content: "Acknowledged" },
            ],
            metadata: { documentDate: "March 1, 2024" },
          },
        ],
      })
    ).toThrow("invalid document date")

    expect(() =>
      protocol.createIngestionPlan({
        question,
        sessions: [
          {
            sessionId: "session-orphan-user",
            messages: [{ role: "user", content: "Missing assistant" }],
          },
        ],
      })
    ).toThrow("exactly one non-empty user message followed by one non-empty assistant message")

    for (const messages of [
      [
        { role: "assistant", content: "Wrong role" },
        { role: "user", content: "Wrong role" },
      ],
      [
        { role: "user", content: "One" },
        { role: "assistant", content: "Two" },
        { role: "assistant", content: "Extra" },
      ],
      [
        { role: "user", content: "   " },
        { role: "assistant", content: "Two" },
      ],
      [
        { role: "user", content: 42 },
        { role: "assistant", content: "Two" },
      ],
    ]) {
      expect(() =>
        protocol.createIngestionPlan({
          question,
          sessions: [{ sessionId: "session-malformed-turns", messages } as never],
        })
      ).toThrow("exactly one non-empty user message followed by one non-empty assistant message")
    }
  })

  test("formats only normalized evidence text and preserves result-level dates", () => {
    const protocol = new BeamPaperProtocol()
    const question = makeQuestion()
    const retrieval = protocol.createRetrievalPlan({ question })
    const plan = protocol.createAnswerPlan({
      question,
      sessions: [],
      retrieval,
      results: [
        {
          id: "result-1",
          rank: 1,
          text: "Normalized evidence text",
          provider: "fake",
          resultType: "chunk",
          documentDate: "2024-05-06",
          rawArtifactRef: "raw/result-1.json",
        },
      ],
    })

    expect(plan.answerEvidenceCount).toBe(1)
    expect(plan.request.prompt).toContain("[2024-05-06] Normalized evidence text")
    expect(plan.request.prompt).not.toContain("raw/result-1.json")
    expect(plan.request.prompt).not.toContain('"resultType"')
  })

  test("makes the authors' newline event scorer contract explicit only for event answers", () => {
    const protocol = new BeamPaperProtocol()
    const eventQuestion = makeQuestion({
      id: "event-answer-format",
      type: "event_ordering",
      rubric: ["First event", "Second event"],
    })
    const eventRetrieval = protocol.createRetrievalPlan({ question: eventQuestion })
    const eventPlan = protocol.createAnswerPlan({
      question: eventQuestion,
      sessions: [],
      results: [],
      retrieval: eventRetrieval,
    })
    expect(eventPlan.request.prompt).toContain("output exactly one event per line")
    expect(eventPlan.request.prompt).toContain("Do not use bullets, numbering, headings")
    expect(eventPlan.baseRequest.prompt).toContain("output exactly one event per line")

    const nuggetQuestion = makeQuestion({ id: "ordinary-answer-format", type: "abstention" })
    const nuggetPlan = protocol.createAnswerPlan({
      question: nuggetQuestion,
      sessions: [],
      results: [],
      retrieval: protocol.createRetrievalPlan({ question: nuggetQuestion }),
    })
    expect(nuggetPlan.request.prompt).not.toContain("output exactly one event per line")

    const answerIdentity = protocol.identity.details?.answerPrompt as {
      eventOrderingAnswerFormatVersion: string
      eventOrderingPromptSha256: string
    }
    expect(answerIdentity.eventOrderingAnswerFormatVersion).toBe(
      "authors-newline-scorer-compatible-v1"
    )
    expect(answerIdentity.eventOrderingPromptSha256).toMatch(/^[a-f0-9]{64}$/)
  })
})
