import type {
  BuildAwareSessionBridge,
  BuildBatchRequest,
  BuildProvider,
  BuildSearchRequest,
  BuildSearchResponse,
  Provider,
  RemoteDocumentState,
} from "../../types/provider"
import type {
  AssetRef,
  MemoryBuildPlan,
  NormalizedRetrievalResult,
  PhysicalDocument,
} from "../../types/migration"
import type { UnifiedSession } from "../../types/unified"

export interface LegacyBuildProviderAdapterOptions {
  operationTimeoutMs: number
  signal?: AbortSignal
}

/**
 * Adapts local legacy providers that expose an exact, durable session bridge to
 * the shared MemoryBuild contract. This intentionally excludes Mem0 and Zep:
 * their current SDK paths cannot prove exact per-document reconciliation and
 * cleanup after an interrupted async ingestion.
 */
export class LegacyBuildProviderAdapter implements BuildProvider {
  readonly name: string
  readonly capabilities
  private readonly bridge: BuildAwareSessionBridge

  constructor(
    private readonly provider: Provider,
    private readonly options: LegacyBuildProviderAdapterOptions
  ) {
    if (!isSessionBridge(provider)) {
      throw new Error(`Provider ${provider.name} has no exact build-aware session bridge`)
    }
    if (!Number.isInteger(options.operationTimeoutMs) || options.operationTimeoutMs < 1) {
      throw new Error("operationTimeoutMs must be a positive integer")
    }
    this.name = provider.name
    this.bridge = provider
    this.capabilities = {
      deterministicExternalIds: true,
      batchUpload: true,
      documentDependencies: false,
      // Isolation is provided by a content-addressed container tag, not by
      // provider metadata filters. Keep these flags honest.
      ingestionMetadataFilters: false,
      searchMetadataFilters: false,
      searchModes: provider.capabilities.searchModes,
      reranking: provider.capabilities.reranking,
      queryRewriting: provider.capabilities.queryRewriting,
      remoteClear: true,
      readinessStates: true,
      mediaIngestion: false,
      durableLocalPersistence: true,
      splitPhaseSafe: true,
    }
  }

  async submitDocumentBatch(request: BuildBatchRequest): Promise<RemoteDocumentState[]> {
    validateBatch(request)
    const sessions = request.documents.map((document) => toSession(request.build, document))
    const ingestion = await withTimeout(
      (signal) =>
        this.provider.ingest(sessions, {
          containerTag: request.build.containerTag,
          metadata: buildMetadata(request.build),
          signal,
        }),
      this.options.operationTimeoutMs,
      `${this.name} ingestion`,
      this.options.signal
    )
    await withTimeout(
      () => this.provider.awaitIndexing(ingestion, request.build.containerTag),
      this.options.operationTimeoutMs,
      `${this.name} indexing`,
      this.options.signal
    )
    return this.reconcileDocuments(
      request.build,
      request.documents.map((document) => document.customId)
    )
  }

  async reconcileDocuments(
    build: MemoryBuildPlan,
    customIds: string[]
  ): Promise<RemoteDocumentState[]> {
    const expected = expectedDocuments(build, customIds)
    const states = await withTimeout(
      () => this.bridge.inspectSessions(build.containerTag, customIds),
      this.options.operationTimeoutMs,
      `${this.name} reconciliation`,
      this.options.signal
    )
    const returned = new Map(states.map((state) => [state.sessionId, state]))
    return customIds.map((customId) => {
      const document = expected.get(customId)!
      const state = returned.get(customId)
      const ready =
        state?.status === "ready" &&
        state.metadata?.buildFingerprint === build.buildFingerprint &&
        state.metadata?.buildId === build.buildId &&
        state.metadata?.contentHash === document.contentHash &&
        state.metadata?.customId === document.customId
      return {
        customId,
        remoteId: ready ? `${this.name}:${customId}` : undefined,
        status: ready ? "ready" : "absent",
        raw: state,
      }
    })
  }

  async searchBuild(request: BuildSearchRequest): Promise<BuildSearchResponse> {
    const started = performance.now()
    const raw = await withTimeout(
      (signal) =>
        this.provider.search(request.query, {
          containerTag: request.build.containerTag,
          limit: request.config.topK,
          threshold: request.config.threshold,
          signal,
        }),
      this.options.operationTimeoutMs,
      `${this.name} search`,
      this.options.signal
    )
    const values = Array.isArray(raw) ? raw : []
    const normalizedResults = values
      .map((value, rank) => normalizeResult(request.build, value, rank))
      .filter(
        (result) =>
          result.provenanceValid &&
          (result.score === undefined || result.score >= request.config.threshold)
      )
      .slice(0, request.config.topK)
      .map((result, rank) => ({ ...result, rank }))
    return {
      request: {
        provider: this.name,
        containerTag: request.build.containerTag,
        limit: request.config.topK,
        threshold: request.config.threshold,
        searchMode: request.config.searchMode,
      },
      rawResponse: raw,
      normalizedResults,
      remoteDurationMs: performance.now() - started,
    }
  }

  async verifyBuildHealth(build: MemoryBuildPlan): Promise<RemoteDocumentState[]> {
    return this.reconcileDocuments(
      build,
      build.documents.map((document) => document.customId)
    )
  }

  async deleteDocuments(build: MemoryBuildPlan, customIds: string[]): Promise<void> {
    expectedDocuments(build, customIds)
    await withTimeout(
      () => this.bridge.deleteSessions(build.containerTag, customIds),
      this.options.operationTimeoutMs,
      `${this.name} exact cleanup`,
      this.options.signal
    )
    const remaining = await this.reconcileDocuments(build, customIds)
    if (remaining.some((state) => state.status !== "absent")) {
      throw new Error(`${this.name} exact cleanup did not remove every requested document`)
    }
  }

