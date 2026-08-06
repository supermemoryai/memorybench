import { describe, expect, test } from "bun:test"
import type { JudgeInput, JudgeResult } from "../src/types/judge"
import type {
  EvaluationRuntime,
  QuestionEvaluation,
  StructuredModelRequest,
} from "../src/types/protocol"
import type { UnifiedQuestion, UnifiedSearchResult, UnifiedSession } from "../src/types/unified"
import { OpenAIJudge } from "../src/judges/openai"
import { BeamPaperProtocol } from "../src/protocols/beam-paper"
import { parseRunArgs } from "../src/cli/commands/run"
import {
  BEAM_MEM0_JUDGE_SYSTEM_PROMPT,
  BEAM_MEM0_NUGGET_PROFILE,
  BeamMem0NuggetProtocol,
  clampMem0NuggetScore,
} from "../src/protocols/beam-mem0"

class ScriptedRuntime implements EvaluationRuntime {
  readonly requests: StructuredModelRequest<unknown>[] = []

  constructor(private readonly outputs: unknown[]) {}

  async evaluateLegacy(_input: JudgeInput): Promise<JudgeResult> {
    throw new Error("Legacy evaluation is not expected")
  }

  async generateStructured<T>(request: StructuredModelRequest<T>): Promise<T> {
    this.requests.push(request as StructuredModelRequest<unknown>)
    const output = this.outputs.shift()
    if (output === undefined) throw new Error("No scripted output remains")
    return request.schema.parse(output)
  }
}

function eventQuestion(id = "event-question"): UnifiedQuestion {
  return {
    questionId: id,
    question: "In what order did the events happen?",
    questionType: "event_ordering",
    groundTruth: "Alpha then beta",
    haystackSessionIds: ["s1"],
    metadata: { rubric: ["Alpha happened", "Beta happened"], scale: "1M" },
  }
}

const sessions: UnifiedSession[] = [
  {
    sessionId: "s1",
    messages: [
      { role: "user", content: "Alpha happened." },
      { role: "assistant", content: "Then beta happened." },
    ],
    metadata: { documentDate: "2024-01-01" },
  },
]

