import type {
  BuildBatchRequest,
  BuildProvider,
  BuildSearchRequest,
  BuildSearchResponse,
  RemoteDocumentState,
} from "../../../types/provider"
import type {
  AssetRef,
  MemoryBuildPlan,
  NormalizedRetrievalResult,
  PhysicalDocument,
} from "../../../types/migration"
import {
  AdvancedSupermemoryClient,
  type AdvancedSupermemoryApi,
  type AdvancedSupermemoryClientOptions,
  type SupermemoryMetadata,
} from "./client"
import {
  AdvancedSupermemoryBuild,
  type AdvancedSupermemoryBuildOptions,
  type ReconciledDocument,
  type SupermemoryBuildIdentity,
} from "./build"
import { AdvancedSupermemoryRetrieval } from "./retrieval"
import {
  AdvancedSupermemoryPreflight,
  type SupermemoryPreflightOptions,
  type SupermemoryPreflightReport,
} from "./preflight"

export type AdvancedSupermemoryProviderOptions = Pick<
  AdvancedSupermemoryBuildOptions,
  "cleanupTimeoutMs" | "signal"
>

export class AdvancedSupermemoryProvider implements BuildProvider {
  readonly name = "supermemory"
  readonly capabilities = {
    deterministicExternalIds: true,
    batchUpload: true,
    documentDependencies: false,
    ingestionMetadataFilters: true,
    searchMetadataFilters: true,
    searchModes: ["hybrid", "memories"] as const,
    reranking: true,
    queryRewriting: true,
    remoteClear: true,
    readinessStates: true,
    mediaIngestion: false,
    durableLocalPersistence: true,
    splitPhaseSafe: true,
  }

  readonly client: AdvancedSupermemoryApi
  private readonly buildDriver: AdvancedSupermemoryBuild
  private readonly retrievalDriver: AdvancedSupermemoryRetrieval

  constructor(
    clientOrOptions: AdvancedSupermemoryApi | AdvancedSupermemoryClientOptions,
    options: AdvancedSupermemoryProviderOptions = {}
  ) {
    this.client = isAdvancedApi(clientOrOptions)
      ? clientOrOptions
      : new AdvancedSupermemoryClient(clientOrOptions)
    this.buildDriver = new AdvancedSupermemoryBuild(this.client, options)
    this.retrievalDriver = new AdvancedSupermemoryRetrieval(this.client)
  }

  async submitDocumentBatch(request: BuildBatchRequest): Promise<RemoteDocumentState[]> {
    const submission = await this.buildDriver.submitTrajectoryBatch({
      trajectoryId: request.trajectoryId,
      identity: buildIdentity(request.build),
      documents: request.documents.map((document) => {
        if (document.trajectoryId !== request.trajectoryId) {
          throw new Error(
            `Document ${document.customId} belongs to ${document.trajectoryId}, not ${request.trajectoryId}`
          )
        }
        return {
          customId: document.customId,
          content: document.content,
          metadata: documentMetadata(request.build, document),
          filterByMetadata: rootSelfFilter(request.build, request.trajectoryId, document),
        }
      }),
    })
    return submission.documents.map(toProviderState)
  }

  async reconcileDocuments(
    build: MemoryBuildPlan,
    customIds: string[]
  ): Promise<RemoteDocumentState[]> {
    const states = await this.buildDriver.reconcileByCustomId(customIds, build.containerTag)
    for (const state of states) {
      if (state.status === "absent") continue
      if (
        state.metadata?.runFingerprint !== build.buildFingerprint ||
        state.metadata?.buildFingerprint !== build.buildFingerprint ||
        state.metadata?.buildId !== build.buildId
      ) {
        throw new Error(
          `Remote document ${state.customId} does not belong to build ${build.buildId}`
        )
      }
    }
    return states.map(toProviderState)
  }

  async searchBuild(request: BuildSearchRequest): Promise<BuildSearchResponse> {
    const outcome = await this.retrievalDriver.search({
      identity: buildIdentity(request.build),
      query: request.query,
      config: {
        topK: request.config.topK,
        threshold: request.config.threshold,
        searchMode: request.config.searchMode,
        rerank: request.config.rerank,
        rewriteQuery: request.config.rewriteQuery,
        includeSummaries: request.config.includeSummaries,
        includeChunks: request.config.includeChunks,
        includeDocuments: request.config.includeDocuments,
        includeRelatedMemories: request.config.includeRelatedMemories,
        metadataFilter: request.config.metadataFilter,
        strictProvenance: true,
      },
    })
    const assets = screenshotAssets(request.build)
    const normalizedResults: NormalizedRetrievalResult[] = outcome.normalizedResults.map(
      (result) => {
        const screenshotRefs: AssetRef[] = []
        let assetsValid = true
        for (const remoteAsset of result.screenshotAssets) {
          const asset = assets.get(remoteAsset.assetId) ?? assets.get(remoteAsset.path)
          if (
            !asset ||
            asset.sha256 !== remoteAsset.sha256 ||
            asset.mimeType !== remoteAsset.mimeType ||
            asset.byteLength !== remoteAsset.byteLength
          ) {
            assetsValid = false
            continue
          }
          if (!screenshotRefs.some((existing) => existing.assetId === asset.assetId)) {
            screenshotRefs.push(asset)
          }
        }
        return {
          rank: result.rank,
          score: result.score,
          kind: result.kind,
          text: result.text,
          summary: result.summaries.length > 0 ? result.summaries.join("\n\n") : undefined,
          chunks: result.chunks,
          providerResultId: result.providerResultId,
          documentIds: result.documentIds,
          trajectoryId: result.trajectoryId,
          stateIndex: result.stateIndex,
          screenshotRefs,
          provenanceValid: result.provenanceValid && assetsValid,
        }
      }
    )
    return {
      request: { ...outcome.request },
      rawResponse: outcome.rawResponse,
      normalizedResults,
      remoteDurationMs: outcome.remoteDurationMs,
    }
  }

