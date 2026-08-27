import { createHash } from "node:crypto"

const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504])
const BODY_SNIPPET_LIMIT = 500
const DEFAULT_BASE_URL = "https://api.supermemory.ai"

export type SupermemoryMetadataValue = string | number | boolean | string[]
export type SupermemoryMetadata = Record<string, SupermemoryMetadataValue>

export interface V3DocumentInput {
  content: string
  customId: string
  metadata: SupermemoryMetadata
  filterByMetadata?: SupermemoryMetadata
}

export interface V3DocumentResponse {
  id: string
  customId?: string
  status?: string
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

export interface V3BatchResponse {
  results: Array<Record<string, unknown>>
  [key: string]: unknown
}

export interface V4SearchRequest {
  q: string
  containerTag: string
  limit: number
  threshold: number
  searchMode: "hybrid" | "memories"
  rerank: boolean
  rewriteQuery: boolean
  include: {
    summaries: boolean
    documents: boolean
    relatedMemories: boolean
  }
  filters?: Record<string, unknown>
}

export interface RequestBudgetSnapshot {
  configuredCap: number
  effectiveCap: number
  inFlight: number
  peakInFlight: number
  throttleEvents: number
  successStreak: number
  notBeforeMs: number
}

export type AdvancedSupermemoryEventLogger = (
  event: string,
  details: Record<string, unknown>
) => void

export class SupermemoryHttpError extends Error {
  readonly statusCode?: number
  readonly retryable: boolean
  readonly retryAfterMs?: number

  constructor(
    message: string,
    options: {
      statusCode?: number
      retryable: boolean
      retryAfterMs?: number
      cause?: unknown
    }
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = "SupermemoryHttpError"
    this.statusCode = options.statusCode
    this.retryable = options.retryable
    this.retryAfterMs = options.retryAfterMs
  }
}

export class SupermemoryRetryExhaustedError extends Error {
  readonly attempts: number
  readonly lastError: SupermemoryHttpError

  constructor(operation: string, attempts: number, lastError: SupermemoryHttpError) {
    super(`${operation} failed after ${attempts} attempts: ${lastError.message}`, {
      cause: lastError,
    })
    this.name = "SupermemoryRetryExhaustedError"
    this.attempts = attempts
    this.lastError = lastError
  }
}

export class SupermemoryContractError extends Error {
  readonly statusCode?: number

  constructor(message: string, statusCode?: number) {
    super(message)
    this.name = "SupermemoryContractError"
    this.statusCode = statusCode
  }
}

export interface AdaptiveRequestBudgetOptions {
  maxInFlight: number
  recoverySuccesses?: number
  clock?: () => number
  sleep?: (milliseconds: number) => Promise<void>
  eventLogger?: AdvancedSupermemoryEventLogger
}

/**
 * One async request budget shared by upload, polling, reconciliation, search,
 * cleanup, and every client connected to the same account/base URL.
 */
export class AdaptiveRequestBudget {
  private configuredCap: number
  private effectiveCap: number
  private inFlight = 0
  private peakInFlight = 0
  private throttleEvents = 0
  private successStreak = 0
  private notBeforeMs = 0
  private readonly recoverySuccesses: number
  private readonly clock: () => number
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly eventLogger?: AdvancedSupermemoryEventLogger
  private readonly waiters: Array<() => void> = []

  constructor(options: AdaptiveRequestBudgetOptions) {
    if (!Number.isInteger(options.maxInFlight) || options.maxInFlight < 1) {
      throw new Error("maxInFlight must be an integer >= 1")
    }
    this.configuredCap = options.maxInFlight
    this.effectiveCap = options.maxInFlight
    this.recoverySuccesses = options.recoverySuccesses ?? 20
    this.clock = options.clock ?? Date.now
    this.sleep = options.sleep ?? ((milliseconds) => Bun.sleep(milliseconds))
    this.eventLogger = options.eventLogger
  }

  restrictTo(maxInFlight: number): void {
    if (!Number.isInteger(maxInFlight) || maxInFlight < 1) {
      throw new Error("maxInFlight must be an integer >= 1")
    }
    this.configuredCap = Math.min(this.configuredCap, maxInFlight)
    this.effectiveCap = Math.min(this.effectiveCap, this.configuredCap)
    this.wakeWaiters()
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await operation()
    } finally {
      this.inFlight -= 1
      this.wakeWaiters()
    }
  }

