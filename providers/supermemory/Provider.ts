/**
 * SuperMemory Provider
 * Implements the BaseProvider interface for SuperMemory API
 */

import { BaseProvider, type ProviderConfig, type IngestOptions, type SearchOptions, type SearchResult } from '../../core/providers/BaseProvider';

interface SuperMemoryConfig {
    apiKey: string;
    baseUrl: string;
}

export default class SuperMemoryProvider extends BaseProvider {
    private apiConfig: SuperMemoryConfig;

    constructor() {
        const config: ProviderConfig = {
            name: 'supermemory',
            requiresApiKey: true,
            apiKeyEnvVar: 'SUPERMEMORY_API_KEY',
            supportsMetadata: true,
            supportsChunking: true,
        };
        super(config);

        this.apiConfig = {
            apiKey: process.env.SUPERMEMORY_API_KEY || '',
            baseUrl: process.env.SUPERMEMORY_API_URL || 'https://api.supermemory.ai',
        };
    }

    public async initialize(): Promise<void> {
        // Validate API key is available
        if (!this.apiConfig.apiKey) {
            throw new Error('SUPERMEMORY_API_KEY environment variable is required');
        }
    }

    public async ingest(content: string, containerTag: string, options?: IngestOptions): Promise<void> {
        const response = await fetch(`${this.apiConfig.baseUrl}/v3/documents`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiConfig.apiKey}`,
            },
            body: JSON.stringify({
                content,
                containerTags: containerTag ? [containerTag] : [],
                metadata: options?.metadata || {},
            }),
        });

        if (!response.ok) {
            let errorDetails = `status: ${response.status}`;
            try {
                const errorBody = await response.text();
                if (errorBody) {
                    errorDetails += ` - ${errorBody.substring(0, 200)}`;
                }
            } catch (e) {
                // Ignore if we can't read the error body
            }
            throw new Error(`Failed to ingest content: ${errorDetails}`);
        }
    }

    public async search(query: string, containerTag: string, options?: SearchOptions): Promise<SearchResult[]> {
        const requestBody: any = {
            q: query,
            limit: options?.limit || 10,
            threshold: options?.threshold || 0.3,
            include: {
                chunks: true,
            },
        };

        if (containerTag) {
            requestBody.containerTag = containerTag;
        }

        const response = await fetch(`${this.apiConfig.baseUrl}/v4/search`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiConfig.apiKey}`,
            },
            body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
            throw new Error(`Search failed: HTTP ${response.status}`);
        }

        const searchResults = await response.json();

        // Transform to standard format
        return (searchResults.results || []).map((result: any) => ({
            id: result.id,
            content: result.memory || '',
            score: result.similarity || 0,
            metadata: result.metadata || {},
            chunks: result.chunks || [],
        }));
    }
}
