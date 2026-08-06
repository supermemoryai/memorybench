import type { BenchmarkProtocol, ProtocolIdentity } from "../types/protocol"
import type { ProviderPrompts } from "../types/prompts"
import { buildContextString } from "../types/prompts"
import { buildDefaultAnswerPrompt } from "../prompts/defaults"
import { sha256Text, stableSha256 } from "../utils/stable"

const LEGACY_VERSION = "1.1.0"

function renderLegacyAnswerPrompt(
  question: string,
  context: unknown[],
  questionDate: string | undefined,
  prompts?: ProviderPrompts
): string {
  if (prompts?.answerPrompt) {
    if (typeof prompts.answerPrompt === "function") {
      return prompts.answerPrompt(question, context, questionDate)
    }

    return prompts.answerPrompt
      .replace("{{question}}", question)
      .replace("{{questionDate}}", questionDate || "Not specified")
      .replace("{{context}}", buildContextString(context))
  }

  return buildDefaultAnswerPrompt(question, context, questionDate)
}

function identity(protocol: LegacyBenchmarkProtocol): ProtocolIdentity {
  const ingestion = {
    policy: "legacy-stringified-session-json-v1",
    customId: "sessionId",
    metadata: "sessionId-and-optional-documentDate-from-metadata-date",
    formattedDatePolicy: "optional-human-readable-content-prefix",
    messageProjection: "stringified-session-messages",
    executionPolicy: protocol.ingestionExecutionPolicy,
    implementationSha256: sha256Text(protocol.createIngestionPlan.toString()),
  }
  const retrieval = { requestedTopK: 10, answerCutoff: 10, threshold: 0.3 }
  const answer = { formatter: "legacy-provider-prompt-or-default", version: 1 }
  const evaluator = {
    evaluator: "configured-generic-judge",
    version: 1,
    auxiliaryRetrievalEvaluation: protocol.auxiliaryRetrievalEvaluation,
  }
  const aggregation = { primary: "accuracy", passThreshold: 1 }

  return {
    id: "memorybench.legacy",
    version: LEGACY_VERSION,
    configFingerprint: stableSha256({ ingestion, retrieval, answer, evaluator, aggregation }),
    implementationFingerprint: stableSha256({
      protocol: "legacy",
      version: LEGACY_VERSION,
      ingestion,
    }),
    ingestionPolicyHash: stableSha256(ingestion),
    retrievalPolicyHash: stableSha256(retrieval),
    answerPromptHash: stableSha256(answer),
    evaluatorHash: stableSha256(evaluator),
    aggregationHash: stableSha256(aggregation),
    details: { ingestionPolicy: ingestion },
  }
}

export class LegacyBenchmarkProtocol implements BenchmarkProtocol {
  readonly auxiliaryRetrievalEvaluation = "legacy-llm-relevance-v1" as const
  readonly ingestionExecutionPolicy = {
    readinessBarrier: "after-build",
    processingMode: "provider-default",
  } as const
  readonly identity: ProtocolIdentity

  constructor() {
    this.identity = identity(this)
  }

  validateQuestion(question: Parameters<BenchmarkProtocol["validateQuestion"]>[0]): void {
    if (!question.questionId || !question.question.trim()) {
      throw new Error("Legacy benchmark question must have a non-empty ID and question")
    }
  }

  createIngestionPlan({ sessions }: Parameters<BenchmarkProtocol["createIngestionPlan"]>[0]) {
    return sessions.map((session) => {
      const formattedDate = session.metadata?.formattedDate
      const sourceDate = session.metadata?.date
      const documentDate = typeof sourceDate === "string" ? sourceDate : undefined
      const serialized = JSON.stringify(session.messages)
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
      const content =
        typeof formattedDate === "string" && formattedDate
          ? `Here is the date the following session took place: ${formattedDate}\n\nHere is the session as a stringified JSON:\n${serialized}`
          : `Here is the session as a stringified JSON:\n${serialized}`

      return {
        customId: session.sessionId,
        content,
        metadata: {
          sessionId: session.sessionId,
          ...(documentDate ? { documentDate } : {}),
        },
        messages: session.messages,
      }
    })
  }

  createRetrievalPlan({ question }: Parameters<BenchmarkProtocol["createRetrievalPlan"]>[0]) {
    return {
      query: question.question,
      requestedTopK: 10,
      answerCutoff: 10,
      threshold: 0.3,
    }
  }

  createAnswerPlan({
    question,
    results,
    questionDate,
    providerPrompts,
  }: Parameters<BenchmarkProtocol["createAnswerPlan"]>[0]) {
    const prompt = renderLegacyAnswerPrompt(
      question.question,
      results,
      questionDate,
      providerPrompts
    )
    const basePrompt = renderLegacyAnswerPrompt(
      question.question,
      [],
      questionDate,
      providerPrompts
    )

    return {
      request: { prompt },
      baseRequest: { prompt: basePrompt },
      answerEvidenceCount: results.length,
    }
  }

  async evaluateQuestion(
    { question, hypothesis, providerPrompts }: Parameters<BenchmarkProtocol["evaluateQuestion"]>[0],
    runtime: Parameters<BenchmarkProtocol["evaluateQuestion"]>[1]
  ) {
    const result = await runtime.evaluateLegacy({
      question: question.question,
      questionType: question.questionType,
      groundTruth: question.groundTruth,
      hypothesis,
      providerPrompts,
    })

    return {
      questionId: question.questionId,
      questionType: question.questionType,
      primaryScore: result.score,
      passed: result.label === "correct",
      label: result.label,
      explanation: result.explanation,
      details: result.details,
    }
  }

  aggregateQuality({ evaluations }: Parameters<BenchmarkProtocol["aggregateQuality"]>[0]) {
    const total = evaluations.length
    const passed = evaluations.filter((evaluation) => evaluation.passed).length
    const accuracy = total > 0 ? passed / total : 0

    return {
      primaryMetric: { key: "accuracy", value: accuracy, higherIsBetter: true },
      metrics: { accuracy, passed, total },
    }
  }
}

export const legacyBenchmarkProtocol = new LegacyBenchmarkProtocol()
