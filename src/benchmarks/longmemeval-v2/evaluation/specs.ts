export const DETERMINISTIC_EVALUATOR_NAMES = [
  "norm_phrase_set_match",
  "norm_phrase_set_match_ordered",
  "mc_choice_match",
  "mc_choice_set_match",
] as const

export const LLM_EVALUATOR_NAMES = ["llm_abstention_checker", "llm_gotchas_checker"] as const

export type DeterministicEvaluatorName = (typeof DETERMINISTIC_EVALUATOR_NAMES)[number]
export type LlmEvaluatorName = (typeof LLM_EVALUATOR_NAMES)[number]
export type LongMemEvalV2EvaluatorName = DeterministicEvaluatorName | LlmEvaluatorName

export interface ParsedEvaluationSpec {
  name: LongMemEvalV2EvaluatorName
  options: Record<string, unknown>
}

const EVALUATOR_NAMES = new Set<string>([...DETERMINISTIC_EVALUATOR_NAMES, ...LLM_EVALUATOR_NAMES])

const DEFAULT_SEPARATORS = [",", ";"]
const MULTI_SELECT_FILLER_WORDS = new Set([
  "AND",
  "ANSWER",
  "ANSWERS",
  "CHOICE",
  "CHOICES",
  "FINAL",
  "LETTER",
  "LETTERS",
  "OPTION",
  "OPTIONS",
])

function parseOptionValue(key: string, value: string): unknown {
  const lowered = value.toLowerCase()
  if (lowered === "true" || lowered === "false") return lowered === "true"
  if (lowered === "none" || lowered === "null") return null

  if (key === "separators" || key === "separator") {
    if (value.length === 0) return []
    const stripped = value.trim()
    if (stripped.startsWith("[") && stripped.endsWith("]")) {
      const parsed = JSON.parse(stripped) as unknown
      if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
        throw new Error(`${key} must be a JSON array of strings`)
      }
      return parsed
    }
    return [...value].filter((character) => character.trim().length > 0)
  }

  if (/^[+-]?(?:\d+\.\d*|\.\d+)$/.test(value)) return Number.parseFloat(value)
  if (/^[+-]?\d+$/.test(value)) return Number.parseInt(value, 10)
  return value
}

export function parseEvaluationSpec(spec: string): ParsedEvaluationSpec {
  if (typeof spec !== "string" || spec.trim().length === 0) {
    throw new Error("eval function spec must be a non-empty string")
  }

  const parts = spec.split("|").map((part) => part.trim())
  const name = parts[0]
  if (!name) throw new Error("eval function spec missing function name")
  if (!EVALUATOR_NAMES.has(name)) throw new Error(`Unknown eval function: ${name}`)

  const options: Record<string, unknown> = {}
  for (const part of parts.slice(1)) {
    if (!part) continue
    const equalsIndex = part.indexOf("=")
    if (equalsIndex === -1) throw new Error(`Invalid eval function option: ${part}`)
    const key = part.slice(0, equalsIndex).trim()
    const value = part.slice(equalsIndex + 1).trim()
    if (!key) throw new Error(`Invalid eval function option: ${part}`)
    if (Object.hasOwn(options, key)) throw new Error(`Duplicate eval function option: ${key}`)
    options[key] = parseOptionValue(key, value)
  }

  return { name: name as LongMemEvalV2EvaluatorName, options }
}

