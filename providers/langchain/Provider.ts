/**
 * LangChain Provider
 * Implements the BaseProvider interface using in-memory vector store with OpenAI embeddings
 */

import { BaseProvider, type ProviderConfig, type IngestOptions, type SearchOptions, type SearchResult } from '../../core/providers/BaseProvider';
import { OpenAIEmbeddings } from "@langchain/openai";

interface StoredDocument {
    content: string;
    metadata: Record<string, any>;
    embedding: number[];
}

export default class LangChainProvider extends BaseProvider {
    private stores: Map<string, StoredDocument[]> = new Map();
    private embeddings: OpenAIEmbeddings | null = null;

    constructor() {
        const config: ProviderConfig = {
            name: 'langchain',
            requiresApiKey: true,
            apiKeyEnvVar: 'OPENAI_API_KEY',
            supportsMetadata: true,
            supportsChunking: false,
        };
        super(config);
    }

    public async initialize(): Promise<void> {
        // Validate OpenAI API key is available
        if (!process.env.OPENAI_API_KEY) {
            throw new Error('OPENAI_API_KEY environment variable is required');
        }

        this.embeddings = new OpenAIEmbeddings({
            openAIApiKey: process.env.OPENAI_API_KEY,
        });
    }

    private getEmbeddings(): OpenAIEmbeddings {
        if (!this.embeddings) {
            this.embeddings = new OpenAIEmbeddings({
                openAIApiKey: process.env.OPENAI_API_KEY,
            });
        }
        return this.embeddings;
    }

    private cosineSimilarity(a: number[], b: number[]): number {
        const dotProduct = a.reduce((sum, val, i) => sum + val * b[i], 0);
        const magnitudeA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
        const magnitudeB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
        return dotProduct / (magnitudeA * magnitudeB);
    }

    public async ingest(content: string, containerTag: string, options?: IngestOptions): Promise<void> {
        if (!this.stores.has(containerTag)) {
            this.stores.set(containerTag, []);
        }

        const embeddingsClient = this.getEmbeddings();
        const embedding = await embeddingsClient.embedQuery(content);

        this.stores.get(containerTag)!.push({
            content,
            metadata: options?.metadata || {},
            embedding,
        });
    }

    public async search(query: string, containerTag: string, options?: SearchOptions): Promise<SearchResult[]> {
        const store = this.stores.get(containerTag) || [];

        if (store.length === 0) {
            return [];
        }

        const embeddingsClient = this.getEmbeddings();
        const queryEmbedding = await embeddingsClient.embedQuery(query);

        // Calculate similarity scores
        const results = store.map((doc, index) => ({
            id: `${containerTag}-${index}`,
            content: doc.content,
            score: this.cosineSimilarity(queryEmbedding, doc.embedding),
            metadata: doc.metadata,
        }));

        // Sort by score descending and take top k
        results.sort((a, b) => b.score - a.score);
        const limit = options?.limit || 10;
        return results.slice(0, limit);
    }

    public async cleanup(): Promise<void> {
        // Clear all stores on cleanup
        this.stores.clear();
    }

    public async deleteContainer(containerTag: string): Promise<void> {
        // Delete specific container
        this.stores.delete(containerTag);
    }
}
