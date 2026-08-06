import { z } from "zod"
import {
  BEAM_ANSWER_FORMATTER_IMPLEMENTATION_HASH,
  BEAM_EVENT_ORDERING_ANSWER_FORMAT_VERSION,
  buildBeamAnswerPrompt,
} from "../../prompts/beam"
import type { BenchmarkProtocol, ProtocolIdentity, QuestionEvaluation } from "../../types/protocol"
import type { UnifiedQuestion, UnifiedSearchResult, UnifiedSession } from "../../types/unified"
import { sha256Text, stableSha256 } from "../../utils/stable"
import {
  BEAM_EVENT_EXTRACTION_VERSION,
  BEAM_EVENT_ORDERING_SCORING_VERSION,
  BEAM_KENDALL_TAU_IMPLEMENTATION,
  alignBeamEvents,
  buildBeamEventRankVectors,
  computeKendallTauB,
  evaluateBeamEventOrdering,
  extractBeamPredictedEvents,
  scoreAlignedBeamEvents,
} from "./event-ordering"
import {
  BEAM_EVENT_EQUIVALENCE_PROMPT_VERSION,
  BEAM_EVENT_EQUIVALENCE_SYSTEM_PROMPT,
  BEAM_EVENT_EQUIVALENCE_USER_PROMPT,
  BEAM_NUGGET_JUDGE_PROMPT,
  BEAM_NUGGET_JUDGE_PROMPT_VERSION,
  buildBeamEventEquivalencePrompt,
  buildBeamPaperNuggetPrompt,
} from "./prompts"

export * from "./event-ordering"
export * from "./prompts"

export const BEAM_PAPER_PROTOCOL_ID = "beam-paper"
export const BEAM_PAPER_PROTOCOL_VERSION = "1.5.0"
export const BEAM_PAPER_ID = "arXiv:2510.27246"
export const BEAM_PAPER_REVISION = "v2"
export const BEAM_PAPER_PDF_SHA256 =
  "8ae85b00eb0f93f0717edb082f5471716f6c757670d7157dc5ba94df01fbb303"
export const BEAM_REFERENCE_REPOSITORY = "mohammadtavakoli78/BEAM"
export const BEAM_REFERENCE_COMMIT = "3e12035532eb85768f1a7cd779832b650c4b2ef9"
export const BEAM_PASS_THRESHOLD = 0.5
export const BEAM_RETRIEVAL_TOP_K_VALUES = [5, 10, 15, 20] as const
export type BeamRetrievalTopK = (typeof BEAM_RETRIEVAL_TOP_K_VALUES)[number]

export const BEAM_ABILITY_IDS = [
  "abstention",
  "contradiction_resolution",
  "event_ordering",
  "information_extraction",
  "instruction_following",
  "knowledge_update",
  "multi_session_reasoning",
  "preference_following",
  "summarization",
  "temporal_reasoning",
] as const
export type BeamAbilityId = (typeof BEAM_ABILITY_IDS)[number]

export const BEAM_OFFICIAL_TIER_COUNTS = {
  "1M": { questions: 700, questionsPerAbility: 70 },
  "10M": { questions: 200, questionsPerAbility: 20 },
} as const

const BEAM_ABILITY_ID_SET = new Set<string>(BEAM_ABILITY_IDS)

function createBeamNuggetJudgmentSchema() {
  return z
    .object({
      score: z.union([z.literal(0), z.literal(0.5), z.literal(1)]),
      reason: z.string().trim().min(1),
    })
    .strict()
}

function createBeamEventEquivalenceSchema() {
  return z
    .object({
      answer: z.enum(["YES", "NO"]),
    })
    .strict()
}

