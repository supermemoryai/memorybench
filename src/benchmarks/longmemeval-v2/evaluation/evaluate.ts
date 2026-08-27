import type { EvaluationArtifact } from "../../../types/migration"
import { stableHash } from "../../../core/canonical"
import { extractBoxedAnswer, isUnknownAnswer } from "./answer"
import {
  buildStrictJudgeMessages,
  parseStrictJudgeResponse,
  StrictJudgeError,
  type StrictJudgeCallback,
  type StrictJudgeRequest,
} from "./judges"
import { evaluateDeterministicSpec, parseEvaluationSpec, type LlmEvaluatorName } from "./specs"

export const LONGMEMEVAL_V2_EVALUATOR_IMPLEMENTATION_VERSION =
  "longmemeval-v2-official-evaluator-v1"
export const DETERMINISTIC_PROMPT_VERSION = "deterministic-no-prompt-v1"

export interface LongMemEvalV2EvaluationInput {
  questionId: string
  questionType: string
  question: string
  responseText: string
  groundTruth: string
  evalFunction: string
  evaluatorModel?: string
  evaluatorSettings?: {
    reasoningEffort?: string
    maxCompletionTokens?: number
    temperature?: number
    topP?: number
  }
  judge?: StrictJudgeCallback
  createdAt?: string
}

function requireNonEmpty(options: Record<string, unknown>): boolean {
  const value = options.require_non_empty
  if (value === undefined) return true
  if (typeof value !== "boolean") throw new Error("require_non_empty must be a boolean")
  return value
}

function validateQuestionTypeForJudge(evaluatorName: LlmEvaluatorName, questionType: string): void {
  if (evaluatorName === "llm_abstention_checker" && !questionType.includes("-abs")) {
    throw new Error(
      `llm_abstention_checker question must use an -abs question_type: ${questionType}`
    )
  }
  if (evaluatorName === "llm_gotchas_checker" && questionType !== "errors-gotchas") {
    throw new Error(
      `llm_gotchas_checker question must use errors-gotchas question_type: ${questionType}`
    )
  }
}

export function longMemEvalV2EvaluatorFingerprint(input: {
  questionId: string
  responseText: string
  groundTruth: string
  evalFunction: string
  evaluatorModel?: string
  evaluatorSettings?: LongMemEvalV2EvaluationInput["evaluatorSettings"]
  promptVersion: string
}): string {
  return stableHash({
    ...input,
    implementationVersion: LONGMEMEVAL_V2_EVALUATOR_IMPLEMENTATION_VERSION,
  })
}

function artifact(input: {
  evaluation: LongMemEvalV2EvaluationInput
  parsedAnswer: string
  score: 0 | 1
  promptVersion: string
  durationMs: number
  request?: StrictJudgeRequest
  rawResponse?: unknown
  rationale?: string
}): EvaluationArtifact {
  const { evaluation } = input
  return {
    schemaVersion: 1,
    questionId: evaluation.questionId,
    evaluatorFingerprint: longMemEvalV2EvaluatorFingerprint({
      questionId: evaluation.questionId,
      responseText: evaluation.responseText,
      groundTruth: evaluation.groundTruth,
      evalFunction: evaluation.evalFunction,
      evaluatorModel: evaluation.evaluatorModel,
      evaluatorSettings: evaluation.evaluatorSettings,
      promptVersion: input.promptVersion,
    }),
    evalFunction: evaluation.evalFunction,
    answer: input.parsedAnswer,
    groundTruth: evaluation.groundTruth,
    score: input.score,
    label: input.score === 1 ? "correct" : "incorrect",
    evaluatorModel: evaluation.evaluatorModel,
    promptVersion: input.promptVersion,
    implementationVersion: LONGMEMEVAL_V2_EVALUATOR_IMPLEMENTATION_VERSION,
    request: input.request ? { ...input.request } : undefined,
    rawResponse: input.rawResponse,
    rationale: input.rationale,
    durationMs: input.durationMs,
    createdAt: evaluation.createdAt ?? new Date().toISOString(),
  }
}

/**
 * Dispatch one reader response through the exact evaluator named by the
 * dataset row. LLM judging is injected so this module never owns credentials
 * or performs an implicit network call.
 */
export async function evaluateLongMemEvalV2(
  input: LongMemEvalV2EvaluationInput
): Promise<EvaluationArtifact> {
  const startedAt = performance.now()
  const spec = parseEvaluationSpec(input.evalFunction)
  const parsedAnswer = extractBoxedAnswer(input.responseText)
  const unknown = isUnknownAnswer(parsedAnswer)

  if (spec.name !== "llm_abstention_checker" && spec.name !== "llm_gotchas_checker") {
    const evaluatedScore = evaluateDeterministicSpec(spec, parsedAnswer, input.groundTruth) ? 1 : 0
    return artifact({
      evaluation: input,
      parsedAnswer,
      score: unknown ? 0 : evaluatedScore,
      promptVersion: DETERMINISTIC_PROMPT_VERSION,
      durationMs: performance.now() - startedAt,
      rationale: unknown
        ? "Exact UNKNOWN answers are forced incorrect by the benchmark protocol."
        : undefined,
    })
  }

  validateQuestionTypeForJudge(spec.name, input.questionType)
  const prompt = buildStrictJudgeMessages(spec.name, {
    question: input.question,
    referenceAnswer: input.groundTruth,
    modelFullResponse: input.responseText,
    modelFinalAnswer: parsedAnswer,
  })
  const request: StrictJudgeRequest = {
    kind: prompt.kind,
    evaluatorName: spec.name,
    promptVersion: prompt.promptVersion,
    messages: prompt.messages,
    model: input.evaluatorModel,
    reasoningEffort: input.evaluatorSettings?.reasoningEffort,
    maxCompletionTokens: input.evaluatorSettings?.maxCompletionTokens,
    temperature: input.evaluatorSettings?.temperature,
    topP: input.evaluatorSettings?.topP,
  }

  if (requireNonEmpty(spec.options) && (!input.responseText.trim() || !input.groundTruth.trim())) {
    return artifact({
      evaluation: input,
      parsedAnswer,
      score: 0,
      promptVersion: prompt.promptVersion,
      durationMs: performance.now() - startedAt,
      request,
      rationale: "Prediction and reference answer must both be non-empty.",
    })
  }
  if (!input.judge) {
    throw new StrictJudgeError(`${spec.name} requires an injected strict judge callback`, request)
  }

  let callbackResult: Awaited<ReturnType<StrictJudgeCallback>>
  try {
    callbackResult = await input.judge(request)
  } catch (cause) {
    throw new StrictJudgeError("Strict evaluator callback failed", request, { cause })
  }

  const rawResponse = callbackResult.rawResponse ?? callbackResult.text
  let parsed
  try {
    parsed = parseStrictJudgeResponse(callbackResult.text)
  } catch (cause) {
    throw new StrictJudgeError("Strict evaluator response could not be parsed", request, {
      rawResponse,
      cause,
    })
  }

  return artifact({
    evaluation: input,
    parsedAnswer,
    score: unknown ? 0 : parsed.label,
    promptVersion: prompt.promptVersion,
    durationMs: performance.now() - startedAt,
    request,
    rawResponse,
    rationale: unknown
      ? `${parsed.rationale}${
          parsed.rationale ? " " : ""
        }Exact UNKNOWN answers are forced incorrect by the benchmark protocol.`
      : parsed.rationale,
  })
}
