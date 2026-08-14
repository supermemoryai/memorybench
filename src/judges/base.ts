import type { JudgeInput, JudgeResult } from "../types/judge"
import type { ProviderPrompts } from "../types/prompts"
import { getJudgePromptForType } from "../prompts/defaults"

export function getJudgePrompt(questionType: string, providerPrompts?: ProviderPrompts): string {
  return getJudgePromptForType(questionType)
}

/**
 * An abstention question is either flagged by the benchmark or identified by its type name.
 * The flag is needed because LongMemEval keeps the original question type on its abstention
 * entries and only marks them with an `_abs` question id suffix.
 */
function isAbstentionQuestion(input: JudgeInput): boolean {
  if (input.isAbstention) return true
  const type = input.questionType.toLowerCase()
  return type.includes("abstention") || type.includes("adversarial")
}

export function buildJudgePrompt(input: JudgeInput): string {
  if (input.providerPrompts?.judgePrompt) {
    const prompts = input.providerPrompts.judgePrompt(
      input.question,
      input.groundTruth,
      input.hypothesis
    )
    return prompts[input.questionType] ?? prompts.default
  }

  const isAbstention = isAbstentionQuestion(input)
  const systemPrompt = getJudgePromptForType(input.questionType, isAbstention)
  const isPreference = input.questionType.toLowerCase().includes("preference")
  const groundTruthLabel = isAbstention
    ? "Explanation"
    : isPreference
      ? "Rubric"
      : "Ground Truth Answer"

  return `${systemPrompt}

Question: ${input.question}
${groundTruthLabel}: ${input.groundTruth}
System's Hypothesis: ${input.hypothesis}`
}

export function parseJudgeResponse(response: string): JudgeResult {
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      throw new Error("No JSON found in response")
    }
    const parsed = JSON.parse(jsonMatch[0])
    return {
      score: parsed.score === 1 ? 1 : 0,
      label: parsed.label === "correct" ? "correct" : "incorrect",
      explanation: parsed.explanation || "",
    }
  } catch {
    const isCorrect =
      response.toLowerCase().includes('"correct"') &&
      !response.toLowerCase().includes('"incorrect"')
    return {
      score: isCorrect ? 1 : 0,
      label: isCorrect ? "correct" : "incorrect",
      explanation: "Failed to parse judge response",
    }
  }
}
