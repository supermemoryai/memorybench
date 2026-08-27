import { readdir } from "node:fs/promises"
import type { BuildProvider } from "../types/provider"
import type { AssetRef, MemoryBuildPlan, QueryArtifact, RetrievalConfig } from "../types/migration"
import { canonicalJson } from "./canonical"
import { queryFingerprint } from "./fingerprints"
import { ArtifactStore } from "./artifact-store"

export const RETRIEVAL_NORMALIZER_VERSION = 1

export interface QueryRunnerInput {
  build: MemoryBuildPlan
  questionId: string
  query: string
  questionImage?: AssetRef
  config: RetrievalConfig
  fresh?: boolean
}

export class QueryRunner {
  constructor(
    private readonly provider: BuildProvider,
    private readonly artifacts: ArtifactStore
  ) {}

  async run(input: QueryRunnerInput): Promise<QueryArtifact> {
    const fingerprint = queryFingerprint({
      buildFingerprint: input.build.buildFingerprint,
      questionText: input.query,
      questionImageHash: input.questionImage?.sha256,
      retrieval: input.config,
      normalizerVersion: RETRIEVAL_NORMALIZER_VERSION,
    })
    const directory = `queries/${input.questionId}/${fingerprint}`
    const started = performance.now()
    if (!input.fresh) {
      const cached = await this.loadCached(directory, {
        fingerprint,
        questionId: input.questionId,
        buildId: input.build.buildId,
        buildFingerprint: input.build.buildFingerprint,
        query: input.query,
        questionImageHash: input.questionImage?.sha256,
        config: input.config,
      })
      if (cached) {
        const assets = new Map(
          input.build.documents
            .flatMap((document) => (document.screenshotRef ? [document.screenshotRef] : []))
            .flatMap((asset) => [
              [asset.assetId, asset] as const,
              [asset.sha256, asset] as const,
              [asset.relativePath, asset] as const,
            ])
        )
        return {
          ...cached,
          questionImage: input.questionImage,
          normalizedResults: cached.normalizedResults.map((result) => ({
            ...result,
            screenshotRefs: result.screenshotRefs.map(
              (asset) =>
                assets.get(asset.assetId) ??
                assets.get(asset.sha256) ??
                assets.get(asset.relativePath) ??
                asset
            ),
          })),
          cacheHit: true,
          wallDurationMs: performance.now() - started,
        }
      }
    }

    const response = await this.provider.searchBuild({
      build: input.build,
      questionId: input.questionId,
      query: input.query,
      config: input.config,
    })
    if (response.normalizedResults.length > input.config.topK) {
      throw new Error(
        `Provider ${this.provider.name} violated topK=${input.config.topK}; returned ${response.normalizedResults.length}`
      )
    }
    const invalid = response.normalizedResults.filter((result) => !result.provenanceValid)
    if (invalid.length > 0) {
      throw new Error(
        `Rejected ${invalid.length} retrieval results with missing or wrong build provenance`
      )
    }

    const attempt = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}`
    const rawArtifact = await this.artifacts.writeJson(`${directory}/${attempt}.raw.json`, {
      schemaVersion: 1,
      questionId: input.questionId,
      buildId: input.build.buildId,
      buildFingerprint: input.build.buildFingerprint,
      request: response.request,
      response: response.rawResponse,
      remoteDurationMs: response.remoteDurationMs,
      createdAt: new Date().toISOString(),
    })
    const normalizedArtifact = await this.artifacts.writeJson(
      `${directory}/${attempt}.normalized.json`,
      {
        schemaVersion: 1,
        questionId: input.questionId,
        queryFingerprint: fingerprint,
        results: response.normalizedResults.map((result) => ({
          ...result,
          screenshotRefs: result.screenshotRefs.map((asset) => ({
            ...asset,
            absolutePath: undefined,
          })),
        })),
      }
    )
    const artifact: QueryArtifact = {
      schemaVersion: 1,
      questionId: input.questionId,
      buildId: input.build.buildId,
      buildFingerprint: input.build.buildFingerprint,
      queryFingerprint: fingerprint,
      query: input.query,
      questionImage: input.questionImage,
      config: input.config,
      request: response.request,
      rawArtifact,
      normalizedArtifact,
      normalizedResults: response.normalizedResults,
      remoteDurationMs: response.remoteDurationMs,
      wallDurationMs: performance.now() - started,
      cacheHit: false,
      createdAt: new Date().toISOString(),
    }
    await this.artifacts.writeJson(`${directory}/${attempt}.record.json`, {
      ...artifact,
      questionImage: artifact.questionImage
        ? { ...artifact.questionImage, absolutePath: undefined }
        : undefined,
      normalizedResults: artifact.normalizedResults.map((result) => ({
        ...result,
        screenshotRefs: result.screenshotRefs.map((asset) => ({
          ...asset,
          absolutePath: undefined,
        })),
      })),
    })
    return artifact
  }

  private async loadCached(
    directory: string,
    expected: {
      fingerprint: string
      questionId: string
      buildId: string
      buildFingerprint: string
      query: string
      questionImageHash?: string
      config: RetrievalConfig
    }
  ): Promise<QueryArtifact | null> {
    let names: string[]
    try {
      names = await readdir(this.artifacts.resolve(directory))
    } catch {
      return null
    }
    const recordName = names
      .filter((name) => name.endsWith(".record.json"))
      .sort()
      .at(-1)
    if (!recordName) return null
    try {
      const artifact = await this.artifacts.readJson<QueryArtifact>(`${directory}/${recordName}`)
      const recomputedFingerprint = queryFingerprint({
        buildFingerprint: artifact.buildFingerprint,
        questionText: artifact.query,
        questionImageHash: artifact.questionImage?.sha256,
        retrieval: artifact.config,
        normalizerVersion: RETRIEVAL_NORMALIZER_VERSION,
      })
      if (
        artifact.schemaVersion !== 1 ||
        artifact.questionId !== expected.questionId ||
        artifact.buildId !== expected.buildId ||
        artifact.buildFingerprint !== expected.buildFingerprint ||
        artifact.queryFingerprint !== expected.fingerprint ||
        artifact.query !== expected.query ||
        artifact.questionImage?.sha256 !== expected.questionImageHash ||
        recomputedFingerprint !== expected.fingerprint ||
        canonicalJson(artifact.config) !== canonicalJson(expected.config) ||
        !Number.isFinite(artifact.remoteDurationMs) ||
        artifact.remoteDurationMs < 0 ||
        !Number.isFinite(artifact.wallDurationMs) ||
        artifact.wallDurationMs < 0 ||
        artifact.normalizedResults.length > expected.config.topK
      ) {
        return null
      }
      const prefix = `${directory}/`
      if (
        !artifact.rawArtifact.relativePath.startsWith(prefix) ||
        !artifact.normalizedArtifact.relativePath.startsWith(prefix)
      ) {
        return null
      }
      const raw = await this.artifacts.describe(artifact.rawArtifact.relativePath)
      const normalized = await this.artifacts.describe(artifact.normalizedArtifact.relativePath)
      if (
        raw.sha256 !== artifact.rawArtifact.sha256 ||
        normalized.sha256 !== artifact.normalizedArtifact.sha256
      ) {
        return null
      }
      const rawPayload = await this.artifacts.readJson<{
        schemaVersion: number
        questionId: string
        buildId: string
        buildFingerprint: string
        request: Record<string, unknown>
        remoteDurationMs: number
      }>(artifact.rawArtifact.relativePath)
      const normalizedPayload = await this.artifacts.readJson<{
        schemaVersion: number
        questionId: string
        queryFingerprint: string
        results: QueryArtifact["normalizedResults"]
      }>(artifact.normalizedArtifact.relativePath)
      if (
        rawPayload.schemaVersion !== 1 ||
        rawPayload.questionId !== expected.questionId ||
        rawPayload.buildId !== expected.buildId ||
        rawPayload.buildFingerprint !== expected.buildFingerprint ||
        rawPayload.remoteDurationMs !== artifact.remoteDurationMs ||
        canonicalJson(rawPayload.request) !== canonicalJson(artifact.request) ||
        normalizedPayload.schemaVersion !== 1 ||
        normalizedPayload.questionId !== expected.questionId ||
        normalizedPayload.queryFingerprint !== expected.fingerprint ||
        canonicalJson(normalizedPayload.results) !== canonicalJson(artifact.normalizedResults)
      ) {
        return null
      }
      if (artifact.normalizedResults.some((result) => !result.provenanceValid)) return null
      return artifact
    } catch {
      return null
    }
  }
}