  recordSuccess(): void {
    this.successStreak += 1
    if (this.successStreak >= this.recoverySuccesses && this.effectiveCap < this.configuredCap) {
      this.effectiveCap += 1
      this.successStreak = 0
      this.emit("request_budget_recovered", { effectiveCap: this.effectiveCap })
      this.wakeWaiters()
    }
  }

  recordPressure(reason: string, retryAfterMs?: number): void {
    this.successStreak = 0
    this.effectiveCap = Math.max(1, Math.floor(this.effectiveCap / 2))
    if (retryAfterMs !== undefined && retryAfterMs > 0) {
      this.notBeforeMs = Math.max(this.notBeforeMs, this.clock() + retryAfterMs)
    }
    this.throttleEvents += 1
    this.emit("request_budget_pressure", {
      reason,
      effectiveCap: this.effectiveCap,
      retryAfterMs,
    })
  }

  snapshot(): RequestBudgetSnapshot {
    return {
      configuredCap: this.configuredCap,
      effectiveCap: this.effectiveCap,
      inFlight: this.inFlight,
      peakInFlight: this.peakInFlight,
      throttleEvents: this.throttleEvents,
      successStreak: this.successStreak,
      notBeforeMs: this.notBeforeMs,
    }
  }

  private async acquire(): Promise<void> {
    while (true) {
      const waitForThrottle = this.notBeforeMs - this.clock()
      if (waitForThrottle > 0) {
        await this.sleep(waitForThrottle)
        continue
      }
      if (this.inFlight < this.effectiveCap) {
        this.inFlight += 1
        this.peakInFlight = Math.max(this.peakInFlight, this.inFlight)
        return
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
  }

  private wakeWaiters(): void {
    for (const resolve of this.waiters.splice(0)) resolve()
  }

  private emit(event: string, details: Record<string, unknown>): void {
    try {
      this.eventLogger?.(event, details)
    } catch {
      // Observability must never change request behavior.
    }
  }
}

const sharedBudgets = new Map<string, AdaptiveRequestBudget>()

function accountBudgetKey(baseUrl: string, apiKey: string): string {
  const keyHash = createHash("sha256").update(apiKey).digest("hex").slice(0, 16)
  return `${baseUrl}:${keyHash}`
}

export function getSharedSupermemoryRequestBudget(options: {
  baseUrl: string
  apiKey: string
  maxInFlight: number
  eventLogger?: AdvancedSupermemoryEventLogger
}): AdaptiveRequestBudget {
  const key = accountBudgetKey(options.baseUrl, options.apiKey)
  const existing = sharedBudgets.get(key)
  if (existing) {
    existing.restrictTo(options.maxInFlight)
    return existing
  }
  const created = new AdaptiveRequestBudget({
    maxInFlight: options.maxInFlight,
    eventLogger: options.eventLogger,
  })
  sharedBudgets.set(key, created)
  return created
}

export interface AdvancedSupermemoryClientOptions {
  apiKey: string
  baseUrl?: string
  maxInFlightRequests?: number
  maxAttempts?: number
  requestTimeoutMs?: number
  backoffBaseMs?: number
  backoffMaxMs?: number
  fetch?: typeof fetch
  sleep?: (milliseconds: number) => Promise<void>
  clock?: () => number
  random?: () => number
  budget?: AdaptiveRequestBudget
  eventLogger?: AdvancedSupermemoryEventLogger
  userAgent?: string
}

export interface AdvancedSupermemoryApi {
  readonly baseUrl: string
  readonly requestCount: number
  readonly budgetSnapshot: RequestBudgetSnapshot
  addDocument(input: {
    document: V3DocumentInput
    containerTag: string
    dreaming?: "instant" | string
    maxAttempts?: number
  }): Promise<V3DocumentResponse>
  addDocumentsBatch(input: {
    documents: V3DocumentInput[]
    containerTag: string
    dreaming?: "instant" | string
    maxAttempts?: number
  }): Promise<V3BatchResponse>
  getDocument(idOrCustomId: string): Promise<Record<string, unknown> | null>
  listDocumentsByCustomIds(
    customIds: string[],
    containerTag?: string,
    signal?: AbortSignal
  ): Promise<Array<Record<string, unknown>>>
  searchV4(request: V4SearchRequest, maxAttempts?: number): Promise<Record<string, unknown>>
  deleteDocument(idOrCustomId: string, signal?: AbortSignal): Promise<void>
}

interface RequestOptions {
  body?: Record<string, unknown>
  maxAttempts?: number
  operation: string
  timeoutMs?: number
  allowNotFound?: boolean
  signal?: AbortSignal
}

export class AdvancedSupermemoryClient implements AdvancedSupermemoryApi {
  readonly baseUrl: string
  private readonly apiKey: string
  private readonly maxAttempts: number
  private readonly requestTimeoutMs: number
  private readonly backoffBaseMs: number
  private readonly backoffMaxMs: number
  private readonly fetchImpl: typeof fetch
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly clock: () => number
  private readonly random: () => number
  private readonly budget: AdaptiveRequestBudget
  private readonly eventLogger?: AdvancedSupermemoryEventLogger
  private readonly userAgent: string
  private requests = 0

  constructor(options: AdvancedSupermemoryClientOptions) {
    if (!options.apiKey.trim()) throw new Error("Supermemory API key is required")
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL)
    this.apiKey = options.apiKey
    this.maxAttempts = options.maxAttempts ?? 8
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000
    this.backoffBaseMs = options.backoffBaseMs ?? 1_000
    this.backoffMaxMs = options.backoffMaxMs ?? 60_000
    this.fetchImpl = options.fetch ?? fetch
    this.sleep = options.sleep ?? ((milliseconds) => Bun.sleep(milliseconds))
    this.clock = options.clock ?? Date.now
    this.random = options.random ?? Math.random
    this.eventLogger = options.eventLogger
    this.userAgent = options.userAgent ?? "memorybench-supermemory-advanced/1"
    this.budget =
      options.budget ??
      getSharedSupermemoryRequestBudget({
        baseUrl: this.baseUrl,
        apiKey: this.apiKey,
        maxInFlight: options.maxInFlightRequests ?? 20,
        eventLogger: options.eventLogger,
      })

    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new Error("maxAttempts must be an integer >= 1")
    }
  }

