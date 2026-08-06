import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createOpenAI } from "@ai-sdk/openai"
import { generateText } from "ai"
import type { Benchmark } from "../../types/benchmark"
import type {
  AnswerAttemptMetrics,
  ProviderUsage,
  QuestionCheckpoint,
  RunCheckpoint,
} from "../../types/checkpoint"
import type { ModelRequest, ModelTransport, TerminalEmptyOutputPolicy } from "../../types/protocol"
import type { Provider } from "../../types/provider"
import { resolveConcurrency } from "../../types/concurrency"
import { config } from "../../utils/config"
import { logger } from "../../utils/logger"
import {
  DEFAULT_ANSWERING_MODEL,
  getModelConfig,
  resolveAnsweringRuntimeIdentity,
  type ModelConfig,
} from "../../utils/models"
import { stableSha256 } from "../../utils/stable"
import { countTokens } from "../../utils/tokens"
import { CheckpointManager } from "../checkpoint"
import { ConcurrentExecutor } from "../concurrent"
import { extractTokenUsageFromError } from "../evaluation-runtime"

export type LanguageModelFactory =
  | ReturnType<typeof createOpenAI>
  | ReturnType<typeof createAnthropic>
  | ReturnType<typeof createGoogleGenerativeAI>

export const ANSWER_RUNTIME_EXECUTION_VERSION = "chat-transport-durable-outer-retry-v1"

function getAnsweringModel(modelAlias: string): {
  client: LanguageModelFactory
  modelConfig: ModelConfig
} {
  const modelConfig = getModelConfig(modelAlias || DEFAULT_ANSWERING_MODEL)
  switch (modelConfig.provider) {
    case "openai":
      return { client: createOpenAI({ apiKey: config.openaiApiKey }), modelConfig }
    case "anthropic":
      return { client: createAnthropic({ apiKey: config.anthropicApiKey }), modelConfig }
    case "google":
      return { client: createGoogleGenerativeAI({ apiKey: config.googleApiKey }), modelConfig }
  }
}

function requestText(request: ModelRequest): string {
  return request.system ? `${request.system}\n\n${request.prompt}` : request.prompt
}

export function getLanguageModel(
  client: LanguageModelFactory,
  modelConfig: ModelConfig,
  transport: ModelTransport = "provider-default"
) {
  if (transport === "openai-chat-completions") {
    if (modelConfig.provider !== "openai") {
      throw new Error(
        `Model transport ${transport} requires an OpenAI answering model; received ${modelConfig.provider}`
      )
    }
    return (client as ReturnType<typeof createOpenAI>).chat(modelConfig.id)
  }
  return client(modelConfig.id)
}

export function normalizeAnsweringUsage(value: unknown): ProviderUsage {
  const usage =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
  const token = (name: string): number | undefined => {
    const candidate = usage[name]
    return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0
      ? candidate
      : undefined
  }
  const inputTokens = token("inputTokens")
  const outputTokens = token("outputTokens")
  const reasoningTokens = token("reasoningTokens")
  const reportedTotal = token("totalTokens")
  const totalTokens =
    reportedTotal ??
    (inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined)
  return {
    requestCount: 1,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  }
}

function withUsageCoverage(value: unknown): ProviderUsage {
  const usage = normalizeAnsweringUsage(value)
  const knownTokenFields = [usage.inputTokens, usage.outputTokens, usage.totalTokens].filter(
    (token) => token !== undefined
  ).length
  return {
    ...usage,
    ...(knownTokenFields === 3
      ? { tokenUsageCompleteRequestCount: 1 }
      : knownTokenFields > 0
        ? { tokenUsagePartialRequestCount: 1 }
        : { tokenUsageUnknownRequestCount: 1 }),
  }
}

export function aggregateAnswerAttemptUsage(
  attempts: readonly AnswerAttemptMetrics[]
): ProviderUsage | undefined {
  const usages = attempts.flatMap((attempt) => (attempt.usage ? [attempt.usage] : []))
  if (usages.length === 0) return undefined
  const aggregate: ProviderUsage = {}
  const additiveKeys = [
    "requestCount",
    "tokenUsageCompleteRequestCount",
    "tokenUsagePartialRequestCount",
    "tokenUsageUnknownRequestCount",
    "inputTokens",
    "outputTokens",
    "reasoningTokens",
    "totalTokens",
  ] as const
  for (const key of additiveKeys) {
    const values = usages.flatMap((usage) => (usage[key] === undefined ? [] : [usage[key]!]))
    if (values.length > 0) aggregate[key] = values.reduce((sum, value) => sum + value, 0)
  }
  return aggregate
}

export interface AnswerGenerationResult {
  text: string
  usage?: unknown
  finishReason?: string
}

