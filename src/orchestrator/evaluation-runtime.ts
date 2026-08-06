import { generateObject } from "ai"
import type { Judge } from "../types/judge"
import type { EvaluationRuntime, ModelUsage, StructuredModelRequest } from "../types/protocol"

export const STRUCTURED_RUNTIME_EXECUTION_VERSION = "chat-transport-outer-retry-v1"

export async function executeStructuredWithRetries<T>(
  request: StructuredModelRequest<T>,
  execute: () => Promise<unknown>
): Promise<T> {
  const maxAttempts = request.maxAttempts ?? 3
  const retryBackoffMs = request.retryBackoffMs ?? 0
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`Structured maxAttempts must be a positive integer; received ${maxAttempts}`)
  }
  if (!Number.isInteger(retryBackoffMs) || retryBackoffMs < 0) {
    throw new Error(
      `Structured retryBackoffMs must be a non-negative integer; received ${retryBackoffMs}`
    )
  }
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return request.schema.parse(await execute())
    } catch (error) {
      lastError = error
      if (attempt < maxAttempts && retryBackoffMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryBackoffMs * attempt))
      }
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(
    `Structured judge request ${request.schemaName} failed after ${maxAttempts} attempts: ${message}`
  )
}

export interface StructuredGenerationResult {
  object: unknown
  usage?: unknown
}

export type StructuredGenerationExecutor = (
  judge: Judge,
  request: StructuredModelRequest<unknown>
) => Promise<StructuredGenerationResult>

interface NormalizedTokenUsage {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  totalTokens?: number
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function normalizeTokenUsage(value: unknown): NormalizedTokenUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const usage = value as Record<string, unknown>
  const inputTokens = finiteNumber(usage.inputTokens ?? usage.promptTokens)
  const outputTokens = finiteNumber(usage.outputTokens ?? usage.completionTokens)
  const reasoningTokens = finiteNumber(usage.reasoningTokens)
  const totalTokens = finiteNumber(usage.totalTokens)
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    reasoningTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined
  }
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  }
}

/** Extract token usage exposed by AI SDK generation errors without assuming it exists. */
export function extractTokenUsageFromError(error: unknown): NormalizedTokenUsage | undefined {
  const seen = new Set<object>()
  const visit = (value: unknown): NormalizedTokenUsage | undefined => {
    if (!value || typeof value !== "object" || Array.isArray(value) || seen.has(value)) {
      return undefined
    }
    seen.add(value)
    const record = value as Record<string, unknown>
    const direct = normalizeTokenUsage(record.usage)
    if (direct) return direct
    const response = record.response
    if (response && typeof response === "object" && !Array.isArray(response)) {
      const responseUsage = normalizeTokenUsage((response as Record<string, unknown>).usage)
      if (responseUsage) return responseUsage
    }
    return visit(record.cause)
  }
  return visit(error)
}

export async function generateStructuredObject(
  judge: Judge,
  request: StructuredModelRequest<unknown>
): Promise<StructuredGenerationResult> {
  const innerMaxRetries = request.innerMaxRetries ?? 0
  if (!Number.isInteger(innerMaxRetries) || innerMaxRetries < 0) {
    throw new Error(
      `Structured innerMaxRetries must be a non-negative integer; received ${innerMaxRetries}`
    )
  }
  const result = await generateObject({
    model: judge.getModel(request.transport),
    schema: request.schema,
    schemaName: request.schemaName,
    prompt: request.prompt,
    ...(request.system ? { system: request.system } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    maxOutputTokens: request.maxOutputTokens ?? 512,
    maxRetries: innerMaxRetries,
    abortSignal: AbortSignal.timeout(request.timeoutMs ?? 120_000),
  })
  return { object: result.object, usage: result.usage }
}

export class JudgeEvaluationRuntime implements EvaluationRuntime {
  private usage: ModelUsage = { requestCount: 0 }

  constructor(
    private readonly judge: Judge,
    private readonly structuredGeneration: StructuredGenerationExecutor = generateStructuredObject
  ) {}

  async evaluateLegacy(input: Parameters<Judge["evaluate"]>[0]) {
    this.beginRequest()
    try {
      const result = await this.judge.evaluate(input)
      // The legacy JudgeResult contract does not expose token usage.
      this.recordTokenUsage(undefined)
      return result
    } catch (error) {
      this.recordTokenUsage(extractTokenUsageFromError(error))
      throw error
    }
  }

  async generateStructured<T>(request: StructuredModelRequest<T>): Promise<T> {
    return executeStructuredWithRetries(request, async () => {
      this.beginRequest()
      try {
        const result = await this.structuredGeneration(
          this.judge,
          request as StructuredModelRequest<unknown>
        )
        this.recordTokenUsage(normalizeTokenUsage(result.usage))
        return result.object
      } catch (error) {
        this.recordTokenUsage(extractTokenUsageFromError(error))
        throw error
      }
    })
  }

  getUsage(): ModelUsage | undefined {
    return this.usage.requestCount ? { ...this.usage } : undefined
  }

  private beginRequest(): void {
    this.usage.requestCount = (this.usage.requestCount ?? 0) + 1
  }

  private recordTokenUsage(usage: NormalizedTokenUsage | undefined): void {
    if (!usage) {
      this.usage.tokenUsageUnknownRequestCount = (this.usage.tokenUsageUnknownRequestCount ?? 0) + 1
      return
    }

    const fields = [usage.inputTokens, usage.outputTokens, usage.totalTokens]
    const complete = fields.every((value) => value !== undefined)
    const coverageField = complete
      ? "tokenUsageCompleteRequestCount"
      : "tokenUsagePartialRequestCount"
    this.usage[coverageField] = (this.usage[coverageField] ?? 0) + 1
    if (usage.inputTokens !== undefined) {
      this.usage.inputTokens = (this.usage.inputTokens ?? 0) + usage.inputTokens
    }
    if (usage.outputTokens !== undefined) {
      this.usage.outputTokens = (this.usage.outputTokens ?? 0) + usage.outputTokens
    }
    if (usage.reasoningTokens !== undefined) {
      this.usage.reasoningTokens = (this.usage.reasoningTokens ?? 0) + usage.reasoningTokens
    }
    if (usage.totalTokens !== undefined) {
      this.usage.totalTokens = (this.usage.totalTokens ?? 0) + usage.totalTokens
    }
  }
}