  get requestCount(): number {
    return this.requests
  }

  get budgetSnapshot(): RequestBudgetSnapshot {
    return this.budget.snapshot()
  }

  async addDocument(input: {
    document: V3DocumentInput
    containerTag: string
    dreaming?: "instant" | string
    maxAttempts?: number
  }): Promise<V3DocumentResponse> {
    validateDocument(input.document)
    const payload = await this.request("POST", "/v3/documents", {
      operation: "add_document",
      maxAttempts: input.maxAttempts,
      body: {
        ...input.document,
        containerTag: requireNonEmpty(input.containerTag, "containerTag"),
        ...(input.dreaming ? { dreaming: input.dreaming } : {}),
      },
    })
    if (!isRecord(payload) || typeof payload.id !== "string" || !payload.id) {
      throw new SupermemoryContractError("add_document returned an unexpected response")
    }
    return payload as V3DocumentResponse
  }

  async addDocumentsBatch(input: {
    documents: V3DocumentInput[]
    containerTag: string
    dreaming?: "instant" | string
    maxAttempts?: number
  }): Promise<V3BatchResponse> {
    if (input.documents.length < 1 || input.documents.length > 600) {
      throw new Error("A V3 document batch must contain between 1 and 600 documents")
    }
    input.documents.forEach(validateDocument)
    const payload = await this.request("POST", "/v3/documents/batch", {
      operation: "add_documents_batch",
      maxAttempts: input.maxAttempts,
      body: {
        documents: input.documents,
        containerTag: requireNonEmpty(input.containerTag, "containerTag"),
        ...(input.dreaming ? { dreaming: input.dreaming } : {}),
      },
    })
    if (!isRecord(payload) || !Array.isArray(payload.results)) {
      throw new SupermemoryContractError("add_documents_batch returned an unexpected response")
    }
    return payload as unknown as V3BatchResponse
  }