  async verifyBuildHealth(build: MemoryBuildPlan): Promise<RemoteDocumentState[]> {
    return this.reconcileDocuments(
      build,
      build.documents.map((document) => document.customId)
    )
  }

  async deleteDocuments(build: MemoryBuildPlan, customIds: string[]): Promise<void> {
    if (customIds.length === 0) return
    await this.buildDriver.cleanupExactBuild({
      identity: buildIdentity(build),
      customIds,
    })
  }

  async clearBuild(build: MemoryBuildPlan): Promise<void> {
    await this.deleteDocuments(
      build,
      build.documents.map((document) => document.customId)
    )
  }

  async preflight(options?: SupermemoryPreflightOptions): Promise<SupermemoryPreflightReport> {
    return new AdvancedSupermemoryPreflight(this.client, options).run()
  }
}

function buildIdentity(build: MemoryBuildPlan): SupermemoryBuildIdentity {
  return {
    buildId: build.buildId,
    containerTag: build.containerTag,
    runFingerprint: build.buildFingerprint,
  }
}

function documentMetadata(build: MemoryBuildPlan, document: PhysicalDocument): SupermemoryMetadata {
  if (
    document.metadata.causalKey !== undefined &&
    document.metadata.causalKey !== document.customId
  ) {
    throw new Error(`Document ${document.customId} has a conflicting causalKey`)
  }
  return {
    ...document.metadata,
    benchmark: build.benchmark,
    adapterSchemaVersion: build.schemaVersion,
    buildId: build.buildId,
    runFingerprint: build.buildFingerprint,
    buildFingerprint: build.buildFingerprint,
    tier: build.tier,
    domain: build.domain,
    trajectoryId: document.trajectoryId,
    documentType: document.documentType,
    documentOrdinal: document.documentOrdinal,
    partIndex: document.partIndex,
    partCount: document.partCount,
    contentHash: document.contentHash,
    logicalDocumentId: document.logicalDocumentId,
    causalKey: document.customId,
    ...(document.stateIndex !== undefined ? { stateIndex: document.stateIndex } : {}),
    ...(document.step !== undefined ? { step: document.step } : {}),
    ...(document.screenshotRef
      ? {
          screenshotPath: document.screenshotRef.relativePath,
          screenshotAssetId: document.screenshotRef.assetId,
          screenshotSha256: document.screenshotRef.sha256,
          screenshotMimeType: document.screenshotRef.mimeType,
          screenshotByteLength: document.screenshotRef.byteLength,
        }
      : {}),
  }
}

function rootSelfFilter(
  build: MemoryBuildPlan,
  trajectoryId: string,
  document: PhysicalDocument
): SupermemoryMetadata {
  return {
    runFingerprint: build.buildFingerprint,
    buildFingerprint: build.buildFingerprint,
    trajectoryId,
    causalKey: document.customId,
  }
}

function toProviderState(document: ReconciledDocument): RemoteDocumentState {
  const status: RemoteDocumentState["status"] =
    document.status === "ready"
      ? "ready"
      : document.status === "failed"
        ? "failed"
        : document.status === "absent"
          ? "absent"
          : document.status === "accepted" || document.status === "indexing"
            ? "pending"
            : "unknown"
  return {
    customId: document.customId,
    remoteId: document.remoteId,
    status,
    raw: document.raw,
    ...(status === "failed"
      ? { error: `Remote Supermemory status ${document.remoteStatus ?? "failed"}` }
      : {}),
  }
}

function screenshotAssets(build: MemoryBuildPlan): Map<string, AssetRef> {
  const assets = new Map<string, AssetRef>()
  for (const document of build.documents) {
    const asset = document.screenshotRef
    if (!asset) continue
    assets.set(asset.relativePath, asset)
    if (asset.absolutePath) assets.set(asset.absolutePath, asset)
    assets.set(asset.assetId, asset)
  }
  return assets
}

function isAdvancedApi(
  value: AdvancedSupermemoryApi | AdvancedSupermemoryClientOptions
): value is AdvancedSupermemoryApi {
  return (
    "addDocumentsBatch" in value &&
    typeof value.addDocumentsBatch === "function" &&
    "searchV4" in value &&
    typeof value.searchV4 === "function"
  )
}
