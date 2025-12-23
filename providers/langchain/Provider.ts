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

// OpenAI embedding model limits
const MAX_EMBEDDING_TOKENS = 8000; // Leave some buffer from 8192
const CHARS_PER_TOKEN = 4; // Rough estimate
const MAX_CHUNK_CHARS = MAX_EMBEDDING_TOKENS * CHARS_PER_TOKEN;

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

    /**
     * Split content into chunks that fit within embedding model limits
     */
    private chunkContent(content: string): string[] {
        if (content.length <= MAX_CHUNK_CHARS) {
            return [content];
        }

        const chunks: string[] = [];
        
        // Try to split on paragraph boundaries first
        const paragraphs = content.split(/\n\n+/);
        let currentChunk = '';

        for (const paragraph of paragraphs) {
            if (paragraph.length > MAX_CHUNK_CHARS) {
                // Paragraph itself is too large, split by sentences
                if (currentChunk) {
                    chunks.push(currentChunk.trim());
                    currentChunk = '';
                }
                
                const sentences = paragraph.split(/(?<=[.!?])\s+/);
                for (const sentence of sentences) {
                    if (sentence.length > MAX_CHUNK_CHARS) {
                        // Sentence too large, hard split
                        if (currentChunk) {
                            chunks.push(currentChunk.trim());
                            currentChunk = '';
                        }
                        for (let i = 0; i < sentence.length; i += MAX_CHUNK_CHARS) {
                            chunks.push(sentence.slice(i, i + MAX_CHUNK_CHARS));
                        }
                    } else if (currentChunk.length + sentence.length + 1 > MAX_CHUNK_CHARS) {
                        chunks.push(currentChunk.trim());
                        currentChunk = sentence;
                    } else {
                        currentChunk += (currentChunk ? ' ' : '') + sentence;
                    }
                }
            } else if (currentChunk.length + paragraph.length + 2 > MAX_CHUNK_CHARS) {
                chunks.push(currentChunk.trim());
                currentChunk = paragraph;
            } else {
                currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
            }
        }

        if (currentChunk.trim()) {
            chunks.push(currentChunk.trim());
        }

        return chunks;
    }

    public async ingest(content: string, containerTag: string, options?: IngestOptions): Promise<void> {
        if (!this.stores.has(containerTag)) {
            this.stores.set(containerTag, []);
        }

        const embeddingsClient = this.getEmbeddings();
        const store = this.stores.get(containerTag)!;
        
        // Chunk content if too large for embedding model
        const chunks = this.chunkContent(content);
        
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            
            try {
                const embedding = await embeddingsClient.embedQuery(chunk);
                
                store.push({
                    content: chunk,
                    metadata: {
                        ...options?.metadata,
                        chunkIndex: chunks.length > 1 ? i : undefined,
                        totalChunks: chunks.length > 1 ? chunks.length : undefined,
                    },
                    embedding,
                });
                
                // Small delay between embeddings to avoid rate limits
                if (chunks.length > 1 && i < chunks.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
            } catch (error: any) {
                // If still too large, try splitting further
                if (error.message?.includes('maximum context length')) {
                    console.warn(`  ⚠ Chunk ${i + 1}/${chunks.length} still too large, splitting further...`);
                    const subChunks = this.chunkContent(chunk.slice(0, Math.floor(chunk.length / 2)));
                    const subChunks2 = this.chunkContent(chunk.slice(Math.floor(chunk.length / 2)));
                    
                    for (const subChunk of [...subChunks, ...subChunks2]) {
                        const subEmbedding = await embeddingsClient.embedQuery(subChunk);
                        store.push({
                            content: subChunk,
                            metadata: { ...options?.metadata, chunkIndex: i, isSubChunk: true },
                            embedding: subEmbedding,
                        });
                        await new Promise(resolve => setTimeout(resolve, 100));
                    }
                } else {
                    throw error;
                }
            }
        }
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
