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
import { buildDefaultAnswerPrompt, buildStage1Prompt, buildStage2Prompt, detectListQuestion } from "../../prompts/defaults"
import { buildContextString } from "../../types/prompts"
import { ConcurrentExecutor } from "../concurrent"
import { resolveConcurrency } from "../../types/concurrency"

/** Load session date maps from LoCoMo benchmark data */
function loadSessionDateMaps(): Map<string, Record<string, string>> {
  const mapByConv = new Map<string, Record<string, string>>()
  try {
    const benchPath = "data/benchmarks/locomo/locomo10.json"
    if (!existsSync(benchPath)) return mapByConv
    const data = JSON.parse(readFileSync(benchPath, "utf8"))
    if (!Array.isArray(data)) return mapByConv
    for (let i = 0; i < data.length; i++) {
      const conv = data[i]
      const convId = conv.sample_id || `conv-${i}`
      const dateMap: Record<string, string> = {}
      if (conv.conversation) {
        for (const [key, value] of Object.entries(conv.conversation)) {
          if (key.includes("date_time") && typeof value === "string") {
            dateMap[key] = value
          }
        }
      }
      mapByConv.set(convId, dateMap)
    }
  } catch (e) {
    logger.warn(`Could not load session date maps: ${e}`)
  }
  return mapByConv
}

/** Extract conversation ID from questionId (e.g., "conv-26-q3" → "conv-26") */
function getConvId(questionId: string): string {
  const match = questionId.match(/(conv-\d+)/)
  return match ? match[1] : ""
}

/** Try to parse JSON from LLM response, handling markdown fences */
function stripThinkTokens(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim()
}

function tryParseJSON(text: string): any {
  // Strip <think> blocks (e.g. qwen3.5-27b-claude46) and markdown code fences
  let cleaned = stripThinkTokens(text)
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "")
  }
  try {
    return JSON.parse(cleaned)
  } catch {
    return null
  }
}

type LanguageModel =
  | ReturnType<typeof createOpenAI>
  | ReturnType<typeof createAnthropic>
  | ReturnType<typeof createGoogleGenerativeAI>

