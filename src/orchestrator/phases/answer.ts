import { readFileSync, existsSync } from "fs"
import { createOpenAI } from "@ai-sdk/openai"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { generateText } from "ai"
import type { Benchmark } from "../../types/benchmark"
import type { RunCheckpoint } from "../../types/checkpoint"
import type { Provider } from "../../types/provider"
import { CheckpointManager } from "../checkpoint"
import { config } from "../../utils/config"
import { logger } from "../../utils/logger"
import { getModelConfig, ModelConfig, DEFAULT_ANSWERING_MODEL } from "../../utils/models"
import { buildDefaultAnswerPrompt } from "../../prompts/defaults"
import { buildContextString } from "../../types/prompts"
import { ConcurrentExecutor } from "../concurrent"
import { resolveConcurrency } from "../../types/concurrency"
import { countTokens } from "../../utils/tokens"

type LanguageModel =
  | ReturnType<typeof createOpenAI>
  | ReturnType<typeof createAnthropic>
  | ReturnType<typeof createGoogleGenerativeAI>

function getAnsweringModel(modelAlias: string): {
  client: LanguageModel
  modelConfig: ModelConfig
} {
  const modelConfig = getModelConfig(modelAlias || DEFAULT_ANSWERING_MODEL)

  switch (modelConfig.provider) {
    case "openai":
      return {
        client: createOpenAI({ apiKey: config.openaiApiKey }),
        modelConfig,
      }
    case "anthropic":
      return {
        client: createAnthropic({ apiKey: config.anthropicApiKey }),
        modelConfig,
      }
    case "google":
      return {
        client: createGoogleGenerativeAI({ apiKey: config.googleApiKey }),
        modelConfig,
      }
  }
}

function buildAnswerPrompt(
  question: string,
  context: unknown[],
  questionDate?: string,
  provider?: Provider
): string {
  if (provider?.prompts?.answerPrompt) {
    const customPrompt = provider.prompts.answerPrompt
    if (typeof customPrompt === "function") {
      return customPrompt(question, context, questionDate)
    }
    const contextStr = buildContextString(context)
    return customPrompt
      .replace("{{question}}", question)
      .replace("{{questionDate}}", questionDate || "Not specified")
      .replace("{{context}}", contextStr)
  }

  return buildDefaultAnswerPrompt(question, context, questionDate)
}

export async function runAnswerPhase(
  benchmark: Benchmark,
  checkpoint: RunCheckpoint,
  checkpointManager: CheckpointManager,
  questionIds?: string[],
  provider?: Provider
): Promise<void> {
  const questions = benchmark.getQuestions()
  const targetQuestions = questionIds
    ? questions.filter((q) => questionIds.includes(q.questionId))
    : questions

  const pendingQuestions = targetQuestions.filter((q) => {
    const status = checkpointManager.getPhaseStatus(checkpoint, q.questionId, "answer")
    const searchStatus = checkpointManager.getPhaseStatus(checkpoint, q.questionId, "search")
    const resultFile = checkpoint.questions[q.questionId]?.phases.search.resultFile
    return (
      status !== "completed" && searchStatus === "completed" && resultFile && existsSync(resultFile)
    )
  })

  if (pendingQuestions.length === 0) {
    logger.info("No questions pending answering")
    return
  }

  const { client, modelConfig } = getAnsweringModel(checkpoint.answeringModel)
  const concurrency = resolveConcurrency("answer", checkpoint.concurrency, provider?.concurrency)

  logger.info(
    `Generating answers for ${pendingQuestions.length} questions using ${modelConfig.displayName} (concurrency: ${concurrency})...`
  )

  await ConcurrentExecutor.execute(
    pendingQuestions,
    concurrency,
    checkpoint.runId,
    "answer",
    async ({ item: question, index, total }) => {
      const resultFile = checkpoint.questions[question.questionId].phases.search.resultFile!

      const startTime = Date.now()
      checkpointManager.updatePhase(checkpoint, question.questionId, "answer", {
        status: "in_progress",
        startedAt: new Date().toISOString(),
      })

      try {
        const searchData = JSON.parse(readFileSync(resultFile, "utf8"))
        const context: unknown[] = searchData.results || []
        const questionDate = checkpoint.questions[question.questionId]?.questionDate

        const basePrompt = buildAnswerPrompt(question.question, [], questionDate, provider)
        const prompt = buildAnswerPrompt(question.question, context, questionDate, provider)

        const basePromptTokens = countTokens(basePrompt, modelConfig)
        const promptTokens = countTokens(prompt, modelConfig)
        // Derive contextTokens from the difference so it reflects the actual formatted
        // context in the prompt (not the raw JSON), which matters for providers with
        // custom prompt functions that transform context (e.g. Zep's XML-like tags).
        const contextTokens = Math.max(0, promptTokens - basePromptTokens)

        const { text } = await generateText({
          model: client(modelConfig.id),
          prompt,
          maxOutputTokens: modelConfig.defaultMaxTokens,
          ...(modelConfig.supportsTemperature
            ? { temperature: modelConfig.defaultTemperature }
            : {}),
        })

        const durationMs = Date.now() - startTime
        checkpointManager.updatePhase(checkpoint, question.questionId, "answer", {
          status: "completed",
          hypothesis: text.trim(),
          promptTokens,
          basePromptTokens,
          contextTokens,
          completedAt: new Date().toISOString(),
          durationMs,
        })

        logger.progress(
          index + 1,
          total,
          `Answered ${question.questionId} (${durationMs}ms, ${promptTokens} tokens: ${basePromptTokens} base + ${contextTokens} context)`
        )
        return { questionId: question.questionId, durationMs }
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        checkpointManager.updatePhase(checkpoint, question.questionId, "answer", {
          status: "failed",
          error,
        })
        logger.error(`Failed to answer ${question.questionId}: ${error}`)
        throw new Error(
          `Answer failed at ${question.questionId}: ${error}. Fix the issue and resume with the same run ID.`
        )
      }
    }
  )

  logger.success("Answer phase complete")
}