describe("BEAM mem0 nugget comparison profile", () => {
  test("parses the explicit comparison and source-reuse CLI identity", () => {
    const parsed = parseRunArgs([
      "-p",
      "supermemory",
      "-b",
      "beam-1m",
      "-r",
      "target",
      "--source-run",
      "source",
      "--from-phase",
      "search",
      "--evaluation-profile",
      "mem0-nugget",
      "--retrieval-top-k",
      "50",
      "--answer-cutoff",
      "50",
      "-m",
      "gpt-5",
      "-j",
      "gpt-5",
    ])

    expect(parsed).toMatchObject({
      provider: "supermemory",
      benchmark: "beam-1m",
      runId: "target",
      sourceRunId: "source",
      fromPhase: "search",
      evaluationProfile: "mem0-nugget",
      retrievalTopK: 50,
      answerCutoff: 50,
      answeringModel: "gpt-5",
      judgeModel: "gpt-5",
    })
  })

  test("is isolated from the paper protocol while sharing its exact ingestion contract", () => {
    const paper = new BeamPaperProtocol()
    const comparison = new BeamMem0NuggetProtocol({ retrievalTopK: 50, answerCutoff: 50 })
    const question = eventQuestion()

    expect(comparison.identity.id).toBe("beam-mem0-nugget")
    expect(comparison.identity.version).toBe("1.2.0")
    expect(comparison.identity.details?.comparisonProfile).toBe(BEAM_MEM0_NUGGET_PROFILE)
    expect(comparison.identity.details?.evaluatorIdentity).toMatchObject({
      sourceCommit: "4b61c5d31b9c668a12b4f5e78064248a02c82d2b",
      judgeModel: "gpt-5",
      eventOrderingPolicy: "ordinary-nugget-average-primary",
      temperature: null,
      maxOutputTokens: 4096,
      maxAttempts: 5,
      innerMaxRetries: 2,
      timeoutMs: 120_000,
      retryBackoffMs: 2_000,
      transport: "openai-chat-completions",
      runtimeExecutionVersion: "chat-transport-outer-retry-v1",
      parseFallback: "none-fail-closed-deviation-from-mem0-raw-text-marker-fallback",
    })
    expect(comparison.identity.details?.answerPrompt).toMatchObject({
      innerMaxRetries: 2,
      terminalEmptyOutputPolicy: "accept-and-evaluate",
      runtimeExecutionVersion: "chat-transport-durable-outer-retry-v1",
    })
    expect(comparison.identity.ingestionPolicyHash).toBe(paper.identity.ingestionPolicyHash)
    expect(comparison.createIngestionPlan({ question, sessions })).toEqual(
      paper.createIngestionPlan({ question, sessions })
    )
    expect(comparison.requiredJudge).toEqual({
      provider: "openai",
      modelId: "gpt-5",
      modelAlias: "gpt-5",
    })
    expect(comparison.createRetrievalPlan({ question })).toMatchObject({
      requestedTopK: 50,
      answerCutoff: 50,
      threshold: 0,
    })
    expect(() => new BeamPaperProtocol({ retrievalTopK: 50 })).toThrow("must be one of")
  })

  test("uses the mem0 answer format without the paper event-line rule", () => {
    const protocol = new BeamMem0NuggetProtocol({ retrievalTopK: 50, answerCutoff: 1 })
    const question = eventQuestion()
    const results: UnifiedSearchResult[] = [
      {
        id: "m1",
        rank: 1,
        text: "Alpha happened and beta followed.",
        sessionId: "s1",
        documentDate: "2024-01-01",
        provider: "supermemory",
        resultType: "memory",
      },
    ]
    const plan = protocol.createAnswerPlan({
      question,
      sessions,
      results,
      retrieval: protocol.createRetrievalPlan({ question }),
    })

    expect(plan.answerEvidenceCount).toBe(1)
    expect(plan.request).toMatchObject({
      maxOutputTokens: 4096,
      transport: "openai-chat-completions",
      maxAttempts: 5,
      innerMaxRetries: 2,
      timeoutMs: 120_000,
      retryBackoffMs: 2_000,
      terminalEmptyOutputPolicy: "accept-and-evaluate",
    })
    expect(plan.request.prompt).toContain("[2024-01-01] Alpha happened and beta followed.")
    expect(plan.request.prompt).not.toContain("output exactly one event per line")

    const paperPlan = new BeamPaperProtocol().createAnswerPlan({
      question,
      sessions,
      results,
      retrieval: new BeamPaperProtocol().createRetrievalPlan({ question }),
    })
    expect(paperPlan.request.terminalEmptyOutputPolicy).toBeUndefined()
  })

  test("scores event ordering only through mem0 nugget averages and clamps arbitrary numbers", async () => {
    const protocol = new BeamMem0NuggetProtocol({ retrievalTopK: 50, answerCutoff: 50 })
    const question = eventQuestion()
    const runtime = new ScriptedRuntime([
      { score: 0.74, reason: "partial" },
      { score: 0.75, reason: "complete" },
    ])

    const evaluation = await protocol.evaluateQuestion(
      {
        question,
        hypothesis: "Beta happened before alpha.",
        results: [],
        retrieval: protocol.createRetrievalPlan({ question }),
      },
      runtime
    )

    expect(evaluation.primaryScore).toBe(0.75)
    expect(evaluation.metrics).toEqual({ nuggetAverage: 0.75, nuggetCount: 2 })
    expect(evaluation.details).toMatchObject({ eventOrderingScoreUsed: 0 })
    expect(runtime.requests).toHaveLength(2)
    expect(
      runtime.requests.every((request) => request.system === BEAM_MEM0_JUDGE_SYSTEM_PROMPT)
    ).toBe(true)
    expect(runtime.requests.every((request) => request.temperature === undefined)).toBe(true)
    expect(runtime.requests.every((request) => request.maxOutputTokens === 4096)).toBe(true)
    expect(runtime.requests.every((request) => request.maxAttempts === 5)).toBe(true)
    expect(runtime.requests.every((request) => request.innerMaxRetries === 2)).toBe(true)
    expect(runtime.requests.every((request) => request.timeoutMs === 120_000)).toBe(true)
    expect(runtime.requests.every((request) => request.retryBackoffMs === 2_000)).toBe(true)
    expect(
      runtime.requests.every((request) => request.transport === "openai-chat-completions")
    ).toBe(true)
    expect(
      runtime.requests.every((request) => request.schemaName === "beam_mem0_nugget_judgment")
    ).toBe(true)
  })

  test("judges an explicitly accepted empty hypothesis instead of skipping it", async () => {
    const protocol = new BeamMem0NuggetProtocol()
    const question = eventQuestion("empty-answer")
    const runtime = new ScriptedRuntime([
      { score: 0, reason: "missing" },
      { score: 0, reason: "missing" },
    ])

    const evaluation = await protocol.evaluateQuestion(
      {
        question,
        hypothesis: "",
        results: [],
        retrieval: protocol.createRetrievalPlan({ question }),
      },
      runtime
    )

    expect(evaluation.primaryScore).toBe(0)
    expect(runtime.requests).toHaveLength(2)
    expect(runtime.requests.every((request) => request.prompt.includes("LLM RESPONSE:\n\n"))).toBe(
      true
    )
  })

  test("reports the question-micro nugget average as its distinct primary metric", () => {
    const protocol = new BeamMem0NuggetProtocol()
    const questions = [
      eventQuestion("event"),
      { ...eventQuestion("abstain"), questionType: "abstention" },
    ]
    const evaluations: QuestionEvaluation[] = questions.map((question, index) => ({
      questionId: question.questionId,
      questionType: question.questionType,
      primaryScore: index === 0 ? 0.5 : 1,
      passed: true,
      explanation: "fixture",
    }))

    const quality = protocol.aggregateQuality({ questions, evaluations })
    expect(quality.primaryMetric).toEqual({
      key: "mem0NuggetAverage",
      value: 0.75,
      higherIsBetter: true,
    })
    expect(quality.metrics.mem0NuggetAverage).toBe(0.75)
  })

  test("matches mem0 clamp thresholds", () => {
    expect([0.1, 0.25, 0.74, 0.75, 3].map(clampMem0NuggetScore)).toEqual([0, 0.5, 0.5, 1, 1])
  })

  test("selects OpenAI Chat Completions for the pinned mem0 judge transport", async () => {
    const judge = new OpenAIJudge()
    await judge.initialize({ apiKey: "test-key", model: "gpt-5" })
    const model = judge.getModel("openai-chat-completions")

    expect(model.provider).toBe("openai.chat")
    expect(model.modelId).toBe("gpt-5")
  })
})