  async clearBuild(build: MemoryBuildPlan): Promise<void> {
    await withTimeout(
      () => this.provider.clear(build.containerTag),
      this.options.operationTimeoutMs,
      `${this.name} build cleanup`,
      this.options.signal
    )
  }
}

function isSessionBridge(provider: Provider): provider is Provider & BuildAwareSessionBridge {
  const candidate = provider as Partial<BuildAwareSessionBridge>
  return (
    typeof candidate.inspectSessions === "function" &&
    typeof candidate.deleteSessions === "function"
  )
}

function validateBatch(request: BuildBatchRequest): void {
  for (const document of request.documents) {
    if (document.trajectoryId !== request.trajectoryId) {
      throw new Error(
        `Document ${document.customId} belongs to ${document.trajectoryId}, not ${request.trajectoryId}`
      )
    }
  }
}

function expectedDocuments(
  build: MemoryBuildPlan,
  customIds: string[]
): Map<string, PhysicalDocument> {
  const documents = new Map(build.documents.map((document) => [document.customId, document]))
  for (const customId of customIds) {
    if (!documents.has(customId)) {
      throw new Error(`Document ${customId} does not belong to build ${build.buildId}`)
    }
  }
  return documents
}

function buildMetadata(build: MemoryBuildPlan): Record<string, unknown> {
  return {
    benchmark: build.benchmark,
    buildId: build.buildId,
    buildFingerprint: build.buildFingerprint,
  }
}

function toSession(build: MemoryBuildPlan, document: PhysicalDocument): UnifiedSession {
  return {
    sessionId: document.customId,
    messages: [{ role: "user", speaker: "user", content: document.content }],
    metadata: {
      ...document.metadata,
      ...buildMetadata(build),
      customId: document.customId,
      contentHash: document.contentHash,
      trajectoryId: document.trajectoryId,
      documentType: document.documentType,
      documentOrdinal: document.documentOrdinal,
      partIndex: document.partIndex,
      partCount: document.partCount,
      ...(document.stateIndex !== undefined ? { stateIndex: document.stateIndex } : {}),
      ...(document.step !== undefined ? { step: document.step } : {}),
      ...(document.screenshotRef
        ? {
            screenshotAssetId: document.screenshotRef.assetId,
            screenshotSha256: document.screenshotRef.sha256,
          }
        : {}),
    },
  }
}

function normalizeResult(
  build: MemoryBuildPlan,
  value: unknown,
  rank: number
): NormalizedRetrievalResult {
  const record = asRecord(value)
  const metadata = asRecord(record.metadata)
  const candidateIds = [
    ...new Set(
      [
        stringValue(record.sessionId),
        stringValue(record.session_id),
        stringValue(record.customId),
        stringValue(metadata.sessionId),
        stringValue(metadata.session_id),
        stringValue(metadata.customId),
      ].filter((item): item is string => Boolean(item))
    ),
  ]
  const matchedDocuments = build.documents.filter((item) => candidateIds.includes(item.customId))
  const document = matchedDocuments.length === 1 ? matchedDocuments[0] : undefined
  const trajectoryId = document?.trajectoryId
  const screenshotRefs = uniqueAssets(
    matchedDocuments.flatMap((item) => (item.screenshotRef ? [item.screenshotRef] : []))
  )
  const declaredFingerprint =
    stringValue(metadata.buildFingerprint) ?? stringValue(record.buildFingerprint)
  const declaredBuildId = stringValue(metadata.buildId) ?? stringValue(record.buildId)
  const provenanceValid =
    (!declaredFingerprint || declaredFingerprint === build.buildFingerprint) &&
    (!declaredBuildId || declaredBuildId === build.buildId) &&
    candidateIds.length > 0 &&
    matchedDocuments.length === 1 &&
    candidateIds.every((id) => id === document?.customId)
  const text = resultText(value)
  return {
    rank,
    score: numberValue(record.score),
    kind: `${build.provider}-memory`,
    text,
    chunks: text ? [text] : [],
    providerResultId:
      stringValue(record.id) ?? stringValue(record.memory_id) ?? `${build.provider}-${rank}`,
    documentIds: matchedDocuments.map((item) => item.customId),
    trajectoryId,
    stateIndex: integerValue(metadata.stateIndex) ?? document?.stateIndex,
    screenshotRefs,
    provenanceValid,
  }
}

function uniqueAssets(assets: AssetRef[]): AssetRef[] {
  const seen = new Set<string>()
  return assets.filter((asset) => {
    if (seen.has(asset.assetId)) return false
    seen.add(asset.assetId)
    return true
  })
}

function resultText(value: unknown): string {
  if (typeof value === "string") return value
  const record = asRecord(value)
  for (const key of ["content", "memory", "text", "fact", "summary", "name"]) {
    const found = stringValue(record[key])
    if (found) return found
  }
  return JSON.stringify(value)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined
}

async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  milliseconds: number,
  label: string,
  parentSignal?: AbortSignal
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const onParentAbort = () =>
    controller.abort(parentSignal?.reason ?? new Error(`${label} aborted`))
  parentSignal?.addEventListener("abort", onParentAbort, { once: true })
  if (parentSignal?.aborted) onParentAbort()
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`${label} timed out after ${milliseconds}ms`)
          controller.abort(error)
          reject(error)
        }, milliseconds)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    parentSignal?.removeEventListener("abort", onParentAbort)
  }
}
