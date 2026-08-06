import { z } from "zod"
import {
  ANSWER_RUNTIME_EXECUTION_VERSION,
  generateAnswerWithRetries,
  getLanguageModel,
  runAnswerPhase,
  shouldRunAnswerPhase,
} from "../../orchestrator/phases/answer"
import {
  STRUCTURED_RUNTIME_EXECUTION_VERSION,
  executeStructuredWithRetries,
  generateStructuredObject,
} from "../../orchestrator/evaluation-runtime"
import { hasEvaluableAnswer, runEvaluatePhase } from "../../orchestrator/phases/evaluate"
import { buildBeamAnswerPrompt } from "../../prompts/beam"
import type { BenchmarkProtocol, ProtocolIdentity, QuestionEvaluation } from "../../types/protocol"
import type { UnifiedQuestion, UnifiedSearchResult, UnifiedSession } from "../../types/unified"
import { sha256Text, stableSha256 } from "../../utils/stable"
import {
  BEAM_ABILITY_IDS,
  BEAM_PASS_THRESHOLD,
  BeamPaperProtocol,
  type BeamAbilityId,
} from "../beam-paper"
import {
  BEAM_MEM0_JUDGE_SYSTEM_PROMPT,
  BEAM_MEM0_NUGGET_PROMPT_VERSION,
  buildBeamMem0NuggetPrompt,
} from "./prompts"

export * from "./prompts"

export const BEAM_MEM0_NUGGET_PROTOCOL_ID = "beam-mem0-nugget"
export const BEAM_MEM0_NUGGET_PROTOCOL_VERSION = "1.2.0"
export const BEAM_MEM0_NUGGET_PROFILE = "mem0-nugget"

const MAX_DIRECT_RETRIEVAL_TOP_K = 100
const MEM0_GPT5_MAX_OUTPUT_TOKENS = 4096
const MEM0_GPT5_MAX_ATTEMPTS = 5
const MEM0_GPT5_INNER_MAX_RETRIES = 2
const MEM0_GPT5_TIMEOUT_MS = 120_000
const MEM0_GPT5_RETRY_BACKOFF_MS = 2_000
const MEM0_GPT5_TRANSPORT = "openai-chat-completions" as const
const MEM0_TERMINAL_EMPTY_OUTPUT_POLICY = "accept-and-evaluate" as const

const NUGGET_JUDGMENT_SCHEMA = z
  .object({
    score: z.number(),
    reason: z.string().trim().min(1),
  })
  .strict()

const NUGGET_PROGRESS_SCHEMA = z
  .object({
    kind: z.literal("beam-mem0-nuggets-v1"),
    questionId: z.string().min(1),
    rubricHash: z.string().regex(/^[a-f0-9]{64}$/),
    judgments: z
      .array(
        z
          .object({
            nugget: z.string().min(1),
            score: z.union([z.literal(0), z.literal(0.5), z.literal(1)]),
            reason: z.string().min(1),
          })
          .strict()
      )
      .default([]),
  })
  .strict()

interface NuggetJudgment {
  nugget: string
  score: 0 | 0.5 | 1
  reason: string
}

/** Match mem0's `_clamp_nugget_score` thresholds. */
export function clampMem0NuggetScore(score: number): 0 | 0.5 | 1 {
  if (!Number.isFinite(score)) return 0
  if (score >= 0.75) return 1
  if (score >= 0.25) return 0.5
  return 0
}

export interface BeamMem0NuggetProtocolConfig {
  retrievalTopK?: number
  answerCutoff?: number
}

