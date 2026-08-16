import type { JudgeInput, JudgeResult } from "../types/judge"
import type { ProviderPrompts } from "../types/prompts"
import { getJudgePromptForType } from "../prompts/defaults"

export function getJudgePrompt(questionType: string, providerPrompts?: ProviderPrompts): string {
  return getJudgePromptForType(questionType)
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

  const systemPrompt = getJudgePromptForType(input.questionType)
  const isPreference = input.questionType.toLowerCase().includes("preference")
  const groundTruthLabel = isPreference ? "Rubric" : "Ground Truth Answer"

  return `${systemPrompt}

Question: ${input.question}
${groundTruthLabel}: ${input.groundTruth}
System's Hypothesis: ${input.hypothesis}`
}

export function parseJudgeResponse(response: string): JudgeResult {
  // An empty completion is not a verdict. Now that maxOutputTokens is actually enforced,
  // a reasoning model can spend its whole ceiling on reasoning and return nothing; scoring
  // that as "incorrect" would silently mark questions wrong and skew the run's accuracy.
  // Throwing lets the evaluate phase record a real failure that a resume can retry.
  if (!response.trim()) {
    throw new Error(
      "Judge returned an empty response (likely truncated before producing a verdict — check the model's maxOutputTokens)"
    )
  }

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