function getAnsweringModel(modelAlias: string): {
  client: LanguageModel
  modelConfig: ModelConfig
} {
  const modelConfig = getModelConfig(modelAlias || DEFAULT_ANSWERING_MODEL)

  // Prefer direct provider keys; fall back to OpenRouter for providers without keys
  const openrouterKey = process.env.OPENROUTER_API_KEY

  switch (modelConfig.provider) {
    case "openai": {
      // Prefer direct OpenAI key; fall back to OpenRouter
      if (config.openaiApiKey && config.openaiApiKey.length >= 10) {
        const provider = createOpenAI({ apiKey: config.openaiApiKey })
        return { client: provider(modelConfig.id) as unknown as LanguageModel, modelConfig }
      }
      if (openrouterKey) {
        const orModelId = toOpenRouterModelId(modelConfig.id, modelConfig.provider)
        return {
          client: createOpenAI({
            apiKey: openrouterKey,
            baseURL: 'https://openrouter.ai/api/v1',
            headers: { 'HTTP-Referer': 'https://cartisien.com', 'X-Title': 'Engram MemoryBench' },
          })(orModelId) as unknown as LanguageModel,
          modelConfig,
        }
      }
      throw new Error("No OpenAI or OpenRouter API key available")
    }
    case "anthropic": {
      // Prefer direct Anthropic key — OpenRouter adds cost and a shared rate limit
      if (config.anthropicApiKey && config.anthropicApiKey.length >= 10) {
        // OAuth tokens (sk-ant-oat...) require Authorization: Bearer — x-api-key is rejected
        const isOAuth = config.anthropicApiKey.startsWith('sk-ant-oat')
        const provider = isOAuth
          ? createAnthropic({
              apiKey: 'dummy',
              fetch: async (url, init) => {
                const headers = new Headers(init?.headers as HeadersInit)
                headers.delete('x-api-key')
                headers.set('Authorization', `Bearer ${config.anthropicApiKey}`)
                return fetch(url, { ...init, headers })
              },
            })
          : createAnthropic({ apiKey: config.anthropicApiKey })
        return { client: provider(modelConfig.id) as unknown as LanguageModel, modelConfig }
      }
      if (openrouterKey) {
        const orModelId = toOpenRouterModelId(modelConfig.id, modelConfig.provider)
        return {
          client: createOpenAI({
            apiKey: openrouterKey,
            baseURL: 'https://openrouter.ai/api/v1',
            headers: { 'HTTP-Referer': 'https://cartisien.com', 'X-Title': 'Engram MemoryBench' },
          })(orModelId) as unknown as LanguageModel,
          modelConfig,
        }
      }
      throw new Error("No Anthropic or OpenRouter API key available")
    }
    case "google": {
      if (openrouterKey) {
        const orModelId = toOpenRouterModelId(modelConfig.id, modelConfig.provider)
        return {
          client: createOpenAI({
            apiKey: openrouterKey,
            baseURL: 'https://openrouter.ai/api/v1',
            headers: { 'HTTP-Referer': 'https://cartisien.com', 'X-Title': 'Engram MemoryBench' },
          })(orModelId) as unknown as LanguageModel,
          modelConfig,
        }
      }
      if (config.googleApiKey && config.googleApiKey.length >= 10) {
        const provider = createGoogleGenerativeAI({ apiKey: config.googleApiKey })
        return { client: provider(modelConfig.id) as unknown as LanguageModel, modelConfig }
      }
      throw new Error("No Google or OpenRouter API key available")
    }
    case "ollama": {
      // Check if this is a vLLM model (has -vllm suffix or vllm in name)
      const isVllm = modelAlias.includes('vllm') || modelConfig.id.includes('awq')
      const ollamaBaseUrl = process.env.OLLAMA_URL || "http://192.168.68.73:11434"
      const baseUrl = isVllm
        ? (process.env.VLLM_URL || "http://192.168.68.73:8000/v1")
        : `${ollamaBaseUrl}/v1`
      // For Gemma-4: the Ollama OpenAI-compat /v1 endpoint ignores think:false (options.think
      // is only honored by the native /api/chat endpoint). Gemma-4 routes all output through
      // `reasoning` (not `content`) even with think:false in options.
      // Fix: intercept /v1/chat/completions calls, translate to native /api/chat with think:false,
      // then translate the response back to OpenAI format so the AI SDK works normally.
      const isGemma = modelConfig.id.toLowerCase().includes("gemma")
      const customFetch = isGemma
        ? async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            if (init?.body && typeof init.body === "string") {
              try {
                const oaiBody = JSON.parse(init.body)
                // Translate OpenAI chat format → native Ollama /api/chat format
                const nativeBody: any = {
                  model: oaiBody.model,
                  messages: oaiBody.messages,
                  stream: false,
                  think: false,
                  options: { num_predict: oaiBody.max_tokens || 1000 },
                }
                const nativeUrl = `${ollamaBaseUrl}/api/chat`
                const nativeResp = await fetch(nativeUrl, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(nativeBody),
                })
                if (!nativeResp.ok) return nativeResp
                const nativeJson = await nativeResp.json() as any
                // Translate back to OpenAI format
                const oaiResp = {
                  id: "ollama-" + Date.now(),
                  object: "chat.completion",
                  choices: [{
                    index: 0,
                    message: {
                      role: "assistant",
                      content: nativeJson.message?.content || "",
                    },
                    finish_reason: nativeJson.done ? "stop" : "length",
                  }],
                  usage: {
                    prompt_tokens: nativeJson.prompt_eval_count || 0,
                    completion_tokens: nativeJson.eval_count || 0,
                    total_tokens: (nativeJson.prompt_eval_count || 0) + (nativeJson.eval_count || 0),
                  },
                }
                return new Response(JSON.stringify(oaiResp), {
                  status: 200,
                  headers: { "content-type": "application/json" },
                })
              } catch { /* fall through to normal fetch on error */ }
            }
            return fetch(url, init)
          }
        : undefined
      return {
        client: createOpenAI({
          apiKey: isVllm ? process.env.VLLM_API_KEY || "dummy" : "ollama",
          baseURL: baseUrl,
          compatibility: "compatible",
          ...(customFetch ? { fetch: customFetch } : {}),
        }).chat(modelConfig.id) as unknown as LanguageModel,
        modelConfig,
      }
    }
    case "openrouter": {
      // Always use OpenRouter for openrouter provider (model ID already qualified)
      if (!openrouterKey) throw new Error("OPENROUTER_API_KEY not set")
      return {
        client: createOpenAI({
          apiKey: openrouterKey,
          baseURL: 'https://openrouter.ai/api/v1',
          headers: {
            'HTTP-Referer': 'https://cartisien.com',
            'X-Title': 'Engram MemoryBench',
          },
        })(modelConfig.id) as unknown as LanguageModel,
        modelConfig,
      }
    }
    default: {
      // Fall back to OpenRouter for unknown providers
      if (openrouterKey) {
        const orModelId = toOpenRouterModelId(modelConfig.id, modelConfig.provider)
        return {
          client: createOpenAI({
            apiKey: openrouterKey,
            baseURL: 'https://openrouter.ai/api/v1',
            headers: {
              'HTTP-Referer': 'https://cartisien.com',
              'X-Title': 'Engram MemoryBench',
            },
          })(orModelId) as unknown as LanguageModel,
          modelConfig,
        }
      }
      throw new Error(`No API key for provider: ${modelConfig.provider}`)
    }
  }
}

