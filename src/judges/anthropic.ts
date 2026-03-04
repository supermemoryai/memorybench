import { createAnthropic } from "@ai-sdk/anthropic"
import { generateText } from "ai"
import type { Judge, JudgeConfig, JudgeInput, JudgeResult } from "../types/judge"
import type { ProviderPrompts } from "../types/prompts"
import { buildJudgePrompt, parseJudgeResponse, getJudgePrompt } from "./base"
import { logger } from "../utils/logger"
import { getModelConfig, ModelConfig, DEFAULT_JUDGE_MODELS } from "../utils/models"

export class AnthropicJudge implements Judge {
  name = "anthropic"
  private modelConfig: ModelConfig | null = null
  private client: ReturnType<typeof createAnthropic> | null = null

  async initialize(config: JudgeConfig): Promise<void> {
    this.client = createAnthropic({
      apiKey: config.apiKey,
    })
    const modelAlias = config.model || DEFAULT_JUDGE_MODELS.anthropic
    this.modelConfig = getModelConfig(modelAlias)
    logger.info(
      `Initialized Anthropic judge with model: ${this.modelConfig.displayName} (${this.modelConfig.id})`
    )
  }

  async evaluate(input: JudgeInput): Promise<JudgeResult> {
    if (!this.client || !this.modelConfig) throw new Error("Judge not initialized")

    const prompt = buildJudgePrompt(input)

    const params: Record<string, unknown> = {
      model: this.client(this.modelConfig.id),
      prompt,
      maxTokens: this.modelConfig.defaultMaxTokens,
    }

    if (this.modelConfig.supportsTemperature) {
      params.temperature = this.modelConfig.defaultTemperature
    }

    const { text } = await generateText(params as Parameters<typeof generateText>[0])

    return parseJudgeResponse(text)
  }

  getPromptForQuestionType(questionType: string, providerPrompts?: ProviderPrompts): string {
    return getJudgePrompt(questionType, providerPrompts)
  }

  getModel() {
    if (!this.client || !this.modelConfig) throw new Error("Judge not initialized")
    return this.client(this.modelConfig.id)
  }
}

export default AnthropicJudge