  async getDocument(idOrCustomId: string): Promise<Record<string, unknown> | null> {
    const payload = await this.request(
      "GET",
      `/v3/documents/${encodeURIComponent(requireNonEmpty(idOrCustomId, "document ID"))}`,
      {
        operation: "get_document",
        allowNotFound: true,
      }
    )
    if (payload === null) return null
    if (!isRecord(payload)) {
      throw new SupermemoryContractError("get_document returned a non-object response")
    }
    return payload
  }

  async listDocumentsByCustomIds(
    customIds: string[],
    containerTag?: string,
    signal?: AbortSignal
  ): Promise<Array<Record<string, unknown>>> {
    if (customIds.length === 0) return []
    const ids = customIds.map((value) => requireNonEmpty(value, "customId"))
    const payload = await this.request("POST", "/v3/documents/documents/by-ids", {
      operation: "list_documents_by_custom_ids",
      body: {
        ids,
        by: "customId",
        ...(containerTag ? { containerTags: [containerTag] } : {}),
      },
      signal,
    })
    if (!isRecord(payload) || !Array.isArray(payload.documents)) return []
    return payload.documents.filter(isRecord)
  }

  async searchV4(
    searchRequest: V4SearchRequest,
    maxAttempts?: number
  ): Promise<Record<string, unknown>> {
    if (!Number.isInteger(searchRequest.limit) || searchRequest.limit < 1) {
      throw new Error("V4 search limit must be an integer >= 1")
    }
    const payload = await this.request("POST", "/v4/search", {
      operation: "search_v4",
      maxAttempts,
      body: { ...searchRequest },
    })
    if (!isRecord(payload) || !Array.isArray(payload.results)) {
      throw new SupermemoryContractError("search_v4 returned an unexpected response")
    }
    return payload
  }

  async deleteDocument(idOrCustomId: string, signal?: AbortSignal): Promise<void> {
    await this.request(
      "DELETE",
      `/v3/documents/${encodeURIComponent(requireNonEmpty(idOrCustomId, "document ID"))}`,
      {
        operation: "delete_document",
        allowNotFound: true,
        signal,
      }
    )
  }

  private async request(
    method: string,
    path: string,
    options: RequestOptions
  ): Promise<unknown | null> {
    const attemptsAllowed = options.maxAttempts ?? this.maxAttempts
    if (!Number.isInteger(attemptsAllowed) || attemptsAllowed < 1) {
      throw new Error("maxAttempts must be an integer >= 1")
    }
    let lastError: SupermemoryHttpError | undefined

    for (let attempt = 1; attempt <= attemptsAllowed; attempt += 1) {
      throwIfAborted(options.signal, options.operation)
      try {
        const result = await this.attempt(method, path, options)
        this.budget.recordSuccess()
        return result
      } catch (error) {
        throwIfAborted(options.signal, options.operation)
        if (!(error instanceof SupermemoryHttpError)) throw error
        if (options.allowNotFound && error.statusCode === 404) return null
        if (!error.retryable) throw error
        lastError = error
        this.budget.recordPressure(
          `${options.operation}:${error.statusCode ?? "transport"}`,
          error.retryAfterMs
        )
        this.emit("supermemory_request_retry", {
          operation: options.operation,
          path,
          attempt,
          maxAttempts: attemptsAllowed,
          statusCode: error.statusCode,
          error: error.message,
        })
        if (attempt >= attemptsAllowed) break
        await abortableSleep(
          this.sleep,
          this.retryDelay(attempt, error.retryAfterMs),
          options.signal,
          options.operation
        )
      }
    }

    throw new SupermemoryRetryExhaustedError(
      options.operation,
      attemptsAllowed,
      lastError ??
        new SupermemoryHttpError("request failed without a classified error", {
          retryable: true,
        })
    )
  }