function mean(values: readonly number[]): number {
  if (values.length === 0) throw new Error("Cannot average an empty list")
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function getRubric(question: UnifiedQuestion): string[] {
  const rubric = question.metadata?.rubric
  if (
    !Array.isArray(rubric) ||
    rubric.length === 0 ||
    rubric.some((item) => typeof item !== "string" || !item.trim())
  ) {
    throw new Error(
      `BEAM question ${question.questionId || "<missing-id>"} must have a non-empty string rubric`
    )
  }
  return rubric as string[]
}

function getDocumentDate(session: UnifiedSession): string | undefined {
  const documentDate = session.metadata?.documentDate
  const legacyDate = session.metadata?.date
  if (documentDate !== undefined && legacyDate !== undefined && documentDate !== legacyDate) {
    throw new Error(`BEAM session ${session.sessionId} has conflicting document dates`)
  }
  const value = documentDate ?? legacyDate
  return typeof value === "string" ? value : undefined
}

function createSessionDateMap(
  sessions: readonly UnifiedSession[],
  results: readonly UnifiedSearchResult[]
): Map<string, string> {
  const dates = new Map<string, string>()
  for (const session of sessions) {
    const date = getDocumentDate(session)
    if (date) dates.set(session.sessionId, date)
  }
  for (const result of results) {
    if (result.sessionId && result.documentDate && !dates.has(result.sessionId)) {
      dates.set(result.sessionId, result.documentDate)
    }
  }
  return dates
}

function toPromptEvidence(results: readonly UnifiedSearchResult[], dates: Map<string, string>) {
  return results.map((result) => ({
    content: result.text,
    metadata: (() => {
      const promptSessionId =
        result.sessionId ?? (result.documentDate ? `normalized-result:${result.id}` : undefined)
      if (!promptSessionId) return undefined
      if (result.documentDate) dates.set(promptSessionId, result.documentDate)
      return { sessionId: promptSessionId }
    })(),
  }))
}

const MEM0_EVALUATOR_IDENTITY = {
  profile: BEAM_MEM0_NUGGET_PROFILE,
  sourceRepository: "mem0ai/memory-benchmarks",
  sourceCommit: "4b61c5d31b9c668a12b4f5e78064248a02c82d2b",
  judgeProvider: "openai",
  judgeModel: "gpt-5",
  nuggetPromptVersion: BEAM_MEM0_NUGGET_PROMPT_VERSION,
  nuggetPromptSha256: sha256Text(
    buildBeamMem0NuggetPrompt({
      question: "<question>",
      nugget: "<rubric_item>",
      answer: "<llm_response>",
    })
  ),
  systemPromptSha256: sha256Text(BEAM_MEM0_JUDGE_SYSTEM_PROMPT),
  structuredOutputSchemaSha256: stableSha256({
    score: "number-clamped-at-0.25-and-0.75",
    reason: "non-empty-string",
    additionalProperties: false,
  }),
  structuredOutputMode: "ai-sdk-generate-object-json-schema-v1",
  parseFallback: "none-fail-closed-deviation-from-mem0-raw-text-marker-fallback",
  eventOrderingPolicy: "ordinary-nugget-average-primary",
  temperature: null,
  maxOutputTokens: MEM0_GPT5_MAX_OUTPUT_TOKENS,
  maxAttempts: MEM0_GPT5_MAX_ATTEMPTS,
  innerMaxRetries: MEM0_GPT5_INNER_MAX_RETRIES,
  timeoutMs: MEM0_GPT5_TIMEOUT_MS,
  retryBackoffMs: MEM0_GPT5_RETRY_BACKOFF_MS,
  transport: MEM0_GPT5_TRANSPORT,
  runtimeExecutionVersion: STRUCTURED_RUNTIME_EXECUTION_VERSION,
  runtimeExecutionSha256: stableSha256({
    executeStructuredWithRetries: executeStructuredWithRetries.toString(),
    generateStructuredObject: generateStructuredObject.toString(),
    hasEvaluableAnswer: hasEvaluableAnswer.toString(),
    runEvaluatePhase: runEvaluatePhase.toString(),
  }),
} as const

function createIdentity(
  protocol: BeamMem0NuggetProtocol,
  ingestionDelegate: BeamPaperProtocol
): ProtocolIdentity {
  const retrieval = {
    policy: "direct-top-k",
    requestedTopK: protocol.retrievalTopK,
    answerCutoff: protocol.answerCutoff,
    threshold: 0,
    maximumDirectTopK: MAX_DIRECT_RETRIEVAL_TOP_K,
  }
  const answerProbe = buildBeamAnswerPrompt("<question>", [], new Map())
  const answer = {
    formatter: "mem0-public-beam-answer-prompt",
    formatterVersion: "normalized-evidence-v1",
    transport: MEM0_GPT5_TRANSPORT,
    maxOutputTokens: MEM0_GPT5_MAX_OUTPUT_TOKENS,
    maxAttempts: MEM0_GPT5_MAX_ATTEMPTS,
    innerMaxRetries: MEM0_GPT5_INNER_MAX_RETRIES,
    timeoutMs: MEM0_GPT5_TIMEOUT_MS,
    retryBackoffMs: MEM0_GPT5_RETRY_BACKOFF_MS,
    emptyOutputPolicy: "retry",
    terminalEmptyOutputPolicy: MEM0_TERMINAL_EMPTY_OUTPUT_POLICY,
    runtimeExecutionVersion: ANSWER_RUNTIME_EXECUTION_VERSION,
    runtimeExecutionSha256: stableSha256({
      getLanguageModel: getLanguageModel.toString(),
      generateAnswerWithRetries: generateAnswerWithRetries.toString(),
      shouldRunAnswerPhase: shouldRunAnswerPhase.toString(),
      runAnswerPhase: runAnswerPhase.toString(),
    }),
    promptSha256: sha256Text(answerProbe),
    implementationSha256: stableSha256({
      createAnswerPlan: protocol.createAnswerPlan.toString(),
      promptBuilder: buildBeamAnswerPrompt.toString(),
      documentDate: getDocumentDate.toString(),
      sessionDateMap: createSessionDateMap.toString(),
      promptEvidence: toPromptEvidence.toString(),
    }),
  }
  const evaluator = {
    ...MEM0_EVALUATOR_IDENTITY,
    implementationSha256: stableSha256({
      evaluateQuestion: protocol.evaluateQuestion.toString(),
      promptBuilder: buildBeamMem0NuggetPrompt.toString(),
      rubricValidation: getRubric.toString(),
      scoreClamp: clampMem0NuggetScore.toString(),
      mean: mean.toString(),
    }),
  }
  const aggregation = {
    primaryMetric: "mem0NuggetAverage",
    questionWeighting: "equal-micro",
    eventOrderingPolicy: "ordinary-nugget-average-primary",
    implementationSha256: stableSha256({
      aggregateQuality: protocol.aggregateQuality.toString(),
      mean: mean.toString(),
    }),
  }
  const implementation = {
    protocol: BEAM_MEM0_NUGGET_PROTOCOL_ID,
    version: BEAM_MEM0_NUGGET_PROTOCOL_VERSION,
    ingestionPolicyHash: ingestionDelegate.identity.ingestionPolicyHash,
    retrieval,
    answer,
    evaluator,
    aggregation,
  }
  return {
    id: BEAM_MEM0_NUGGET_PROTOCOL_ID,
    version: BEAM_MEM0_NUGGET_PROTOCOL_VERSION,
    configFingerprint: stableSha256({ retrieval, answer, evaluator, aggregation }),
    implementationFingerprint: stableSha256(implementation),
    ingestionPolicyHash: ingestionDelegate.identity.ingestionPolicyHash,
    retrievalPolicyHash: stableSha256(retrieval),
    answerPromptHash: stableSha256(answer),
    evaluatorHash: stableSha256(evaluator),
    aggregationHash: stableSha256(aggregation),
    details: {
      comparisonProfile: BEAM_MEM0_NUGGET_PROFILE,
      ingestionPolicy: ingestionDelegate.identity.details?.ingestionPolicy,
      retrievalPolicy: retrieval,
      answerPrompt: answer,
      evaluatorIdentity: evaluator,
      aggregation,
      comparabilityNotice:
        "Experimental direct-retrieval mem0-style profile; unlike mem0's runner, schema-invalid judge output fails closed without raw-text marker fallback. This is not the BEAM paper protocol.",
    },
  }
}

export class BeamMem0NuggetProtocol implements BenchmarkProtocol {
  readonly auxiliaryRetrievalEvaluation = "disabled" as const
  readonly ingestionExecutionPolicy = {
    readinessBarrier: "after-each-document",
    processingMode: "instant",
  } as const
  readonly requiredJudge = {
    provider: "openai",
    modelId: "gpt-5",
    modelAlias: "gpt-5",
  }
  readonly retrievalTopK: number
  readonly answerCutoff: number
  readonly identity: ProtocolIdentity
  private readonly ingestionDelegate = new BeamPaperProtocol()

  constructor(config: BeamMem0NuggetProtocolConfig = {}) {
    const retrievalTopK = config.retrievalTopK ?? 50
    const answerCutoff = config.answerCutoff ?? retrievalTopK
    if (
      !Number.isInteger(retrievalTopK) ||
      retrievalTopK < 1 ||
      retrievalTopK > MAX_DIRECT_RETRIEVAL_TOP_K
    ) {
      throw new Error(
        `BEAM mem0 comparison retrieval Top-K must be an integer from 1 to ${MAX_DIRECT_RETRIEVAL_TOP_K}; got ${retrievalTopK}`
      )
    }
    if (!Number.isInteger(answerCutoff) || answerCutoff < 1 || answerCutoff > retrievalTopK) {
      throw new Error(
        `BEAM mem0 comparison answer cutoff must be an integer from 1 to Top-K ${retrievalTopK}; got ${answerCutoff}`
      )
    }
    this.retrievalTopK = retrievalTopK
    this.answerCutoff = answerCutoff
    this.identity = createIdentity(this, this.ingestionDelegate)
  }

  validateQuestion(question: UnifiedQuestion): void {
    this.ingestionDelegate.validateQuestion(question)
  }

  createIngestionPlan(input: Parameters<BenchmarkProtocol["createIngestionPlan"]>[0]) {
    return this.ingestionDelegate.createIngestionPlan(input)
  }

  createRetrievalPlan({ question }: Parameters<BenchmarkProtocol["createRetrievalPlan"]>[0]) {
    this.validateQuestion(question)
    return {
      query: question.question,
      requestedTopK: this.retrievalTopK,
      answerCutoff: this.answerCutoff,
      threshold: 0,
    }
  }

  createAnswerPlan({
    question,
    sessions,
    results,
    retrieval,
  }: Parameters<BenchmarkProtocol["createAnswerPlan"]>[0]) {
    this.validateQuestion(question)
    if (
      retrieval.requestedTopK !== this.retrievalTopK ||
      retrieval.answerCutoff !== this.answerCutoff
    ) {
      throw new Error("BEAM mem0 comparison retrieval plan drifted from its configured budget")
    }
    const evidence = results.slice(0, retrieval.answerCutoff)
    const dates = createSessionDateMap(sessions, evidence)
    const promptEvidence = toPromptEvidence(evidence, dates)
    return {
      request: {
        prompt: buildBeamAnswerPrompt(question.question, promptEvidence, dates),
        maxOutputTokens: MEM0_GPT5_MAX_OUTPUT_TOKENS,
        transport: MEM0_GPT5_TRANSPORT,
        maxAttempts: MEM0_GPT5_MAX_ATTEMPTS,
        innerMaxRetries: MEM0_GPT5_INNER_MAX_RETRIES,
        timeoutMs: MEM0_GPT5_TIMEOUT_MS,
        retryBackoffMs: MEM0_GPT5_RETRY_BACKOFF_MS,
        terminalEmptyOutputPolicy: MEM0_TERMINAL_EMPTY_OUTPUT_POLICY,
      },
      baseRequest: {
        prompt: buildBeamAnswerPrompt(question.question, [], dates),
        maxOutputTokens: MEM0_GPT5_MAX_OUTPUT_TOKENS,
        transport: MEM0_GPT5_TRANSPORT,
        maxAttempts: MEM0_GPT5_MAX_ATTEMPTS,
        innerMaxRetries: MEM0_GPT5_INNER_MAX_RETRIES,
        timeoutMs: MEM0_GPT5_TIMEOUT_MS,
        retryBackoffMs: MEM0_GPT5_RETRY_BACKOFF_MS,
        terminalEmptyOutputPolicy: MEM0_TERMINAL_EMPTY_OUTPUT_POLICY,
      },
      answerEvidenceCount: evidence.length,
    }
  }

  async evaluateQuestion(
    {
      question,
      hypothesis,
      protocolProgress,
      onProtocolProgress,
    }: Parameters<BenchmarkProtocol["evaluateQuestion"]>[0],
    runtime: Parameters<BenchmarkProtocol["evaluateQuestion"]>[1]
  ): Promise<QuestionEvaluation> {
    this.validateQuestion(question)
    const rubric = getRubric(question)
    const rubricHash = stableSha256(rubric)
    const progress = protocolProgress
      ? NUGGET_PROGRESS_SCHEMA.parse(protocolProgress)
      : {
          kind: "beam-mem0-nuggets-v1" as const,
          questionId: question.questionId,
          rubricHash,
          judgments: [] as NuggetJudgment[],
        }
    if (
      progress.questionId !== question.questionId ||
      progress.rubricHash !== rubricHash ||
      progress.judgments.length > rubric.length ||
      progress.judgments.some((judgment, index) => judgment.nugget !== rubric[index])
    ) {
      throw new Error(`BEAM mem0 nugget progress identity mismatch for ${question.questionId}`)
    }

    const judgments: NuggetJudgment[] = [...progress.judgments]
    for (let index = judgments.length; index < rubric.length; index++) {
      const nugget = rubric[index]!
      const result = await runtime.generateStructured({
        system: BEAM_MEM0_JUDGE_SYSTEM_PROMPT,
        prompt: buildBeamMem0NuggetPrompt({
          question: question.question,
          nugget,
          answer: hypothesis,
        }),
        schema: NUGGET_JUDGMENT_SCHEMA,
        schemaName: "beam_mem0_nugget_judgment",
        // GPT-5 does not accept a temperature override. Leaving it absent is
        // part of this profile's recorded evaluator identity.
        maxOutputTokens: MEM0_EVALUATOR_IDENTITY.maxOutputTokens,
        maxAttempts: MEM0_EVALUATOR_IDENTITY.maxAttempts,
        innerMaxRetries: MEM0_EVALUATOR_IDENTITY.innerMaxRetries,
        timeoutMs: MEM0_EVALUATOR_IDENTITY.timeoutMs,
        retryBackoffMs: MEM0_EVALUATOR_IDENTITY.retryBackoffMs,
        transport: MEM0_EVALUATOR_IDENTITY.transport,
      })
      judgments.push({
        nugget,
        score: clampMem0NuggetScore(result.score),
        reason: result.reason,
      })
      await onProtocolProgress?.({ ...progress, judgments: [...judgments] })
    }

    const primaryScore = mean(judgments.map((judgment) => judgment.score))
    const passed = primaryScore >= BEAM_PASS_THRESHOLD
    return {
      questionId: question.questionId,
      questionType: question.questionType,
      primaryScore,
      passed,
      label: passed ? "pass" : "fail",
      explanation: `Mem0-style BEAM nugget average: ${primaryScore.toFixed(4)}`,
      metrics: {
        nuggetAverage: primaryScore,
        nuggetCount: judgments.length,
      },
      details: {
        evaluatorIdentity: MEM0_EVALUATOR_IDENTITY,
        nuggetJudgments: judgments,
        eventOrderingScoreUsed: 0,
      },
    }
  }

  aggregateQuality({
    questions,
    evaluations,
  }: Parameters<BenchmarkProtocol["aggregateQuality"]>[0]) {
    if (evaluations.length === 0) {
      throw new Error("Cannot aggregate an empty BEAM mem0 comparison run")
    }
    const questionById = new Map(questions.map((question) => [question.questionId, question]))
    const seen = new Set<string>()
    const scoresByAbility = new Map<BeamAbilityId, number[]>()
    for (const evaluation of evaluations) {
      const question = questionById.get(evaluation.questionId)
      if (!question || seen.has(evaluation.questionId)) {
        throw new Error(`Invalid or duplicate evaluation ${evaluation.questionId}`)
      }
      if (evaluation.questionType !== question.questionType) {
        throw new Error(`Evaluation type mismatch for ${evaluation.questionId}`)
      }
      if (!BEAM_ABILITY_IDS.includes(evaluation.questionType as BeamAbilityId)) {
        throw new Error(`Unsupported BEAM ability ${evaluation.questionType}`)
      }
      if (
        !Number.isFinite(evaluation.primaryScore) ||
        evaluation.primaryScore < 0 ||
        evaluation.primaryScore > 1
      ) {
        throw new Error(`Invalid nugget score for ${evaluation.questionId}`)
      }
      seen.add(evaluation.questionId)
      const ability = evaluation.questionType as BeamAbilityId
      const scores = scoresByAbility.get(ability) ?? []
      scores.push(evaluation.primaryScore)
      scoresByAbility.set(ability, scores)
    }
    if (seen.size !== questions.length) {
      throw new Error(`Missing BEAM mem0 evaluations: received ${seen.size}/${questions.length}`)
    }

    const score = mean(evaluations.map((evaluation) => evaluation.primaryScore))
    const bySlice: Record<string, Record<string, number>> = {}
    for (const ability of BEAM_ABILITY_IDS) {
      const abilityScores = scoresByAbility.get(ability)
      if (!abilityScores?.length) continue
      bySlice[ability] = {
        averageScore: mean(abilityScores),
        questionCount: abilityScores.length,
      }
    }
    return {
      primaryMetric: { key: "mem0NuggetAverage", value: score, higherIsBetter: true },
      metrics: {
        mem0NuggetAverage: score,
        totalQuestions: evaluations.length,
      },
      bySlice,
    }
  }
}

export const beamMem0NuggetProtocol = new BeamMem0NuggetProtocol()
