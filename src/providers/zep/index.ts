import { ZepClient } from "@getzep/zep-cloud"
import type {
  Provider,
  ProviderConfig,
  IngestOptions,
  IngestResult,
  SearchOptions,
  IndexingProgressCallback,
  ProviderSearchResponse,
} from "../../types/provider"
import type {
  CanonicalIngestionDocument,
  ProviderResultDropDiagnostic,
  UnifiedSearchResult,
} from "../../types/unified"
import { logger } from "../../utils/logger"
import { stableSha256 } from "../../utils/stable"
import { ZEP_PROMPTS } from "./prompts"
import {
  asFiniteNumber,
  asNonEmptyString,
  asRecord,
  assertResultBudget,
  rankResults,
  recordResultDrop,
  requireSearchLimit,
  createProviderSearchResponse,
} from "../normalization"

const MAX_DATA_SIZE = 9500

async function withDeadline<T>(
  operation: Promise<T>,
  deadlineMs: number,
  timeoutMessage: string
): Promise<T> {
  const remainingMs = deadlineMs - Date.now()
  if (remainingMs <= 0) throw new Error(timeoutMessage)

  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(timeoutMessage)), remainingMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export function allocateZepSearchBudget(limit: number): { edgeLimit: number; nodeLimit: number } {
  requireSearchLimit(limit, "zep")
  return {
    edgeLimit: Math.ceil(limit / 2),
    nodeLimit: Math.floor(limit / 2),
  }
}

export function normalizeZepSearchResults(
  rawResults: unknown[],
  limit: number,
  threshold?: number,
  droppedResults: ProviderResultDropDiagnostic[] = []
): UnifiedSearchResult[] {
  requireSearchLimit(limit, "zep")
  assertResultBudget(rawResults.length, limit, "zep")

  const normalized: Array<Omit<UnifiedSearchResult, "rank"> & { score?: number }> = []
  for (const [index, rawResult] of rawResults.entries()) {
    const result = asRecord(rawResult)
    if (!result) {
      recordResultDrop(droppedResults, index, "malformed-result")
      continue
    }

    const resultType = result._type
    const id = asNonEmptyString(result.uuid)
    const score = asFiniteNumber(result.relevance) ?? asFiniteNumber(result.score)
    if (!id) {
      recordResultDrop(droppedResults, index, "missing-id")
      continue
    }
    if (threshold !== undefined && score !== undefined && score < threshold) {
      recordResultDrop(droppedResults, index, "below-threshold")
      continue
    }

    if (resultType === "edge") {
      const text = asNonEmptyString(result.fact)
      if (!text) {
        recordResultDrop(droppedResults, index, "empty-text")
        continue
      }
      normalized.push({
        id,
        text,
        ...(score !== undefined ? { score } : {}),
        provider: "zep",
        resultType: "graph-edge",
      })
      continue
    }

    if (resultType === "node") {
      const name = asNonEmptyString(result.name)
      const summary = asNonEmptyString(result.summary)
      const text = name && summary ? `${name}: ${summary}` : (summary ?? name)
      if (!text) {
        recordResultDrop(droppedResults, index, "empty-text")
        continue
      }
      normalized.push({
        id,
        text,
        ...(score !== undefined ? { score } : {}),
        provider: "zep",
        resultType: "graph-node",
      })
      continue
    }

    recordResultDrop(droppedResults, index, "unsupported-result-type")
  }

  normalized.sort(
    (a, b) => (b.score ?? Number.NEGATIVE_INFINITY) - (a.score ?? Number.NEGATIVE_INFINITY)
  )
  return rankResults(normalized)
}

function splitIntoChunks(text: string, maxSize: number): string[] {
  if (text.length <= maxSize) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= maxSize) {
      chunks.push(remaining)
      break
    }

    let splitIndex = remaining.lastIndexOf(". ", maxSize)
    if (splitIndex === -1 || splitIndex < maxSize * 0.5) {
      splitIndex = remaining.lastIndexOf("\n", maxSize)
    }
    if (splitIndex === -1 || splitIndex < maxSize * 0.5) {
      splitIndex = remaining.lastIndexOf(" ", maxSize)
    }
    if (splitIndex === -1 || splitIndex < maxSize * 0.3) {
      splitIndex = maxSize
    }

    chunks.push(remaining.slice(0, splitIndex + 1).trim())
    remaining = remaining.slice(splitIndex + 1).trim()
  }

  return chunks
}

const ZEP_ENTITY_TYPES = {
  Person: {
    description: "A person entity representing individuals in conversations",
    fields: {},
  },
  Preference: {
    description:
      "User preferences, choices, opinions, or selections. High priority for classification.",
    fields: {},
  },
  Location: {
    description: "Physical or virtual places where activities occur",
    fields: {},
  },
  Event: {
    description: "Time-bound activities, occurrences, or experiences",
    fields: {},
  },
  Object: {
    description: "Physical items, tools, devices, or possessions",
    fields: {},
  },
  Topic: {
    description: "Subjects of conversation, interest, or knowledge domains",
    fields: {},
  },
  Organization: {
    description: "Companies, institutions, groups, or formal entities",
    fields: {},
  },
  Document: {
    description: "Information content in various forms like books, articles, reports",
    fields: {},
  },
}

