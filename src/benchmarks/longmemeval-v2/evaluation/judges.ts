import type { LlmEvaluatorName } from "./specs"

export const ABSTENTION_JUDGE_PROMPT_VERSION = "longmemeval-v2-abstention-v1"
export const GOTCHA_JUDGE_PROMPT_VERSION = "longmemeval-v2-gotcha-v1"

export interface JudgeMessage {
  role: "system" | "user"
  content: string
}

export interface StrictJudgeRequest {
  kind: "abstention" | "gotcha"
  evaluatorName: LlmEvaluatorName
  promptVersion: string
  messages: JudgeMessage[]
  model?: string
  reasoningEffort?: string
  maxCompletionTokens?: number
  temperature?: number
  topP?: number
}

export interface StrictJudgeCallbackResult {
  text: string
  rawResponse?: unknown
  durationMs?: number
}

export type StrictJudgeCallback = (
  request: StrictJudgeRequest
) => Promise<StrictJudgeCallbackResult>

export interface ParsedJudgeResponse {
  label: 0 | 1
  rationale: string
}

const ABSTENTION_SYSTEM_PROMPT =
  "You are a strict grader for flawed-premise (abstention) questions. " +
  "Judge whether a model answer correctly identifies that the question premise is wrong, " +
  "consistent with the reference answer. " +
  "If the model follows the flawed premise and gives a concrete answer under that premise, " +
  "it must be graded 0. " +
  "If the model's final answer is just UNKNOWN / cannot determine without identifying the flaw, grade 0. " +
  "If the model is contradictory (both rejects premise and also gives a concrete premise-following answer), grade 0. " +
  "Paraphrases are allowed when they preserve the same core flaw described by the reference answer."

const GOTCHA_SYSTEM_PROMPT =
  "You are a strict grader for gotchas-style insight questions. " +
  "The reference answer describes the key insight(s). " +
  "Grade 1 if the model response includes at least one correct insight point from the reference answer " +
  "(paraphrase allowed), and does not contradict any reference point. " +
  "If the model's direction is wrong, or it contains contradictions against any reference point, grade 0. " +
  "If the model gives multiple points, partial coverage is enough for 1 as long as no contradictions appear."

function abstentionUserPrompt(input: JudgePromptInput): string {
  return (
    "Evaluate whether the model correctly handled a flawed-premise question.\n\n" +
    "Question:\n" +
    `${input.question}\n\n` +
    "Reference answer (the expected flaw-aware conclusion):\n" +
    `${input.referenceAnswer}\n\n` +
    "Model full response:\n" +
    `${input.modelFullResponse}\n\n` +
    "Model extracted final answer:\n" +
    `${input.modelFinalAnswer}\n\n` +
    "Scoring rubric:\n" +
    "- Label 1 only if the model clearly identifies the flawed premise and reaches a conclusion " +
    "equivalent to the reference answer.\n" +
    "- Label 1 also if the model explicitly says it lacks access to the user's specific " +
    "live environment/instance/configuration and therefore cannot verify, provided it does not " +
    "give a concrete premise-following answer.\n" +
    "- Label 0 if the model follows the flawed premise and gives a concrete answer under that premise.\n" +
    "- Label 0 for generic UNKNOWN/insufficient-info replies that do not identify a flaw and do not " +
    "make the explicit environment-access limitation clear.\n" +
    "- Label 0 if contradictory.\n\n" +
    "Output JSON only:\n" +
    '{"label": 0 or 1, "reason": "short rationale"}'
  )
}