function createBeamNuggetProgressSchema() {
  return z
    .object({
      kind: z.literal("beam-nuggets-v1"),
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
}

function createBeamEventProgressSchema() {
  return z
    .object({
      kind: z.literal("beam-event-equivalence-v1"),
      questionId: z.string().min(1),
      rubricHash: z.string().regex(/^[a-f0-9]{64}$/),
      predictedEventsHash: z.string().regex(/^[a-f0-9]{64}$/),
      judgments: z.array(
        z
          .object({
            predictedIndex: z.number().int().nonnegative(),
            referenceIndex: z.number().int().nonnegative(),
            // The pinned authors scorer preserves blank lines from split("\n").
            predictedEvent: z.string(),
            referenceEvent: z.string().min(1),
            equivalent: z.boolean(),
          })
          .strict()
      ),
    })
    .strict()
}

export const BEAM_NUGGET_JUDGMENT_SCHEMA = createBeamNuggetJudgmentSchema()
export const BEAM_EVENT_EQUIVALENCE_SCHEMA = createBeamEventEquivalenceSchema()
const BEAM_NUGGET_PROGRESS_SCHEMA = createBeamNuggetProgressSchema()
const BEAM_EVENT_PROGRESS_SCHEMA = createBeamEventProgressSchema()

export type BeamNuggetJudgmentOutput = z.infer<typeof BEAM_NUGGET_JUDGMENT_SCHEMA>

export interface BeamNuggetJudgment extends BeamNuggetJudgmentOutput {
  nugget: string
}

export interface BeamEvaluatorIdentity {
  protocolId: typeof BEAM_PAPER_PROTOCOL_ID
  paperId: typeof BEAM_PAPER_ID
  paperRevision: typeof BEAM_PAPER_REVISION
  paperPdfSha256: typeof BEAM_PAPER_PDF_SHA256
  referenceRepository: typeof BEAM_REFERENCE_REPOSITORY
  referenceCommit: typeof BEAM_REFERENCE_COMMIT
  nuggetPromptVersion: string
  nuggetPromptSha256: string
  eventEquivalencePromptVersion: string
  eventEquivalencePromptSha256: string
  evaluatorImplementationSha256: string
  judgeProvider: "openai"
  judgeModel: "gpt-4.1-mini"
  structuredOutputSchemaVersion: string
  structuredOutputSchemaSha256: string
  structuredOutputMode: string
  kendallTauImplementation: string
  eventExtractionVersion: string
  eventOrderingScoringVersion: string
  temperature: 0
  maxOutputTokens: number
  maxAttempts: number
  timeoutMs: number
  retryPolicy: string
}

export interface BeamPaperProtocolConfig {
  retrievalTopK?: number
}

function isBeamRetrievalTopK(value: number): value is BeamRetrievalTopK {
  return (BEAM_RETRIEVAL_TOP_K_VALUES as readonly number[]).includes(value)
}

function getRubric(question: UnifiedQuestion): string[] {
  const rubric = question.metadata?.rubric
  if (
    !Array.isArray(rubric) ||
    rubric.length === 0 ||
    rubric.some((item) => typeof item !== "string" || item.trim().length === 0)
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
    throw new Error(
      `BEAM session ${session.sessionId} has conflicting document dates ${String(documentDate)} and ${String(legacyDate)}`
    )
  }
  const value = documentDate ?? legacyDate
  if (value === undefined) return undefined
  if (typeof value !== "string") {
    throw new Error(`BEAM session ${session.sessionId} document date must be a YYYY-MM-DD string`)
  }
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) {
    throw new Error(`BEAM session ${session.sessionId} has invalid document date ${value}`)
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`BEAM session ${session.sessionId} has invalid document date ${value}`)
  }
  return value
}