export interface AnswerRetryOptions {
  maxAttempts?: number
  timeoutMs?: number
  retryBackoffMs?: number
  terminalEmptyOutputPolicy?: TerminalEmptyOutputPolicy
  attemptOffset?: number
  execute(attempt: number, abortSignal?: AbortSignal): Promise<AnswerGenerationResult>
  onAttempt(attempt: AnswerAttemptMetrics): void | Promise<void>
  sleep?(delayMs: number): Promise<void>
}

export interface GeneratedAnswerOutcome {
  hypothesis: string
  terminalEmptyAccepted: boolean
}

export function shouldRunAnswerPhase(phases: QuestionCheckpoint["phases"] | undefined): boolean {
  return phases?.answer.status !== "completed" && phases?.search.status === "completed"
}

/** Protocol-owned outer retry loop. Empty model text is retried before terminal policy applies. */
export async function generateAnswerWithRetries(
  options: AnswerRetryOptions
): Promise<GeneratedAnswerOutcome> {
  const maxAttempts = options.maxAttempts ?? 1
  const timeoutMs = options.timeoutMs
  const retryBackoffMs = options.retryBackoffMs ?? 0
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`Answer maxAttempts must be a positive integer; received ${maxAttempts}`)
  }
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1)) {
    throw new Error(`Answer timeoutMs must be a positive integer; received ${timeoutMs}`)
  }
  if (!Number.isInteger(retryBackoffMs) || retryBackoffMs < 0) {
    throw new Error(
      `Answer retryBackoffMs must be a non-negative integer; received ${retryBackoffMs}`
    )
  }

  const sleep =
    options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)))
  let lastError: unknown
  for (let localAttempt = 1; localAttempt <= maxAttempts; localAttempt++) {
    const attempt = (options.attemptOffset ?? 0) + localAttempt
    const startedAt = new Date().toISOString()
    const startedMs = Date.now()
    await options.onAttempt({ attempt, startedAt, status: "in_progress" })
    let result: AnswerGenerationResult
    try {
      result = await options.execute(
        localAttempt,
        timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs)
      )
    } catch (error) {
      const completedAt = new Date().toISOString()
      const message = error instanceof Error ? error.message : String(error)
      await options.onAttempt({
        attempt,
        startedAt,
        completedAt,
        durationMs: Date.now() - startedMs,
        status: "failed",
        usage: withUsageCoverage(extractTokenUsageFromError(error)),
        error: message,
      })
      lastError = error
      if (localAttempt < maxAttempts && retryBackoffMs > 0) {
        await sleep(retryBackoffMs * localAttempt)
      }
      continue
    }

    const completedAt = new Date().toISOString()
    const usage = withUsageCoverage(result.usage)
    const hypothesis = result.text.trim()
    if (!hypothesis) {
      const error = "Answering model returned an empty hypothesis"
      await options.onAttempt({
        attempt,
        startedAt,
        completedAt,
        durationMs: Date.now() - startedMs,
        status: "failed",
        finishReason: result.finishReason,
        ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
        usage,
        error,
      })
      lastError = new Error(error)
    } else {
      await options.onAttempt({
        attempt,
        startedAt,
        completedAt,
        durationMs: Date.now() - startedMs,
        status: "completed",
        finishReason: result.finishReason,
        ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
        usage,
      })
      return { hypothesis, terminalEmptyAccepted: false }
    }
    if (localAttempt < maxAttempts && retryBackoffMs > 0) {
      await sleep(retryBackoffMs * localAttempt)
    }
  }

  if (options.terminalEmptyOutputPolicy === "accept-and-evaluate") {
    return { hypothesis: "", terminalEmptyAccepted: true }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(`Answer generation failed after ${maxAttempts} attempts: ${message}`)
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
    ? questions.filter((question) => questionIds.includes(question.questionId))
    : questions
  const pendingQuestions = targetQuestions.filter((question) => {
    const phases = checkpoint.questions[question.questionId]?.phases
    return shouldRunAnswerPhase(phases)
  })

  if (pendingQuestions.length === 0) {
    logger.info("No questions pending answering")
    return
  }

  const resolvedRuntimeIdentity = resolveAnsweringRuntimeIdentity(checkpoint.answeringModel)
  if (
    !checkpoint.answeringRuntimeIdentity ||
    stableSha256(checkpoint.answeringRuntimeIdentity) !== stableSha256(resolvedRuntimeIdentity)
  ) {
    throw new Error("Answering runtime identity differs from the checkpoint")
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
      const questionCheckpoint = checkpoint.questions[question.questionId]
      const search = questionCheckpoint.phases.search
      if (!search.retrievalPlan)
        throw new Error(`Missing retrieval plan for ${question.questionId}`)
      const results = search.results || []
      const sessions = benchmark.getHaystackSessions(question.questionId)
      const answerPlan = benchmark.protocol.createAnswerPlan({
        question,
        sessions,
        results,
        retrieval: search.retrievalPlan,
        questionDate: questionCheckpoint.questionDate,
        providerPrompts: provider?.prompts,
      })
      if (answerPlan.answerEvidenceCount > search.retrievalPlan.answerCutoff) {
        throw new Error(
          `Protocol exposed ${answerPlan.answerEvidenceCount} evidence items above answer cutoff ${search.retrievalPlan.answerCutoff}`
        )
      }

      const basePromptTokens = countTokens(requestText(answerPlan.baseRequest), modelConfig)
      const promptTokens = countTokens(requestText(answerPlan.request), modelConfig)
      const contextTokens = Math.max(0, promptTokens - basePromptTokens)
      const startedAt = new Date().toISOString()
      const startedMs = Date.now()
      const priorAttempts = (questionCheckpoint.phases.answer.attempts ?? []).map((attempt) =>
        attempt.status === "in_progress"
          ? {
              ...attempt,
              status: "failed" as const,
              completedAt: new Date().toISOString(),
              usage: attempt.usage ?? {
                requestCount: 1,
                tokenUsageUnknownRequestCount: 1,
              },
              error: "Interrupted before the answering attempt completed",
            }
          : attempt
      )
      checkpointManager.updatePhase(checkpoint, question.questionId, "answer", {
        status: "in_progress",
        startedAt,
        evidenceCount: answerPlan.answerEvidenceCount,
        attempts: priorAttempts,
        terminalEmptyAccepted: undefined,
        costUsd: null,
        error: undefined,
      })
      checkpointManager.updatePhase(checkpoint, question.questionId, "search", {
        answerEvidenceCount: answerPlan.answerEvidenceCount,
      })

      try {
        const request = answerPlan.request
        if (
          request.innerMaxRetries !== undefined &&
          (!Number.isInteger(request.innerMaxRetries) || request.innerMaxRetries < 0)
        ) {
          throw new Error(
            `Answer innerMaxRetries must be a non-negative integer; received ${request.innerMaxRetries}`
          )
        }
        const params: Parameters<typeof generateText>[0] = {
          model: getLanguageModel(client, modelConfig, request.transport),
          prompt: request.prompt,
          maxOutputTokens: request.maxOutputTokens ?? modelConfig.defaultMaxTokens,
          ...(request.system ? { system: request.system } : {}),
          ...(modelConfig.supportsTemperature
            ? { temperature: request.temperature ?? modelConfig.defaultTemperature }
            : {}),
          ...(request.innerMaxRetries !== undefined ? { maxRetries: request.innerMaxRetries } : {}),
        }
        const outcome = await generateAnswerWithRetries({
          maxAttempts: request.maxAttempts,
          timeoutMs: request.timeoutMs,
          retryBackoffMs: request.retryBackoffMs,
          terminalEmptyOutputPolicy: request.terminalEmptyOutputPolicy,
          attemptOffset: priorAttempts.length,
          execute: async (_attempt, abortSignal) => {
            const result = await generateText({
              ...params,
              ...(abortSignal ? { abortSignal } : {}),
            })
            return {
              text: result.text,
              usage: result.usage,
              finishReason: result.finishReason,
            }
          },
          onAttempt: (attempt) => {
            const attempts = questionCheckpoint.phases.answer.attempts ?? []
            const existingAttempt = attempts.findIndex(
              (candidate) => candidate.attempt === attempt.attempt
            )
            const updatedAttempts = [...attempts]
            if (existingAttempt >= 0) updatedAttempts[existingAttempt] = attempt
            else updatedAttempts.push(attempt)
            checkpointManager.updatePhase(checkpoint, question.questionId, "answer", {
              attempts: updatedAttempts,
            })
          },
        })
        const completedAt = new Date().toISOString()
        const durationMs = Date.now() - startedMs
        checkpointManager.updatePhase(checkpoint, question.questionId, "answer", {
          status: "completed",
          hypothesis: outcome.hypothesis,
          terminalEmptyAccepted: outcome.terminalEmptyAccepted,
          promptTokens,
          basePromptTokens,
          contextTokens,
          evidenceCount: answerPlan.answerEvidenceCount,
          usage: aggregateAnswerAttemptUsage(questionCheckpoint.phases.answer.attempts ?? []),
          completedAt,
          durationMs,
          error: undefined,
        })
        logger.progress(
          index + 1,
          total,
          `Answered ${question.questionId}${outcome.terminalEmptyAccepted ? " (terminal empty accepted)" : ""} (${durationMs}ms, ${promptTokens} tokens: ${basePromptTokens} base + ${contextTokens} context)`
        )
        return { questionId: question.questionId, durationMs }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        checkpointManager.updatePhase(checkpoint, question.questionId, "answer", {
          status: "failed",
          usage: aggregateAnswerAttemptUsage(questionCheckpoint.phases.answer.attempts ?? []),
          error: message,
        })
        throw new Error(
          `Answer failed at ${question.questionId}: ${message}. Fix the issue and resume with the same run ID.`
        )
      }
    }
  )

  logger.success("Answer phase complete")
}
