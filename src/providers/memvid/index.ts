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
import { open, create } from "@memvid/sdk"
import type { Memvid } from "@memvid/sdk"
import { MEMVID_PROMPTS } from "./prompts"
import path from "path"
import fs from "fs"

export class MemvidProvider implements Provider {
    name = "memvid"
    prompts = MEMVID_PROMPTS
    private client: Memvid | null = null
    private filePath: string = "memorybench.mv2"

    async initialize(config: ProviderConfig): Promise<void> {
        if (config.filePath) {
            this.filePath = config.filePath as string
        } else if (process.env.MEMVID_FILE_PATH) {
            this.filePath = process.env.MEMVID_FILE_PATH
        }

        const dir = path.dirname(this.filePath)
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true })
        }

        try {
            if (fs.existsSync(this.filePath)) {
                this.client = await open(this.filePath)
                logger.info(`Initialized Memvid provider (opened) at ${this.filePath}`)
            } else {
                this.client = await create(this.filePath)
                logger.info(`Initialized Memvid provider (created) at ${this.filePath}`)
            }
        } catch (e) {
            logger.error(`Failed to initialize Memvid: ${e}`)
            throw e
        }
    }

    async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
        if (!this.client) throw new Error("Provider not initialized")

        const documentIds: string[] = []

        for (const session of sessions) {
            const content = session.messages
                .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
                .join("\n\n")

            const uri = `mv2://session/${session.sessionId}`

            try {
                const frameId = await this.client.put({
                    title: `Session ${session.sessionId}`,
                    text: content,
                    tags: [options.containerTag, ...(options.metadata?.tags as string[] || [])],
                    metadata: {
                        ...options.metadata,
                        containerTag: options.containerTag,
                        sessionId: session.sessionId,
                        uri: uri
                    }
                })

                documentIds.push(String(frameId))
            } catch (e) {
                logger.error(`Failed to ingest session ${session.sessionId}: ${e}`)
            }
        }

        return { documentIds }
    }

    async awaitIndexing(
        result: IngestResult,
        _containerTag: string,
        onProgress?: IndexingProgressCallback
    ): Promise<void> {
        onProgress?.({
            completedIds: result.documentIds,
            failedIds: [],
            total: result.documentIds.length
        })
    }

    async search(query: string, options: SearchOptions): Promise<unknown[]> {
        if (!this.client) throw new Error("Provider not initialized")

        try {
            const result = await this.client.find(query, {
                k: options.limit || 10,
                // mode: "auto" // default
                // scope?
            })
            return result.hits || []
        } catch (e) {
            logger.error(`Search failed: ${e}`)
            return []
        }
    }

    async clear(containerTag: string): Promise<void> {
        if (!this.client) return

        try {
            if (this.client.seal) {
                await this.client.seal()
            }
            this.client = null

            if (fs.existsSync(this.filePath)) {
                fs.unlinkSync(this.filePath)
                logger.info(`Deleted Memvid file at ${this.filePath}`)
            }

            this.client = await create(this.filePath)
            logger.info(`Re-initialized Memvid provider (created) at ${this.filePath}`)
        } catch (e) {
            logger.error(`Failed to clear Memvid: ${e}`)
            if (!this.client && fs.existsSync(this.filePath)) {
                this.client = await open(this.filePath)
            }
        }
    }
}