function renderBeamTranscript(session: UnifiedSession): string {
  return session.messages
    .map((message) => `[${message.role.toUpperCase()}]\n${message.content}`)
    .join("\n\n")
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

function toBeamPromptEvidence(results: readonly UnifiedSearchResult[], dates: Map<string, string>) {
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

function mean(values: readonly number[]): number {
  if (values.length === 0) throw new Error("Cannot average an empty list")
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function createProtocolIdentity(
  topK: BeamRetrievalTopK,
  protocol: BeamPaperProtocol
): ProtocolIdentity {
  const methodHashes = {
    validateQuestion: sha256Text(protocol.validateQuestion.toString()),
    createIngestionPlan: sha256Text(protocol.createIngestionPlan.toString()),
    createRetrievalPlan: sha256Text(protocol.createRetrievalPlan.toString()),
    createAnswerPlan: sha256Text(protocol.createAnswerPlan.toString()),
    evaluateQuestion: sha256Text(protocol.evaluateQuestion.toString()),
    aggregateQuality: sha256Text(protocol.aggregateQuality.toString()),
  }
  const helperHashes = {
    getRubric: sha256Text(getRubric.toString()),
    getDocumentDate: sha256Text(getDocumentDate.toString()),
    renderTranscript: sha256Text(renderBeamTranscript.toString()),
    createSessionDateMap: sha256Text(createSessionDateMap.toString()),
    toPromptEvidence: sha256Text(toBeamPromptEvidence.toString()),
    arithmeticMean: sha256Text(mean.toString()),
  }
  const orchestration = { methodHashes, helperHashes }
  const ingestion = {
    policy: "one-document-per-session-date-prefixed-transcript-v1",
    customId: "sessionId",
    metadata: "sessionId-and-optional-documentDate",
    messageProjection: "ordered-role-and-content",
    missingDatePolicy: "omit-document-date-prefix-and-metadata",
    executionPolicy: protocol.ingestionExecutionPolicy,
    implementationSha256: stableSha256({
      createIngestionPlan: methodHashes.createIngestionPlan,
      getDocumentDate: helperHashes.getDocumentDate,
      renderTranscript: helperHashes.renderTranscript,
    }),
  }
  const retrieval = {
    policy: "paper-top-k",
    requestedTopK: topK,
    answerCutoff: topK,
    threshold: 0,
    allowedValues: BEAM_RETRIEVAL_TOP_K_VALUES,
    implementationSha256: methodHashes.createRetrievalPlan,
  }
  const answerProbe = buildBeamAnswerPrompt("<question>", [], new Map())
  const eventOrderingAnswerProbe = buildBeamAnswerPrompt(
    "<event-ordering-question>",
    [],
    new Map(),
    "event-ordering-lines"
  )
  const answer = {
    formatter: "buildBeamAnswerPrompt",
    formatterVersion: "beam-normalized-evidence-v2",
    basePromptSha256: sha256Text(answerProbe),
    eventOrderingAnswerFormatVersion: BEAM_EVENT_ORDERING_ANSWER_FORMAT_VERSION,
    eventOrderingPromptSha256: sha256Text(eventOrderingAnswerProbe),
    formatterImplementationSha256: BEAM_ANSWER_FORMATTER_IMPLEMENTATION_HASH,
    answerPlanImplementationSha256: stableSha256({
      createAnswerPlan: methodHashes.createAnswerPlan,
      createSessionDateMap: helperHashes.createSessionDateMap,
      toPromptEvidence: helperHashes.toPromptEvidence,
    }),
    datedEvidenceProbeSha256: sha256Text(
      buildBeamAnswerPrompt(
        "<question>",
        [{ memory: "<evidence>", metadata: { sessionId: "<session>" } }],
        new Map([["<session>", "2000-01-01"]])
      )
    ),
  }
  const auxiliaryRetrievalEvaluation = {
    policy: protocol.auxiliaryRetrievalEvaluation,
    protocolStatus: "disabled-because-not-defined-by-beam-paper",
  }
  const evaluator = {
    paperEvaluator: BEAM_EVALUATOR_IDENTITY,
    auxiliaryRetrievalEvaluation,
  }
  const aggregation = {
    primaryMetric: "beamScore",
    abilityIds: BEAM_ABILITY_IDS,
    abilityWeighting: "equal-macro",
    officialTierCounts: BEAM_OFFICIAL_TIER_COUNTS,
    passThreshold: BEAM_PASS_THRESHOLD,
    partialMetricName: "beamScorePartial",
    combinedTierPolicy: "equal-tier-macro-secondary-not-paper-score-v1",
    implementationSha256: stableSha256({
      aggregateQuality: protocol.aggregateQuality.toString(),
      arithmeticMean: mean.toString(),
    }),
  }
  const implementation = {
    protocol: BEAM_PAPER_PROTOCOL_ID,
    version: BEAM_PAPER_PROTOCOL_VERSION,
    ingestion,
    evaluator,
    answer,
    aggregation,
    orchestration,
  }

  return {
    id: BEAM_PAPER_PROTOCOL_ID,
    version: BEAM_PAPER_PROTOCOL_VERSION,
    configFingerprint: stableSha256({ ingestion, retrieval, answer, evaluator, aggregation }),
    implementationFingerprint: stableSha256(implementation),
    ingestionPolicyHash: stableSha256(ingestion),
    retrievalPolicyHash: stableSha256(retrieval),
    answerPromptHash: stableSha256(answer),
    evaluatorHash: stableSha256(evaluator),
    aggregationHash: stableSha256(aggregation),
    details: {
      paperProfile: {
        paperId: BEAM_PAPER_ID,
        paperRevision: BEAM_PAPER_REVISION,
        paperPdfSha256: BEAM_PAPER_PDF_SHA256,
        referenceRepository: BEAM_REFERENCE_REPOSITORY,
        referenceCommit: BEAM_REFERENCE_COMMIT,
      },
      ingestionPolicy: ingestion,
      retrievalPolicy: retrieval,
      answerPrompt: answer,
      evaluatorIdentity: BEAM_EVALUATOR_IDENTITY,
      auxiliaryRetrievalEvaluation,
      aggregation,
      orchestrationImplementation: orchestration,
    },
  }
}

export class BeamPaperProtocol implements BenchmarkProtocol {
  readonly auxiliaryRetrievalEvaluation = "disabled" as const
  readonly ingestionExecutionPolicy = {
    readinessBarrier: "after-each-document",
    processingMode: "instant",
  } as const
  readonly requiredJudge = {
    provider: "openai",
    modelId: "gpt-4.1-mini",
    modelAlias: "gpt-4.1-mini",
  }
  readonly retrievalTopK: BeamRetrievalTopK
  readonly identity: ProtocolIdentity

  constructor(config: BeamPaperProtocolConfig = {}) {
    const retrievalTopK = config.retrievalTopK ?? 5
    if (!isBeamRetrievalTopK(retrievalTopK)) {
      throw new Error(
        `BEAM retrieval Top-K must be one of ${BEAM_RETRIEVAL_TOP_K_VALUES.join(", ")}; got ${retrievalTopK}`
      )
    }
    this.retrievalTopK = retrievalTopK
    this.identity = createProtocolIdentity(retrievalTopK, this)
  }

  validateQuestion(question: UnifiedQuestion): void {
    if (!question.questionId || !question.questionId.trim()) {
      throw new Error("BEAM question must have a non-empty question ID")
    }
    if (!question.question || !question.question.trim()) {
      throw new Error(`BEAM question ${question.questionId} must have non-empty question text`)
    }
    if (!BEAM_ABILITY_ID_SET.has(question.questionType)) {
      throw new Error(
        `BEAM question ${question.questionId} has unsupported ability ${JSON.stringify(question.questionType)}`
      )
    }
    const rubric = getRubric(question)
    if (question.questionType === "event_ordering" && rubric.length < 2) {
      throw new Error(
        `BEAM event-ordering question ${question.questionId} must have at least two reference events for Kendall tau-b`
      )
    }
  }

  createIngestionPlan({
    question,
    sessions,
  }: Parameters<BenchmarkProtocol["createIngestionPlan"]>[0]) {
    this.validateQuestion(question)
    return sessions.map((session) => {
      if (
        typeof session.sessionId !== "string" ||
        !session.sessionId.trim() ||
        !Array.isArray(session.messages) ||
        session.messages.length !== 2 ||
        session.messages[0]?.role !== "user" ||
        session.messages[1]?.role !== "assistant" ||
        session.messages.some(
          (message) => typeof message.content !== "string" || !message.content.trim()
        )
      ) {
        throw new Error(
          `BEAM question ${question.questionId} session ${session.sessionId || "<missing-id>"} must contain exactly one non-empty user message followed by one non-empty assistant message`
        )
      }
      const transcript = renderBeamTranscript(session)
      const documentDate = getDocumentDate(session)
      return {
        customId: session.sessionId,
        content: documentDate ? `DOCUMENT_DATE: ${documentDate}\n\n${transcript}` : transcript,
        metadata: {
          sessionId: session.sessionId,
          ...(documentDate ? { documentDate } : {}),
        },
        // All provider adapters receive the same BEAM evidence. Per-message
        // source anchors/speaker labels remain dataset provenance, but must not
        // leak into extraction-based providers when the approved document is
        // only the dated role/content transcript.
        messages: session.messages.map(({ role, content }) => ({ role, content })),
      }
    })
  }

  createRetrievalPlan({ question }: Parameters<BenchmarkProtocol["createRetrievalPlan"]>[0]) {
    this.validateQuestion(question)
    return {
      query: question.question,
      requestedTopK: this.retrievalTopK,
      answerCutoff: this.retrievalTopK,
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
    if (retrieval.answerCutoff !== this.retrievalTopK) {
      throw new Error(
        `BEAM answer cutoff drifted from configured Top-K (${retrieval.answerCutoff} !== ${this.retrievalTopK})`
      )
    }
    const evidence = results.slice(0, retrieval.answerCutoff)
    const dates = createSessionDateMap(sessions, evidence)
    const promptEvidence = toBeamPromptEvidence(evidence, dates)
    const answerFormat =
      question.questionType === "event_ordering" ? "event-ordering-lines" : "default"

    return {
      request: {
        prompt: buildBeamAnswerPrompt(question.question, promptEvidence, dates, answerFormat),
      },
      baseRequest: {
        prompt: buildBeamAnswerPrompt(question.question, [], dates, answerFormat),
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

    if (question.questionType === "event_ordering") {
      const predictedEvents = extractBeamPredictedEvents(hypothesis)
      const rubricHash = stableSha256(rubric)
      const predictedEventsHash = stableSha256(predictedEvents)
      const eventProgress = protocolProgress
        ? BEAM_EVENT_PROGRESS_SCHEMA.parse(protocolProgress)
        : {
            kind: "beam-event-equivalence-v1" as const,
            questionId: question.questionId,
            rubricHash,
            predictedEventsHash,
            judgments: [],
          }
      if (
        eventProgress.questionId !== question.questionId ||
        eventProgress.rubricHash !== rubricHash ||
        eventProgress.predictedEventsHash !== predictedEventsHash
      ) {
        throw new Error(`BEAM event progress identity mismatch for ${question.questionId}`)
      }
      const seenEventPairs = new Set<string>()
      for (const judgment of eventProgress.judgments) {
        if (
          rubric[judgment.referenceIndex] !== judgment.referenceEvent ||
          predictedEvents[judgment.predictedIndex] !== judgment.predictedEvent
        ) {
          throw new Error(`BEAM event progress content mismatch for ${question.questionId}`)
        }
        const key = `${judgment.predictedIndex}:${judgment.referenceIndex}`
        if (seenEventPairs.has(key)) {
          throw new Error(`BEAM event progress contains duplicate pair ${key}`)
        }
        seenEventPairs.add(key)
      }
      const eventScore = await evaluateBeamEventOrdering({
        referenceEvents: rubric,
        predictedEvents,
        equivalent: async ({ predictedIndex, referenceIndex, referenceEvent, predictedEvent }) => {
          const existing = eventProgress.judgments.find(
            (judgment) =>
              judgment.predictedIndex === predictedIndex &&
              judgment.referenceIndex === referenceIndex
          )
          if (existing) return existing.equivalent

          const result = await runtime.generateStructured({
            system: BEAM_EVENT_EQUIVALENCE_SYSTEM_PROMPT,
            prompt: buildBeamEventEquivalencePrompt({ referenceEvent, predictedEvent }),
            schema: BEAM_EVENT_EQUIVALENCE_SCHEMA,
            schemaName: "beam_event_equivalence",
            temperature: BEAM_EVALUATOR_IDENTITY.temperature,
            maxOutputTokens: BEAM_EVALUATOR_IDENTITY.maxOutputTokens,
            maxAttempts: BEAM_EVALUATOR_IDENTITY.maxAttempts,
            timeoutMs: BEAM_EVALUATOR_IDENTITY.timeoutMs,
          })
          const equivalent = result.answer === "YES"
          eventProgress.judgments.push({
            predictedIndex,
            referenceIndex,
            predictedEvent,
            referenceEvent,
            equivalent,
          })
          await onProtocolProgress?.({ ...eventProgress, judgments: [...eventProgress.judgments] })
          return equivalent
        },
      })
      // Paper Section 2.4 names Kendall tau-b, and the pinned authors'
      // report_results.py reads tau_norm for Table 1. Their helper's
      // tau_norm * F1 value remains diagnostic only.
      const primaryScore = eventScore.normalizedKendallTauB
      const passed = primaryScore >= BEAM_PASS_THRESHOLD

      return {
        questionId: question.questionId,
        questionType: question.questionType,
        primaryScore,
        passed,
        label: passed ? "pass" : "fail",
        explanation: `BEAM event-ordering score (normalized Kendall tau-b): ${primaryScore.toFixed(4)}`,
        metrics: {
          kendallTauB: eventScore.kendall.tauB,
          normalizedKendallTauB: eventScore.normalizedKendallTauB,
          eventPrecision: eventScore.precision,
          eventRecall: eventScore.recall,
          eventF1: eventScore.f1,
          authorsHelperFinalScore: eventScore.finalScore,
        },
        details: {
          evaluatorIdentity: BEAM_EVALUATOR_IDENTITY,
          eventOrdering: eventScore,
        },
      }
    }

    const rubricHash = stableSha256(rubric)
    const nuggetProgress = protocolProgress
      ? BEAM_NUGGET_PROGRESS_SCHEMA.parse(protocolProgress)
      : {
          kind: "beam-nuggets-v1" as const,
          questionId: question.questionId,
          rubricHash,
          judgments: [] as BeamNuggetJudgment[],
        }
    if (
      nuggetProgress.questionId !== question.questionId ||
      nuggetProgress.rubricHash !== rubricHash ||
      nuggetProgress.judgments.length > rubric.length ||
      nuggetProgress.judgments.some((judgment, index) => judgment.nugget !== rubric[index])
    ) {
      throw new Error(`BEAM nugget progress identity mismatch for ${question.questionId}`)
    }

    const nuggetJudgments: BeamNuggetJudgment[] = [...nuggetProgress.judgments]
    for (let index = nuggetJudgments.length; index < rubric.length; index++) {
      const nugget = rubric[index]!
      const result = await runtime.generateStructured({
        prompt: buildBeamPaperNuggetPrompt({
          question: question.question,
          nugget,
          answer: hypothesis,
        }),
        schema: BEAM_NUGGET_JUDGMENT_SCHEMA,
        schemaName: "beam_nugget_judgment",
        temperature: BEAM_EVALUATOR_IDENTITY.temperature,
        maxOutputTokens: BEAM_EVALUATOR_IDENTITY.maxOutputTokens,
        maxAttempts: BEAM_EVALUATOR_IDENTITY.maxAttempts,
        timeoutMs: BEAM_EVALUATOR_IDENTITY.timeoutMs,
      })
      nuggetJudgments.push({ nugget, score: result.score, reason: result.reason })
      await onProtocolProgress?.({
        ...nuggetProgress,
        judgments: [...nuggetJudgments],
      })
    }

    const primaryScore = mean(nuggetJudgments.map((judgment) => judgment.score))
    const passed = primaryScore >= BEAM_PASS_THRESHOLD
    return {
      questionId: question.questionId,
      questionType: question.questionType,
      primaryScore,
      passed,
      label: passed ? "pass" : "fail",
      explanation: `BEAM nugget average: ${primaryScore.toFixed(4)}`,
      metrics: {
        nuggetAverage: primaryScore,
        nuggetCount: nuggetJudgments.length,
      },
      details: {
        evaluatorIdentity: BEAM_EVALUATOR_IDENTITY,
        nuggetJudgments,
      },
    }
  }

  aggregateQuality({
    questions,
    evaluations,
  }: Parameters<BenchmarkProtocol["aggregateQuality"]>[0]) {
    if (evaluations.length === 0) {
      throw new Error("Cannot aggregate a BEAM run with no completed evaluations")
    }

    const questionById = new Map(questions.map((question) => [question.questionId, question]))
    const evaluationIds = new Set<string>()
    const entries: Array<{
      ability: BeamAbilityId
      score: number
      scale?: "1M" | "10M"
    }> = []

    for (const evaluation of evaluations) {
      if (evaluationIds.has(evaluation.questionId)) {
        throw new Error(`Duplicate BEAM evaluation for question ${evaluation.questionId}`)
      }
      evaluationIds.add(evaluation.questionId)
      const question = questionById.get(evaluation.questionId)
      if (!question) {
        throw new Error(`BEAM evaluation references unknown question ${evaluation.questionId}`)
      }
      if (evaluation.questionType !== question.questionType) {
        throw new Error(`BEAM evaluation type mismatch for question ${evaluation.questionId}`)
      }
      if (!BEAM_ABILITY_ID_SET.has(evaluation.questionType)) {
        throw new Error(`Unsupported BEAM ability in evaluation: ${evaluation.questionType}`)
      }
      if (
        !Number.isFinite(evaluation.primaryScore) ||
        evaluation.primaryScore < 0 ||
        evaluation.primaryScore > 1
      ) {
        throw new Error(`Invalid BEAM score for question ${evaluation.questionId}`)
      }

      const scale = question.metadata?.scale
      if (scale !== undefined && scale !== "1M" && scale !== "10M") {
        throw new Error(
          `BEAM question ${question.questionId} has unsupported tier ${JSON.stringify(scale)}`
        )
      }
      entries.push({
        ability: evaluation.questionType as BeamAbilityId,
        score: evaluation.primaryScore,
        ...(scale ? { scale } : {}),
      })
    }

    const missingQuestionEvaluations = questions.filter(
      (question) => !evaluationIds.has(question.questionId)
    )
    if (missingQuestionEvaluations.length > 0) {
      throw new Error(
        `Missing BEAM evaluations for ${missingQuestionEvaluations.length} question(s), starting with ${missingQuestionEvaluations[0]!.questionId}`
      )
    }

    const aggregateEntries = (subset: typeof entries) => {
      const scoresByAbility = new Map<BeamAbilityId, number[]>()
      for (const entry of subset) {
        const scores = scoresByAbility.get(entry.ability) ?? []
        scores.push(entry.score)
        scoresByAbility.set(entry.ability, scores)
      }
      const abilitySlices: Record<string, Record<string, number>> = {}
      const abilityScores: number[] = []
      let passedQuestions = 0
      for (const ability of BEAM_ABILITY_IDS) {
        const scores = scoresByAbility.get(ability)
        if (!scores?.length) continue
        const averageScore = mean(scores)
        const passed = scores.filter((score) => score >= BEAM_PASS_THRESHOLD).length
        abilityScores.push(averageScore)
        passedQuestions += passed
        abilitySlices[ability] = {
          averageScore,
          passAccuracy: passed / scores.length,
          questionCount: scores.length,
          passedQuestions: passed,
        }
      }
      return {
        score: mean(abilityScores),
        passAccuracy: passedQuestions / subset.length,
        passedQuestions,
        questionCount: subset.length,
        coveredAbilities: abilityScores.length,
        allAbilitiesCovered: abilityScores.length === BEAM_ABILITY_IDS.length,
        abilitySlices,
      }
    }

    const pooled = aggregateEntries(entries)
    const bySlice: Record<string, Record<string, number>> = { ...pooled.abilitySlices }
    const metrics: Record<string, number> = {
      passAccuracy: pooled.passAccuracy,
      passedQuestions: pooled.passedQuestions,
      totalQuestions: pooled.questionCount,
      coveredAbilities: pooled.coveredAbilities,
    }

    const scales = (["1M", "10M"] as const).filter((scale) =>
      entries.some((entry) => entry.scale === scale)
    )
    const tierScores: number[] = []
    const tierPassAccuracies: number[] = []
    let allTiersOfficial = true
    let singleTierOfficial = false
    for (const scale of scales) {
      const tierEntries = entries.filter((entry) => entry.scale === scale)
      const tier = aggregateEntries(tierEntries)
      const expected = BEAM_OFFICIAL_TIER_COUNTS[scale]
      const officialQuestionSet =
        tierEntries.length === expected.questions &&
        BEAM_ABILITY_IDS.every(
          (ability) =>
            tierEntries.filter((entry) => entry.ability === ability).length ===
            expected.questionsPerAbility
        )
      const metricSuffix = officialQuestionSet ? scale : `${scale}Partial`
      metrics[`beamScore${metricSuffix}`] = tier.score
      metrics[`passAccuracy${metricSuffix}`] = tier.passAccuracy
      metrics[`questionCount${scale}`] = tier.questionCount
      metrics[`officialQuestionSet${scale}`] = officialQuestionSet ? 1 : 0
      tierScores.push(tier.score)
      tierPassAccuracies.push(tier.passAccuracy)
      allTiersOfficial &&= officialQuestionSet
      singleTierOfficial = officialQuestionSet
      bySlice[`tier:${scale}`] = {
        averageScore: tier.score,
        passAccuracy: tier.passAccuracy,
        questionCount: tier.questionCount,
        passedQuestions: tier.passedQuestions,
        coveredAbilities: tier.coveredAbilities,
        officialQuestionSet: officialQuestionSet ? 1 : 0,
      }
      for (const [ability, values] of Object.entries(tier.abilitySlices)) {
        bySlice[`tier:${scale}/ability:${ability}`] = values
      }
    }

    if (scales.length > 1) {
      const score = mean(tierScores)
      const secondaryKey =
        allTiersOfficial && entries.every((entry) => entry.scale !== undefined)
          ? "beamTierMacroAverageSecondary"
          : "beamTierMacroAverageSecondaryPartial"
      metrics[secondaryKey] = score
      metrics.passAccuracyTierMacro = mean(tierPassAccuracies)
      metrics.beamAbilityPooledAverage = pooled.score
      metrics.beamQuestionMicroAverage = mean(entries.map((entry) => entry.score))
      return {
        metrics,
        bySlice,
      }
    }

    const primaryKey =
      scales.length === 1 &&
      singleTierOfficial &&
      entries.every((entry) => entry.scale === scales[0])
        ? "beamScore"
        : "beamScorePartial"
    metrics[primaryKey] = pooled.score

    return {
      primaryMetric: { key: primaryKey, value: pooled.score, higherIsBetter: true },
      metrics,
      bySlice,
    }
  }
}

const BEAM_EVALUATOR_IMPLEMENTATION_SHA256 = stableSha256({
  protocolEvaluateQuestion: BeamPaperProtocol.prototype.evaluateQuestion.toString(),
  rubricValidation: getRubric.toString(),
  arithmeticMean: mean.toString(),
  nuggetPromptBuilder: buildBeamPaperNuggetPrompt.toString(),
  eventPromptBuilder: buildBeamEventEquivalencePrompt.toString(),
  nuggetJudgmentSchema: createBeamNuggetJudgmentSchema.toString(),
  eventEquivalenceSchema: createBeamEventEquivalenceSchema.toString(),
  nuggetProgressSchema: createBeamNuggetProgressSchema.toString(),
  eventProgressSchema: createBeamEventProgressSchema.toString(),
  eventExtraction: extractBeamPredictedEvents.toString(),
  eventAlignment: alignBeamEvents.toString(),
  eventRankVectors: buildBeamEventRankVectors.toString(),
  kendallTauB: computeKendallTauB.toString(),
  eventScore: scoreAlignedBeamEvents.toString(),
  eventEvaluation: evaluateBeamEventOrdering.toString(),
})

export const BEAM_STRUCTURED_OUTPUT_SCHEMA_SHA256 = stableSha256({
  nuggetJudgmentSchema: createBeamNuggetJudgmentSchema.toString(),
  eventEquivalenceSchema: createBeamEventEquivalenceSchema.toString(),
  nuggetProgressSchema: createBeamNuggetProgressSchema.toString(),
  eventProgressSchema: createBeamEventProgressSchema.toString(),
})

export const BEAM_AGGREGATION_IMPLEMENTATION_SHA256 = stableSha256({
  aggregateQuality: BeamPaperProtocol.prototype.aggregateQuality.toString(),
  arithmeticMean: mean.toString(),
})

export const BEAM_EVALUATOR_IDENTITY: BeamEvaluatorIdentity = {
  protocolId: BEAM_PAPER_PROTOCOL_ID,
  paperId: BEAM_PAPER_ID,
  paperRevision: BEAM_PAPER_REVISION,
  paperPdfSha256: BEAM_PAPER_PDF_SHA256,
  referenceRepository: BEAM_REFERENCE_REPOSITORY,
  referenceCommit: BEAM_REFERENCE_COMMIT,
  nuggetPromptVersion: BEAM_NUGGET_JUDGE_PROMPT_VERSION,
  nuggetPromptSha256: sha256Text(BEAM_NUGGET_JUDGE_PROMPT),
  eventEquivalencePromptVersion: BEAM_EVENT_EQUIVALENCE_PROMPT_VERSION,
  eventEquivalencePromptSha256: sha256Text(
    `${BEAM_EVENT_EQUIVALENCE_SYSTEM_PROMPT}\n\n${BEAM_EVENT_EQUIVALENCE_USER_PROMPT}`
  ),
  evaluatorImplementationSha256: BEAM_EVALUATOR_IMPLEMENTATION_SHA256,
  judgeProvider: "openai",
  judgeModel: "gpt-4.1-mini",
  structuredOutputSchemaVersion: "beam-paper-structured-output-v1",
  structuredOutputSchemaSha256: BEAM_STRUCTURED_OUTPUT_SCHEMA_SHA256,
  structuredOutputMode: "ai-sdk-generate-object-json-schema-v1",
  kendallTauImplementation: BEAM_KENDALL_TAU_IMPLEMENTATION,
  eventExtractionVersion: BEAM_EVENT_EXTRACTION_VERSION,
  eventOrderingScoringVersion: BEAM_EVENT_ORDERING_SCORING_VERSION,
  temperature: 0,
  maxOutputTokens: 512,
  maxAttempts: 3,
  timeoutMs: 120_000,
  retryPolicy: "immediate-transport-or-schema-retry-v1",
}

export const beamPaperProtocol = new BeamPaperProtocol()