export class ZepProvider implements Provider {
  name = "zep"
  adapterVersion = "2.1.0"
  searchRequestStructure = { kind: "split", budget: "shared-total" } as const
  prompts = ZEP_PROMPTS
  concurrency = {
    default: 10,
    indexing: 5,
  }
  private client: ZepClient | null = null
  private graphIds: Map<string, string> = new Map()
  private ontologySet: Set<string> = new Set()

  constructor(private readonly indexingTimeoutMs = 30 * 60 * 1000) {}

  getIngestionConfigFingerprint(_config: ProviderConfig): string {
    return stableSha256({
      schemaVersion: 1,
      provider: this.name,
      adapterVersion: this.adapterVersion,
      maxDataSize: MAX_DATA_SIZE,
      episodeType: "message",
      sourceDescription: "memorybench:<customId>:<chunk>/<count>",
      addOrder: "sequential",
      entityTypes: ZEP_ENTITY_TYPES,
      indexingTimeoutMs: this.indexingTimeoutMs,
    })
  }

  async initialize(config: ProviderConfig): Promise<void> {
    this.client = new ZepClient({ apiKey: config.apiKey })
    logger.info(`Initialized Zep provider`)
  }

  async ingest(
    documents: CanonicalIngestionDocument[],
    options: IngestOptions
  ): Promise<IngestResult> {
    if (!this.client) throw new Error("Provider not initialized")

    const graphId = `memorybench_${options.containerTag.replace(/[^a-zA-Z0-9_-]/g, "_")}`
    this.graphIds.set(options.containerTag, graphId)

    try {
      await this.client.graph.create({
        graphId,
        name: `MemoryBench ${options.containerTag}`,
        description: "Memory benchmark evaluation graph",
      })
      logger.debug(`Created graph: ${graphId}`)
    } catch {
      logger.debug(`Graph ${graphId} may already exist`)
    }

    if (!this.ontologySet.has(graphId)) {
      await this.client.graph.setOntology(ZEP_ENTITY_TYPES, {}, { graphIds: [graphId] })
      this.ontologySet.add(graphId)
      logger.debug(`Set ontology for graph: ${graphId}`)
    }

    const documentIds: string[] = []
    for (const document of documents) {
      const rawDate = document.metadata.documentDate
      const isoDate =
        rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? `${rawDate}T00:00:00Z` : rawDate
      const chunks = splitIntoChunks(document.content, MAX_DATA_SIZE)
      const sourceDescriptions = chunks.map(
        (_chunk, index) => `memorybench:${document.customId}:${index + 1}/${chunks.length}`
      )
      const recent = await this.client.graph.episode.getByGraphId(graphId, {
        lastn: Math.min(1000, Math.max(50, chunks.length * 2)),
      })
      const existingBySource = new Map(
        (recent.episodes ?? []).flatMap((episode) =>
          episode.sourceDescription && sourceDescriptions.includes(episode.sourceDescription)
            ? [[episode.sourceDescription, episode] as const]
            : []
        )
      )

      for (let index = 0; index < chunks.length; index++) {
        const sourceDescription = sourceDescriptions[index]!
        const existing = existingBySource.get(sourceDescription)
        if (existing) {
          documentIds.push(existing.uuid)
          continue
        }

        // Sequential adds preserve the exact chunk order; addBatch explicitly does not.
        const episode = await this.client.graph.add({
          graphId,
          type: "message",
          data: chunks[index]!,
          createdAt: isoDate,
          sourceDescription,
        })
        documentIds.push(episode.uuid)
      }
      logger.debug(`Ingested or reconciled session ${document.metadata.sessionId}`)
    }

    return { documentIds: [...new Set(documentIds)] }
  }