function toOpenRouterModelId(id: string, provider: string): string {
  // Already qualified (e.g. anthropic/claude-haiku-4-5)
  if (id.includes('/')) return id
  // OpenRouter uses simplified model IDs (no date suffix)
  // e.g. claude-sonnet-4-5-20250929 → claude-sonnet-4-5
  // e.g. claude-haiku-4-5-20251001 → claude-haiku-4-5
  // Strip trailing date suffix (-YYYYMMDD)
  const stripped = id.replace(/-\d{8}$/, '')
  switch (provider) {
    case 'anthropic': return `anthropic/${stripped}`
    case 'google': return `google/${stripped}`
    case 'openai': return `openai/${stripped}`
    default: return stripped
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

  // Load session date maps for temporal normalization
  const sessionDateMaps = loadSessionDateMaps()

  // Check if two-stage pipeline is enabled (default: true for v27+)
  const useTwoStage = process.env.MEMORYBENCH_SINGLE_STAGE !== "1"

  logger.info(
    `Generating answers for ${pendingQuestions.length} questions using ${modelConfig.displayName} (concurrency: ${concurrency}, pipeline: ${useTwoStage ? "two-stage" : "single"})...`
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

        // Resolve session date map for this question's conversation
        const convId = getConvId(question.questionId)
        const sessionDateMap = sessionDateMaps.get(convId)

        let finalAnswer: string

        if (useTwoStage && !provider?.prompts?.answerPrompt) {
          // === STAGE 1: CoT Draft ===
          const stage1Prompt = buildStage1Prompt(question.question, context, questionDate, sessionDateMap, question.questionType)

          const stage1Params: Record<string, unknown> = {
            model: client,
            prompt: stage1Prompt,
            maxTokens: modelConfig.defaultMaxTokens,
          }
          if (modelConfig.supportsTemperature) {
            stage1Params.temperature = modelConfig.defaultTemperature
          }

          const { text: stage1Text } = await generateText(stage1Params as Parameters<typeof generateText>[0])

          // Try to parse Stage 1 JSON
          const stage1Parsed = tryParseJSON(stage1Text)

          const isListQ = (process.env.ENGRAM_LIST_EXHAUST !== '0') && detectListQuestion(question.question)
          const confidenceThreshold = isListQ ? 95 : 85
          if (stage1Parsed && stage1Parsed.confidence >= confidenceThreshold) {
            // High confidence — use draft directly
            finalAnswer = stage1Parsed.draft_answer || stripThinkTokens(stage1Text)
          } else {
            // === STAGE 2: Verify ===
            const stage2Prompt = buildStage2Prompt(question.question, context, stage1Text, questionDate)

            const stage2Params: Record<string, unknown> = {
              model: client,
              prompt: stage2Prompt,
              maxTokens: modelConfig.defaultMaxTokens,
            }
            if (modelConfig.supportsTemperature) {
              stage2Params.temperature = modelConfig.defaultTemperature
            }

            const { text: stage2Text } = await generateText(stage2Params as Parameters<typeof generateText>[0])

            const stage2Parsed = tryParseJSON(stage2Text)
            finalAnswer = stage2Parsed?.final_answer || stage1Parsed?.draft_answer || stripThinkTokens(stage1Text)
          }
        } else {
          // Legacy single-stage path (provider custom prompt or env override)
          const prompt = buildAnswerPrompt(question.question, context, questionDate, provider)

          const params: Record<string, unknown> = {
            model: client,
            prompt,
            maxTokens: modelConfig.defaultMaxTokens,
          }
          if (modelConfig.supportsTemperature) {
            params.temperature = modelConfig.defaultTemperature
          }

          const { text } = await generateText(params as Parameters<typeof generateText>[0])
          finalAnswer = stripThinkTokens(text)
        }

        const durationMs = Date.now() - startTime
        checkpointManager.updatePhase(checkpoint, question.questionId, "answer", {
          status: "completed",
          hypothesis: finalAnswer,
          completedAt: new Date().toISOString(),
          durationMs,
        })

        logger.progress(index + 1, total, `Answered ${question.questionId} (${durationMs}ms)`)
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
