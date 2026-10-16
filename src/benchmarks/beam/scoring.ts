import { generateObject, type LanguageModel } from "ai"
import { z } from "zod"
import type { JudgeResult } from "../../types/judge"
import type { UnifiedQuestion } from "../../types/unified"
import { evaluateBeamEventOrdering, extractBeamPredictedEvents } from "./event-ordering"
import {
  BEAM_EVENT_EQUIVALENCE_SYSTEM_PROMPT,
  buildBeamEventEquivalencePrompt,
  buildBeamPaperNuggetPrompt,
} from "./prompts"

/** A question passes when it scores at least this (BEAM paper's secondary metric) */
const PASS_THRESHOLD = 0.5

const nuggetSchema = z.object({ score: z.number(), reason: z.string() })

/** Reasoning models reject temperature 0 and spend output tokens on reasoning */
function judgeSettings(model: LanguageModel) {
  const id = typeof model === "string" ? model : model.modelId
  return /^(gpt-5|gpt-6|o\d)/.test(id)
    ? { maxOutputTokens: 16000 }
    : { temperature: 0, maxOutputTokens: 512 }
}
const equivalenceSchema = z.object({ answer: z.enum(["YES", "NO"]) })

/** Paper Listing 20: one judgment per rubric item, scored 0, 0.5 or 1 */
async function judgeNugget(
  model: LanguageModel,
  question: string,
  nugget: string,
  answer: string
): Promise<{ score: number; reason: string }> {
  const { object } = await generateObject({
    model,
    schema: nuggetSchema,
    prompt: buildBeamPaperNuggetPrompt({ question, nugget, answer }),
    ...judgeSettings(model),
    maxRetries: 3,
  })
  if (![0, 0.5, 1].includes(object.score)) {
    throw new Error(`BEAM judge returned score ${object.score}, expected 0, 0.5 or 1`)
  }
  return object
}

/**
 * BEAM paper scoring: the mean of the rubric-item judgments, or for event ordering the
 * normalized Kendall tau-b between the reference and predicted event orders (Listing 21
 * decides which predicted line matches which reference event).
 */
export async function evaluateBeamAnswer(
  question: UnifiedQuestion,
  hypothesis: string,
  model: LanguageModel
): Promise<JudgeResult> {
  const rubric = (question.metadata?.rubric as string[] | undefined) ?? []
  if (rubric.length === 0) throw new Error(`BEAM question ${question.questionId} has no rubric`)

  let score: number
  let explanation: string
  if (question.questionType === "event_ordering") {
    const result = await evaluateBeamEventOrdering({
      referenceEvents: rubric,
      predictedEvents: extractBeamPredictedEvents(hypothesis),
      equivalent: async ({ referenceEvent, predictedEvent }) => {
        const { object } = await generateObject({
          model,
          schema: equivalenceSchema,
          system: BEAM_EVENT_EQUIVALENCE_SYSTEM_PROMPT,
          prompt: buildBeamEventEquivalencePrompt({ referenceEvent, predictedEvent }),
          ...judgeSettings(model),
          maxRetries: 3,
        })
        return object.answer === "YES"
      },
    })
    score = result.normalizedKendallTauB
    explanation = `Kendall tau-b ${result.kendall.tauB.toFixed(3)} (normalized ${score.toFixed(3)}); matched ${result.matchedCount}/${rubric.length} reference events, F1 ${result.f1.toFixed(3)}`
  } else {
    const judgments = await Promise.all(
      rubric.map((nugget) => judgeNugget(model, question.question, nugget, hypothesis))
    )
    score = judgments.reduce((sum, j) => sum + j.score, 0) / judgments.length
    explanation = judgments.map((j, i) => `[${j.score}] ${rubric[i]}: ${j.reason}`).join("\n")
  }

  return {
    score,
    label: score >= PASS_THRESHOLD ? "correct" : "incorrect",
    explanation,
  }
}