  private async attempt(
    method: string,
    path: string,
    options: RequestOptions
  ): Promise<unknown | null> {
    const controller = new AbortController()
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    const onParentAbort = () => controller.abort(options.signal?.reason)
    options.signal?.addEventListener("abort", onParentAbort, { once: true })
    if (options.signal?.aborted) onParentAbort()

    let response: Response
    let text: string
    try {
      const completed = await this.budget.run(async () => {
        this.requests += 1
        const fetched = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            "User-Agent": this.userAgent,
          },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: controller.signal,
        })
        return { response: fetched, text: await fetched.text() }
      })
      response = completed.response
      text = completed.text
    } catch (error) {
      throw new SupermemoryHttpError(
        `transport error during ${options.operation}: ${
          error instanceof Error ? error.name : "unknown"
        }`,
        { retryable: true, cause: error }
      )
    } finally {
      clearTimeout(timeout)
      options.signal?.removeEventListener("abort", onParentAbort)
    }

    const payload = parseResponseBody(text)
    if (response.ok) return payload

    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), this.clock())
    const retryable =
      RETRYABLE_HTTP_STATUSES.has(response.status) ||
      (response.status >= 500 && response.status <= 599)
    const snippet = safeBodySnippet(text, [this.apiKey])
    throw new SupermemoryHttpError(
      `HTTP ${response.status} during ${options.operation}${snippet ? `: ${snippet}` : ""}`,
      {
        statusCode: response.status,
        retryable,
        retryAfterMs,
      }
    )
  }

  private retryDelay(attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs !== undefined) return Math.min(retryAfterMs, this.backoffMaxMs)
    const exponential = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** (attempt - 1))
    return exponential * (0.5 + this.random() / 2)
  }

  private emit(event: string, details: Record<string, unknown>): void {
    try {
      this.eventLogger?.(event, redact(details, [this.apiKey]) as Record<string, unknown>)
    } catch {
      // Logging is best effort.
    }
  }
}

export function redact<T>(value: T, secrets: string[] = []): T {
  return redactUnknown(value, secrets.filter(Boolean)) as T
}

function redactUnknown(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") return sanitizeText(value, secrets)
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item, secrets))
  if (!isRecord(value)) return value
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (/(authorization|api[-_]?key|secret|token|password)/i.test(key)) {
      output[key] = "<redacted>"
    } else {
      output[key] = redactUnknown(item, secrets)
    }
  }
  return output
}

function sanitizeText(value: string, secrets: string[]): string {
  let sanitized = value.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
  for (const secret of secrets) {
    sanitized = sanitized.split(secret).join("<redacted>")
  }
  return sanitized
}

function safeBodySnippet(body: string, secrets: string[]): string {
  const sanitized = sanitizeText(body.trim(), secrets).replace(/[\u0000-\u001f\u007f]/g, " ")
  return sanitized.length > BODY_SNIPPET_LIMIT
    ? `${sanitized.slice(0, BODY_SNIPPET_LIMIT)}...<truncated>`
    : sanitized
}

function throwIfAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted) throw signal.reason ?? new Error(`${operation} aborted`)
}

async function abortableSleep(
  sleep: (milliseconds: number) => Promise<void>,
  milliseconds: number,
  signal: AbortSignal | undefined,
  operation: string
): Promise<void> {
  throwIfAborted(signal, operation)
  if (!signal) {
    await sleep(milliseconds)
    return
  }
  let onAbort: (() => void) | undefined
  try {
    await Promise.race([
      sleep(milliseconds),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason ?? new Error(`${operation} aborted`))
        signal.addEventListener("abort", onAbort, { once: true })
        if (signal.aborted) onAbort()
      }),
    ])
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort)
  }
  throwIfAborted(signal, operation)
}

function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined
  const seconds = Number(value.trim())
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000)
  const dateMs = Date.parse(value)
  if (Number.isNaN(dateMs)) return undefined
  return Math.max(0, dateMs - nowMs)
}

function parseResponseBody(text: string): unknown | null {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "")
  const url = new URL(trimmed)
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Supermemory base URL must use HTTP or HTTPS")
  }
  if (url.username || url.password) {
    throw new Error("Supermemory base URL must not contain credentials")
  }
  return trimmed
}

function requireNonEmpty(value: string, field: string): string {
  if (!value.trim()) throw new Error(`${field} must not be empty`)
  return value
}

function validateDocument(document: V3DocumentInput): void {
  requireNonEmpty(document.content, "document content")
  requireNonEmpty(document.customId, "customId")
  if (!isRecord(document.metadata)) throw new Error("document metadata must be an object")
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
