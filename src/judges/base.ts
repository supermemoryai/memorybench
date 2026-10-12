import type { JudgeInput, JudgeResult } from "../types/judge"
import type { ProviderPrompts } from "../types/prompts"
import { getJudgePromptForType } from "../prompts/defaults"

export function getJudgePrompt(questionType: string, providerPrompts?: ProviderPrompts): string {
  return getJudgePromptForType(questionType)
}

export function buildJudgePrompt(input: JudgeInput): string {
  if (input.promptOverride) return input.promptOverride

  if (input.providerPrompts?.judgePrompt) {
    const prompts = input.providerPrompts.judgePrompt(
      input.question,
      input.groundTruth,
      input.hypothesis
    )
    return prompts[input.questionType] ?? prompts.default
  }

  const systemPrompt = getJudgePromptForType(input.questionType)
  const isPreference = input.questionType.toLowerCase().includes("preference")
  const groundTruthLabel = isPreference ? "Rubric" : "Ground Truth Answer"

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
    // Correct if score is 1 or the label is "correct" in any case
    const label = String(parsed.label ?? "").toLowerCase()
    const correct = parsed.score === 1 || label === "correct"
    const explanation =
      parsed.explanation || response.slice(0, response.indexOf(jsonMatch[0])).trim() || ""
    return {
      score: correct ? 1 : 0,
      label: correct ? "correct" : "incorrect",
      explanation,
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