  async awaitIndexing(
    result: IngestResult,
    _containerTag: string,
    onProgress?: IndexingProgressCallback
  ): Promise<void> {
    if (!this.client) throw new Error("Provider not initialized")

    const taskIds = result.taskIds || []
    const episodeIds = result.documentIds || []
    if (taskIds.length === 0 && episodeIds.length === 0) {
      onProgress?.({ completedIds: [], failedIds: [], total: 0 })
      return
    }

    const total = taskIds.length + episodeIds.length
    const pendingTasks = new Set(taskIds)
    const pendingEpisodes = new Set(episodeIds)
    const completedIds: string[] = []
    const failedIds: string[] = []
    let backoffMs = 500
    const indexingStartedMs = Date.now()
    const indexingDeadlineMs = indexingStartedMs + this.indexingTimeoutMs

    onProgress?.({ completedIds: [], failedIds: [], total })

    while (pendingTasks.size > 0 || pendingEpisodes.size > 0) {
      const timeoutMessage = `Zep indexing timed out after ${this.indexingTimeoutMs}ms with ${pendingTasks.size + pendingEpisodes.size} items pending`
      if (Date.now() >= indexingDeadlineMs) throw new Error(timeoutMessage)

      const pendingTaskArray = Array.from(pendingTasks)
      const taskResults = await withDeadline(
        Promise.allSettled(pendingTaskArray.map((taskId) => this.client!.task.get(taskId))),
        indexingDeadlineMs,
        timeoutMessage
      )

      for (let i = 0; i < taskResults.length; i++) {
        const taskId = pendingTaskArray[i]
        const res = taskResults[i]

        if (res.status === "fulfilled") {
          const task = res.value
          if (task.status === "succeeded" || task.status === "completed") {
            pendingTasks.delete(taskId)
            completedIds.push(taskId)
          } else if (task.status === "failed") {
            pendingTasks.delete(taskId)
            failedIds.push(taskId)
          }
        }
      }

      const pendingEpisodeArray = Array.from(pendingEpisodes)
      const episodeResults = await withDeadline(
        Promise.allSettled(
          pendingEpisodeArray.map((episodeId) => this.client!.graph.episode.get(episodeId))
        ),
        indexingDeadlineMs,
        timeoutMessage
      )
      for (let index = 0; index < episodeResults.length; index++) {
        const episodeId = pendingEpisodeArray[index]!
        const response = episodeResults[index]!
        if (response.status === "fulfilled" && response.value.processed) {
          pendingEpisodes.delete(episodeId)
          completedIds.push(episodeId)
        }
      }

      onProgress?.({ completedIds: [...completedIds], failedIds: [...failedIds], total })

      if (pendingTasks.size > 0 || pendingEpisodes.size > 0) {
        const remainingMs = indexingDeadlineMs - Date.now()
        if (remainingMs <= 0) {
          throw new Error(
            `Zep indexing timed out after ${this.indexingTimeoutMs}ms with ${pendingTasks.size + pendingEpisodes.size} items pending`
          )
        }
        await new Promise((r) => setTimeout(r, Math.min(backoffMs, remainingMs)))
        backoffMs = Math.min(backoffMs * 1.5, 5000)
      }
    }

    if (failedIds.length > 0) {
      logger.warn(`${failedIds.length} indexing tasks failed`)
    }
  }

  async search(query: string, options: SearchOptions): Promise<ProviderSearchResponse> {
    if (!this.client) throw new Error("Provider not initialized")
    const limit = requireSearchLimit(options.limit, this.name)

    const graphId = this.graphIds.get(options.containerTag)
    if (!graphId) {
      logger.warn(`No graph found for ${options.containerTag}, trying direct lookup`)
      const directGraphId = `memorybench_${options.containerTag.replace(/[^a-zA-Z0-9_-]/g, "_")}`
      this.graphIds.set(options.containerTag, directGraphId)
    }

    const finalGraphId = this.graphIds.get(options.containerTag)!
    const { edgeLimit, nodeLimit } = allocateZepSearchBudget(limit)

    const [edgesResponse, nodesResponse] = await Promise.all([
      this.client.graph.search({
        graphId: finalGraphId,
        query,
        limit: edgeLimit,
        scope: "edges",
        reranker: "cross_encoder",
      }),
      nodeLimit > 0
        ? this.client.graph.search({
            graphId: finalGraphId,
            query,
            limit: nodeLimit,
            scope: "nodes",
            reranker: "cross_encoder",
          })
        : Promise.resolve({ nodes: [] }),
    ])

    const results: unknown[] = []

    if (edgesResponse.edges) {
      for (const edge of edgesResponse.edges) {
        results.push({ ...edge, _type: "edge" })
      }
    }

    if (nodesResponse.nodes) {
      for (const node of nodesResponse.nodes) {
        results.push({ ...node, _type: "node" })
      }
    }

    const droppedResults: ProviderResultDropDiagnostic[] = []
    return createProviderSearchResponse({
      results: normalizeZepSearchResults(results, limit, options.threshold, droppedResults),
      requestedLimit: limit,
      rawReturnedCount: results.length,
      droppedResults,
      providerRequests: [
        {
          operation: "graph.edges",
          limit: edgeLimit,
          parameters: {
            scope: "edges",
            reranker: "cross_encoder",
            ...(options.threshold !== undefined ? { threshold: options.threshold } : {}),
          },
        },
        ...(nodeLimit > 0
          ? [
              {
                operation: "graph.nodes",
                limit: nodeLimit,
                parameters: {
                  scope: "nodes",
                  reranker: "cross_encoder",
                  ...(options.threshold !== undefined ? { threshold: options.threshold } : {}),
                },
              },
            ]
          : []),
      ],
    })
  }

  async clear(containerTag: string): Promise<void> {
    if (!this.client) throw new Error("Provider not initialized")
    const graphId = this.graphIds.get(containerTag)
    if (graphId) {
      try {
        await this.client.graph.delete(graphId)
        this.graphIds.delete(containerTag)
        this.ontologySet.delete(graphId)
        logger.info(`Deleted graph: ${graphId}`)
      } catch (e) {
        logger.warn(`Failed to delete graph ${graphId}: ${e}`)
      }
    }
  }
}

export default ZepProvider
