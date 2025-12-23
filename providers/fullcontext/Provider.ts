/**
 * FullContext Provider Implementation
 * Uses the new BaseProvider architecture
 */

import { BaseProvider, type ProviderConfig, type IngestOptions, type SearchOptions, type SearchResult } from '../../core/providers/BaseProvider';

interface StoredDocument {
    content: string;
    metadata: Record<string, any>;
    timestamp: string;
}

export default class FullContextProvider extends BaseProvider {
    private stores: Map<string, StoredDocument[]> = new Map();

    constructor() {
        const config: ProviderConfig = {
            name: 'fullcontext',
            requiresApiKey: false,
            supportsMetadata: true,
            supportsChunking: false,
        };
        super(config);
    }

    /**
     * Ingest content into the full context store
     */
    public async ingest(
        content: string,
        containerTag: string,
        options?: IngestOptions
    ): Promise<void> {
        if (!this.stores.has(containerTag)) {
            this.stores.set(containerTag, []);
        }

        this.stores.get(containerTag)!.push({
            content,
            metadata: options?.metadata || {},
            timestamp: new Date().toISOString(),
        });

        console.log(`Ingested to FullContext store: ${containerTag}`);
    }

    /**
     * Search returns ALL content (no retrieval, full context baseline)
     * Note: By default returns all documents. Use options.limit to cap results.
     */
    public async search(
        query: string,
        containerTag: string,
        options?: SearchOptions
    ): Promise<SearchResult[]> {
        const store = this.stores.get(containerTag) || [];

        // Return ALL documents with score 1.0 (perfect match since we're using full context)
        let results: SearchResult[] = store.map((doc, index) => ({
            id: `${containerTag}-${index}`,
            content: doc.content,
            score: 1.0,
            metadata: doc.metadata,
        }));

        // Apply limit if specified (useful for avoiding rate limits during evaluation)
        if (options?.limit && options.limit > 0) {
            results = results.slice(0, options.limit);
        }

        return results;
    }

    /**
     * Delete a container
     */
    public async deleteContainer(containerTag: string): Promise<void> {
        this.stores.delete(containerTag);
        console.log(`Deleted FullContext container: ${containerTag}`);
    }

    /**
     * Cleanup all stores
     */
    public async cleanup(): Promise<void> {
        this.stores.clear();
        console.log('FullContext provider cleaned up');
    }
}
