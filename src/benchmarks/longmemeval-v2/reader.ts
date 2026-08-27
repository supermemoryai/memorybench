import { readFile } from "node:fs/promises"
import { getEncoding } from "js-tiktoken"
import type {
  AssetRef,
  QueryArtifact,
  ReaderArtifact,
  ReaderMessagePart,
} from "../../types/migration"
import { ArtifactStore } from "../../core/artifact-store"
import { readerFingerprint } from "../../core/fingerprints"
import { openAICompletionControls } from "./openai-model"

export const READER_PROMPT_VERSION = "longmemeval-v2-reader-v1"
export const CONTEXT_BUDGET_VERSION = "gpt5-o200k-conservative-images-v1"

export const DOMAIN_SYSTEM_PROMPTS = {
  web:
    "You are an experienced colleague in a web browsing environment that has " +
    "a customized magento-based shopping website, a customized magento-based " +
    "shopping admin cms website, as well as a customized forum website based " +
    "on reddit/postmill. Answer based on your memory of the environment. " +
    "If you do not know the answer, output exactly \\boxed{UNKNOWN}. " +
    "Do not guess. Never attempt to guess an answer if you are not sure. " +
    "If you believe the question's construction/premise is wrong, provide an " +
    "explanation in \\boxed{} explaining why the question is flawed.",
  enterprise:
    "You are an experienced colleague working in a customized ServiceNow " +
    "environment. Answer based on your memory of the environment. " +
    "If you do not know the answer, output exactly \\boxed{UNKNOWN}. " +
    "Do not guess. Never attempt to guess an answer if you are not sure. " +
    "If you believe the question's construction/premise is wrong, provide an " +
    "explanation in \\boxed{} explaining why the question is flawed.",
} as const

export interface ReaderSettings {
  model: string
  reasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
  maxCompletionTokens: number
  maxContextTokens: number
  evidenceTopK: number
  maxImages: number
  maxImageBytes: number
  malformedResponseAttempts: number
}

export interface ReaderModelRequest {
  model: string
  reasoningEffort: ReaderSettings["reasoningEffort"]
  maxCompletionTokens: number
  systemPrompt: string
  parts: ReaderMessagePart[]
}

export interface ReaderModelResponse {
  text: string
  usage?: Record<string, number>
  raw: unknown
}

export interface ReaderModelClient {
  generate(request: ReaderModelRequest, signal?: AbortSignal): Promise<ReaderModelResponse>
}

export interface ContextTokenCounter {
  readonly version: string
  count(systemPrompt: string, parts: ReaderMessagePart[]): number
}

export class Gpt5ContextTokenCounter implements ContextTokenCounter {
  readonly version = CONTEXT_BUDGET_VERSION
  private readonly encoding = getEncoding("o200k_base")

  constructor(private readonly tokensPerImage = 1700) {}

  count(systemPrompt: string, parts: ReaderMessagePart[]): number {
    let count = this.encoding.encode(systemPrompt).length + 12
    for (const part of parts) {
      count +=
        part.type === "text" ? this.encoding.encode(part.text).length + 4 : this.tokensPerImage
    }
    return count
  }
}

export class OpenAIReaderClient implements ReaderModelClient {
  constructor(
    private readonly options: {
      apiKey: string
      baseUrl?: string
      timeoutMs?: number
    }
  ) {
    if (!options.apiKey) throw new Error("OPENAI_API_KEY is required")
  }