function gotchaUserPrompt(input: JudgePromptInput): string {
  return (
    "Evaluate whether the model answer captures the gotcha insight.\n\n" +
    "Question:\n" +
    `${input.question}\n\n` +
    "Reference answer (insight points):\n" +
    `${input.referenceAnswer}\n\n` +
    "Model full response:\n" +
    `${input.modelFullResponse}\n\n` +
    "Model extracted final answer:\n" +
    `${input.modelFinalAnswer}\n\n` +
    "Scoring rubric:\n" +
    "- Label 1 if the model includes at least one correct insight point from the reference answer " +
    "(paraphrase acceptable), and does not contradict any reference point.\n" +
    "- Label 1 even if only part of a multi-point reference answer is covered, as long as there is " +
    "no contradiction.\n" +
    "- Label 0 if direction is wrong (suggests opposite action/cause), even if some wording overlaps.\n" +
    "- Label 0 if any point in the model response contradicts any reference point.\n" +
    "- Label 0 if the response is irrelevant or generic without insight.\n\n" +
    "Output JSON only:\n" +
    '{"label": 0 or 1, "reason": "short rationale"}'
  )
}

export interface JudgePromptInput {
  question: string
  referenceAnswer: string
  modelFullResponse: string
  modelFinalAnswer: string
}

export function buildStrictJudgeMessages(
  evaluatorName: LlmEvaluatorName,
  input: JudgePromptInput
): {
  kind: StrictJudgeRequest["kind"]
  promptVersion: string
  messages: JudgeMessage[]
} {
  if (evaluatorName === "llm_abstention_checker") {
    return {
      kind: "abstention",
      promptVersion: ABSTENTION_JUDGE_PROMPT_VERSION,
      messages: [
        { role: "system", content: ABSTENTION_SYSTEM_PROMPT },
        { role: "user", content: abstentionUserPrompt(input) },
      ],
    }
  }
  if (evaluatorName === "llm_gotchas_checker") {
    return {
      kind: "gotcha",
      promptVersion: GOTCHA_JUDGE_PROMPT_VERSION,
      messages: [
        { role: "system", content: GOTCHA_SYSTEM_PROMPT },
        { role: "user", content: gotchaUserPrompt(input) },
      ],
    }
  }
  throw new Error(`Unsupported strict LLM evaluator: ${evaluatorName}`)
}

function stripMarkdownCodeFence(text: string): string {
  const stripped = text.trim()
  if (stripped.startsWith("```") && stripped.endsWith("```")) {
    const lines = stripped.split(/\r?\n/u)
    if (lines.length >= 3) return lines.slice(1, -1).join("\n").trim()
  }
  return stripped
}

function parseLabel(value: unknown): 0 | 1 | undefined {
  if (value === 0 || value === "0") return 0
  if (value === 1 || value === "1") return 1
  return undefined
}

export function parseStrictJudgeResponse(text: string): ParsedJudgeResponse {
  const cleaned = stripMarkdownCodeFence(String(text ?? "").trim())
  if (!cleaned) throw new Error("Empty judgement response from evaluator model")

  const objectMatch = cleaned.match(/\{.*\}/su)
  if (objectMatch) {
    try {
      const payload = JSON.parse(objectMatch[0]) as unknown
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        const record = payload as Record<string, unknown>
        const label = parseLabel(record.label)
        if (label !== undefined) {
          return {
            label,
            rationale:
              record.reason === null || record.reason === undefined
                ? ""
                : String(record.reason).trim(),
          }
        }
      }
    } catch {
      // The reference implementation next accepts JSON-like label output.
    }
  }

  const patterns = [
    /"label"\s*:\s*([01])/iu,
    /'label'\s*:\s*([01])/iu,
    /\blabel\b\s*[:=]\s*([01])/iu,
  ]
  for (const pattern of patterns) {
    const match = cleaned.match(pattern)
    if (match) {
      return { label: Number.parseInt(match[1], 10) as 0 | 1, rationale: cleaned }
    }
  }

  throw new Error(`Could not parse evaluator binary judgement: ${JSON.stringify(cleaned)}`)
}

export class StrictJudgeError extends Error {
  readonly request: StrictJudgeRequest
  readonly rawResponse?: unknown

  constructor(
    message: string,
    request: StrictJudgeRequest,
    options: { rawResponse?: unknown; cause?: unknown } = {}
  ) {
    super(message, { cause: options.cause })
    this.name = "StrictJudgeError"
    this.request = request
    this.rawResponse = options.rawResponse
  }
}
