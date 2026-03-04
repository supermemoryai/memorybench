import { ZepClient, Zep } from "@getzep/zep-cloud"
import type {
  Provider,
  ProviderConfig,
  IngestOptions,
  IngestResult,
  SearchOptions,
  IndexingProgressCallback,
} from "../../types/provider"
import type { UnifiedSession } from "../../types/unified"
import { logger } from "../../utils/logger"
import { ZEP_PROMPTS } from "./prompts"

const MAX_DATA_SIZE = 9500

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
  prompts = ZEP_PROMPTS
  concurrency = {
    default: 10,
    indexing: 5,
  }
  private client: ZepClient | null = null
  private graphIds: Map<string, string> = new Map()
  private ontologySet: Set<string> = new Set()

  async initialize(config: ProviderConfig): Promise<void> {
    this.client = new ZepClient({ apiKey: config.apiKey })
    logger.info(`Initialized Zep provider`)
  }

  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
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
      try {
        await this.client.graph.setOntology(ZEP_ENTITY_TYPES, {}, { graphIds: [graphId] })
        this.ontologySet.add(graphId)
        logger.debug(`Set ontology for graph: ${graphId}`)
      } catch (e) {
        logger.debug(`Ontology may already be set: ${e}`)
      }
    }

    const episodes: Zep.EpisodeData[] = []

    for (const session of sessions) {
      const isoDate = session.metadata?.date as string | undefined

      for (const message of session.messages) {
        const speaker = message.speaker || message.role
        const messageData = `${speaker}: ${message.content}`

        if (messageData.length > MAX_DATA_SIZE) {
          const chunks = splitIntoChunks(messageData, MAX_DATA_SIZE)
          for (const chunk of chunks) {
            episodes.push({
              type: "message",
              data: chunk,
              createdAt: isoDate,
            })
          }
        } else {
          episodes.push({
            type: "message",
            data: messageData,
            createdAt: isoDate,
          })
        }
      }
      logger.debug(`Ingested session ${session.sessionId}`)
    }

    const taskIds: string[] = []

    const BATCH_SIZE = 20
    for (let i = 0; i < episodes.length; i += BATCH_SIZE) {
      const batch = episodes.slice(i, i + BATCH_SIZE)
      const result = await this.client.graph.addBatch({
        graphId,
        episodes: batch,
      })

      for (const episode of result) {
        if (episode.taskId) {
          taskIds.push(episode.taskId)
        }
      }
    }

    return { documentIds: [], taskIds: [...new Set(taskIds)] }
  }

  async awaitIndexing(
    result: IngestResult,
    _containerTag: string,
    onProgress?: IndexingProgressCallback
  ): Promise<void> {
    if (!this.client) throw new Error("Provider not initialized")

    const taskIds = result.taskIds || []
    if (taskIds.length === 0) {
      onProgress?.({ completedIds: [], failedIds: [], total: 0 })
      return
    }

    const total = taskIds.length
    const pending = new Set(taskIds)
    const completedIds: string[] = []
    const failedIds: string[] = []
    let backoffMs = 500

    onProgress?.({ completedIds: [], failedIds: [], total })

    while (pending.size > 0) {
      const pendingArray = Array.from(pending)
      const results = await Promise.allSettled(
        pendingArray.map((taskId) => this.client!.task.get(taskId))
      )

      for (let i = 0; i < results.length; i++) {
        const taskId = pendingArray[i]
        const res = results[i]

        if (res.status === "fulfilled") {
          const task = res.value
          if (task.status === "succeeded" || task.status === "completed") {
            pending.delete(taskId)
            completedIds.push(taskId)
          } else if (task.status === "failed") {
            pending.delete(taskId)
            failedIds.push(taskId)
          }
        }
      }

      onProgress?.({ completedIds: [...completedIds], failedIds: [...failedIds], total })

      if (pending.size > 0) {
        await new Promise((r) => setTimeout(r, backoffMs))
        backoffMs = Math.min(backoffMs * 1.5, 5000)
      }
    }

    if (failedIds.length > 0) {
      logger.warn(`${failedIds.length} indexing tasks failed`)
    }
  }

  async search(query: string, options: SearchOptions): Promise<unknown[]> {
    if (!this.client) throw new Error("Provider not initialized")

    const graphId = this.graphIds.get(options.containerTag)
    if (!graphId) {
      logger.warn(`No graph found for ${options.containerTag}, trying direct lookup`)
      const directGraphId = `memorybench_${options.containerTag.replace(/[^a-zA-Z0-9_-]/g, "_")}`
      this.graphIds.set(options.containerTag, directGraphId)
    }

    const finalGraphId = this.graphIds.get(options.containerTag)!
    const edgeLimit = options.limit || 20
    const nodeLimit = Math.min(edgeLimit, 10)

    const [edgesResponse, nodesResponse] = await Promise.all([
      this.client.graph.search({
        graphId: finalGraphId,
        query,
        limit: edgeLimit,
        scope: "edges",
        reranker: "cross_encoder",
      }),
      this.client.graph.search({
        graphId: finalGraphId,
        query,
        limit: nodeLimit,
        scope: "nodes",
        reranker: "cross_encoder",
      }),
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

    return results
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