function booleanOption(
  options: Record<string, unknown>,
  key: string,
  defaultValue: boolean
): boolean {
  const value = options[key]
  if (value === undefined) return defaultValue
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`)
  return value
}

function stringOption(options: Record<string, unknown>, key: string, defaultValue: string): string {
  const value = options[key]
  if (value === undefined) return defaultValue
  if (typeof value !== "string") throw new Error(`${key} must be a string`)
  return value
}

function separatorsOption(options: Record<string, unknown>): string[] {
  const value = options.separators ?? options.separator
  if (value === undefined) return DEFAULT_SEPARATORS
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("separators must be an array of strings")
  }
  return value
}

export function normalizePhrase(text: unknown, options: Record<string, unknown> = {}): string {
  if (text === null || text === undefined) return ""
  let normalized = typeof text === "string" ? text : String(text)
  if (booleanOption(options, "lower", true)) normalized = normalized.toLowerCase()
  if (booleanOption(options, "normalize_hyphen", true)) {
    normalized = normalized.replaceAll("-", " ").replaceAll("_", " ")
  }
  normalized = normalized.replace(/[,;]/gu, " ")
  if (booleanOption(options, "strip_punct", true)) {
    normalized = normalized.replace(/[^\p{L}\p{N}_\s]/gu, "")
  }
  return normalized.replace(/\s+/gu, " ").trim()
}

export function splitPhrases(text: unknown, options: Record<string, unknown> = {}): string[] {
  if (text === null || text === undefined) return []
  const separators = separatorsOption(options)
  if (separators.length === 0) {
    const normalized = normalizePhrase(text, options)
    return normalized ? [normalized] : []
  }
  const escaped = separators.map((separator) => separator.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
  return String(text)
    .split(new RegExp(escaped.join("|"), "gu"))
    .map((part) => normalizePhrase(part, options))
    .filter(Boolean)
}

function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && /[\p{L}\p{N}_]/u.test(character)
}

function findWholePhrase(text: string, phrase: string, start: number): number {
  let index = text.indexOf(phrase, start)
  while (index !== -1) {
    const end = index + phrase.length
    if (!isWordCharacter(text[index - 1]) && !isWordCharacter(text[end])) return end
    index = text.indexOf(phrase, index + 1)
  }
  return -1
}

export function normalizedPhraseSetMatch(
  prediction: unknown,
  answer: unknown,
  options: Record<string, unknown> = {}
): boolean {
  const normalizedPrediction = normalizePhrase(prediction, options)
  const answerPhrases = splitPhrases(answer, options)
  if (
    booleanOption(options, "require_non_empty", true) &&
    (!normalizedPrediction || answerPhrases.length === 0)
  ) {
    return false
  }
  for (const phrase of new Set(answerPhrases)) {
    if (findWholePhrase(normalizedPrediction, phrase, 0) === -1) return false
  }
  return true
}

export function normalizedPhraseSetMatchOrdered(
  prediction: unknown,
  answer: unknown,
  options: Record<string, unknown> = {}
): boolean {
  const normalizedPrediction = normalizePhrase(prediction, options)
  const answerPhrases = splitPhrases(answer, options)
  if (
    booleanOption(options, "require_non_empty", true) &&
    (!normalizedPrediction || answerPhrases.length === 0)
  ) {
    return false
  }
  let start = 0
  for (const phrase of answerPhrases) {
    const end = findWholePhrase(normalizedPrediction, phrase, start)
    if (end === -1) return false
    start = end
  }
  return true
}

export function multipleChoiceMatch(
  prediction: unknown,
  answer: unknown,
  options: Record<string, unknown> = {}
): boolean {
  if (prediction === null || prediction === undefined || answer === null || answer === undefined) {
    return false
  }
  const predictionText = String(prediction)
  const boxedMatch = predictionText.toLowerCase().match(/\\boxed\{([^}]*)\}/u)
  let candidate = boxedMatch?.[1] ?? predictionText
  candidate = candidate.replace(/\b(choice|option)\b/giu, "")
  for (const character of stringOption(options, "strip_chars", ".")) {
    candidate = candidate.replaceAll(character, "")
  }
  const cleaned = candidate.trim().toUpperCase()
  const expected = String(answer).trim().toUpperCase()
  if (booleanOption(options, "require_non_empty", true) && (!cleaned || !expected)) {
    return false
  }
  return cleaned === expected
}

function extractMultiSelectLetters(text: unknown): string[] {
  if (text === null || text === undefined) return []
  const chunks =
    String(text)
      .toUpperCase()
      .match(/[A-Z]+/gu) ?? []
  const letters: string[] = []
  for (const chunk of chunks) {
    if (!MULTI_SELECT_FILLER_WORDS.has(chunk)) letters.push(...chunk)
  }
  return letters
}

export function multipleChoiceSetMatch(
  prediction: unknown,
  answer: unknown,
  options: Record<string, unknown> = {}
): boolean {
  const predictionLetters = extractMultiSelectLetters(prediction)
  const answerLetters = extractMultiSelectLetters(answer)
  if (
    booleanOption(options, "require_non_empty", true) &&
    (predictionLetters.length === 0 || answerLetters.length === 0)
  ) {
    return false
  }
  const predictionSet = new Set(predictionLetters)
  const answerSet = new Set(answerLetters)
  return (
    predictionSet.size === answerSet.size &&
    [...predictionSet].every((letter) => answerSet.has(letter))
  )
}

export function evaluateDeterministicSpec(
  spec: ParsedEvaluationSpec,
  prediction: unknown,
  answer: unknown
): boolean {
  switch (spec.name) {
    case "norm_phrase_set_match":
      return normalizedPhraseSetMatch(prediction, answer, spec.options)
    case "norm_phrase_set_match_ordered":
      return normalizedPhraseSetMatchOrdered(prediction, answer, spec.options)
    case "mc_choice_match":
      return multipleChoiceMatch(prediction, answer, spec.options)
    case "mc_choice_set_match":
      return multipleChoiceSetMatch(prediction, answer, spec.options)
    default:
      throw new Error(`Eval function ${spec.name} requires an LLM judge`)
  }
}