  async generate(request: ReaderModelRequest, signal?: AbortSignal): Promise<ReaderModelResponse> {
    const content = []
    for (const part of request.parts) {
      if (part.type === "text") {
        content.push({ type: "text", text: part.text })
      } else {
        if (!part.asset.absolutePath) throw new Error(`Unresolved image ${part.asset.assetId}`)
        const bytes = await readFile(part.asset.absolutePath)
        content.push({
          type: "image_url",
          image_url: {
            url: `data:${part.asset.mimeType};base64,${bytes.toString("base64")}`,
          },
        })
      }
    }
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener("abort", onAbort, { once: true })
    const timeout = setTimeout(
      () => controller.abort(new Error("Reader request timed out")),
      this.options.timeoutMs ?? 10 * 60 * 1000
    )
    try {
      const response = await fetch(
        `${(this.options.baseUrl ?? "https://api.openai.com").replace(/\/$/, "")}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.options.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: request.model,
            messages: [
              { role: "system", content: request.systemPrompt },
              { role: "user", content },
            ],
            ...openAICompletionControls(
              request.model,
              request.maxCompletionTokens,
              request.reasoningEffort
            ),
          }),
          signal: controller.signal,
        }
      )
      const raw = (await response.json().catch(() => null)) as Record<string, unknown> | null
      if (!response.ok) {
        throw new Error(`OpenAI reader HTTP ${response.status}`)
      }
      const choices = raw?.choices as Array<Record<string, unknown>> | undefined
      const message = choices?.[0]?.message as Record<string, unknown> | undefined
      const messageContent = message?.content
      let text = ""
      if (typeof messageContent === "string") text = messageContent.trim()
      else if (Array.isArray(messageContent)) {
        text = messageContent
          .map((item) =>
            item && typeof item === "object" && typeof item.text === "string" ? item.text : ""
          )
          .filter(Boolean)
          .join("\n")
          .trim()
      }
      if (!text && typeof message?.reasoning === "string") text = message.reasoning.trim()
      const usage = raw?.usage as Record<string, number> | undefined
      return { text, usage, raw }
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener("abort", onAbort)
    }
  }
}

interface EvidenceUnit {
  parts: ReaderMessagePart[]
}

function extractBoxedAnswer(text: string): string {
  const marker = "\\boxed{"
  const start = text.lastIndexOf(marker)
  if (start < 0) return text.trim()
  let depth = 1
  const output: string[] = []
  for (let index = start + marker.length; index < text.length && depth > 0; index += 1) {
    const character = text[index]
    if (character === "{") {
      depth += 1
      output.push(character)
    } else if (character === "}") {
      depth -= 1
      if (depth > 0) output.push(character)
    } else {
      output.push(character)
    }
  }
  const parsed = output.join("").trim()
  return parsed || text.trim()
}

export class LongMemEvalV2Reader {
  constructor(
    private readonly client: ReaderModelClient,
    private readonly artifacts: ArtifactStore,
    private readonly tokenCounter: ContextTokenCounter = new Gpt5ContextTokenCounter()
  ) {}

  async answer(input: {
    queryArtifact: QueryArtifact
    domain: "web" | "enterprise"
    question: string
    questionImage?: AssetRef
    settings: ReaderSettings
    signal?: AbortSignal
  }): Promise<ReaderArtifact> {
    const systemPrompt = DOMAIN_SYSTEM_PROMPTS[input.domain]
    const units: EvidenceUnit[] = []
    const seenImages = new Set<string>()
    let imageCount = 0
    for (const result of input.queryArtifact.normalizedResults.slice(
      0,
      input.settings.evidenceTopK
    )) {
      const parts: ReaderMessagePart[] = [
        {
          type: "text",
          text: result.text,
          provenance: {
            rank: result.rank,
            score: result.score,
            trajectoryId: result.trajectoryId,
            stateIndex: result.stateIndex,
            documentIds: result.documentIds,
          },
        },
      ]
      for (const screenshot of result.screenshotRefs) {
        if (
          seenImages.has(screenshot.sha256) ||
          imageCount >= input.settings.maxImages ||
          screenshot.byteLength > input.settings.maxImageBytes
        ) {
          continue
        }
        const materialized = await this.artifacts.materializeAsset(screenshot)
        seenImages.add(screenshot.sha256)
        imageCount += 1
        parts.push({
          type: "image",
          asset: materialized,
          caption: `Screenshot for retrieval rank ${result.rank}`,
          provenance: { rank: result.rank, trajectoryId: result.trajectoryId },
        })
      }
      units.push({ parts })
    }

    const intro: ReaderMessagePart = {
      type: "text",
      text: `### Memory context:\n${units.length === 0 ? "(empty)" : ""}`,
    }
    const questionPart: ReaderMessagePart = {
      type: "text",
      text: `\n\n### Question to answer:\n${input.question}`,
    }
    let materializedQuestionImage: AssetRef | undefined
    if (input.questionImage) {
      if (input.questionImage.byteLength > input.settings.maxImageBytes) {
        throw new Error(`Question image exceeds maxImageBytes`)
      }
      materializedQuestionImage = await this.artifacts.materializeAsset(input.questionImage)
    }
    const suffix: ReaderMessagePart[] = [
      questionPart,
      ...(materializedQuestionImage
        ? [{ type: "image" as const, asset: materializedQuestionImage }]
        : []),
    ]
    const fits = (count: number): boolean => {
      const parts = [intro, ...units.slice(0, count).flatMap((unit) => unit.parts), ...suffix]
      return this.tokenCounter.count(systemPrompt, parts) <= input.settings.maxContextTokens
    }
    if (!fits(0)) {
      throw new Error("System prompt, question, and question image exceed the context budget")
    }
    let low = 0
    let high = units.length
    while (low < high) {
      const middle = Math.floor((low + high + 1) / 2)
      if (fits(middle)) low = middle
      else high = middle - 1
    }
    const parts = [intro, ...units.slice(0, low).flatMap((unit) => unit.parts), ...suffix]
    const imageHashes = parts
      .filter(
        (part): part is Extract<ReaderMessagePart, { type: "image" }> => part.type === "image"
      )
      .map((part) => part.asset.sha256)
    const fingerprint = readerFingerprint({
      queryArtifact: input.queryArtifact,
      model: input.settings.model,
      settings: { ...input.settings },
      promptVersion: READER_PROMPT_VERSION,
      imageHashes,
      contextBudgetVersion: this.tokenCounter.version,
    })
    const cached = await this.loadCached(input.queryArtifact.questionId, fingerprint)
    if (cached) return { ...cached, cacheHit: true }

    const rawAttempts: unknown[] = []
    const started = performance.now()
    let response: ReaderModelResponse | undefined
    for (let attempt = 1; attempt <= input.settings.malformedResponseAttempts; attempt += 1) {
      response = await this.client.generate(
        {
          model: input.settings.model,
          reasoningEffort: input.settings.reasoningEffort,
          maxCompletionTokens: input.settings.maxCompletionTokens,
          systemPrompt,
          parts,
        },
        input.signal
      )
      rawAttempts.push(response.raw)
      if (response.text.trim()) break
      response = undefined
    }
    if (!response) throw new Error("Reader returned malformed empty responses")
    const artifact: ReaderArtifact = {
      schemaVersion: 1,
      questionId: input.queryArtifact.questionId,
      readerFingerprint: fingerprint,
      model: input.settings.model,
      reasoningEffort: input.settings.reasoningEffort,
      systemPrompt,
      parts,
      sentAssetIds: parts
        .filter(
          (part): part is Extract<ReaderMessagePart, { type: "image" }> => part.type === "image"
        )
        .map((part) => part.asset.assetId),
      omittedItems: units.length - low,
      responseText: response.text.trim(),
      parsedAnswer: extractBoxedAnswer(response.text),
      rawAttempts,
      usage: response.usage,
      durationMs: performance.now() - started,
      cacheHit: false,
      createdAt: new Date().toISOString(),
    }
    const portableArtifact: ReaderArtifact = {
      ...artifact,
      parts: artifact.parts.map((part) =>
        part.type === "image"
          ? { ...part, asset: { ...part.asset, absolutePath: undefined } }
          : part
      ),
    }
    await this.artifacts.writeJson(
      `readers/${artifact.questionId}/${fingerprint}.json`,
      portableArtifact
    )
    return artifact
  }

  private async loadCached(
    questionId: string,
    fingerprint: string
  ): Promise<ReaderArtifact | null> {
    try {
      const artifact = await this.artifacts.readJson<ReaderArtifact>(
        `readers/${questionId}/${fingerprint}.json`
      )
      for (const part of artifact.parts) {
        if (part.type === "image") {
          const stored = await this.artifacts.describe(part.asset.relativePath)
          if (stored.sha256 !== part.asset.sha256 || stored.byteLength !== part.asset.byteLength) {
            return null
          }
          part.asset.absolutePath = this.artifacts.resolve(part.asset.relativePath)
        }
      }
      return artifact
    } catch {
      return null
    }
  }
}
