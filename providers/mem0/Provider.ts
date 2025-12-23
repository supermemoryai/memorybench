/**
 * Mem0 Provider
 * Implements the BaseProvider interface for Mem0 API
 */

import { BaseProvider, type ProviderConfig, type IngestOptions, type SearchOptions, type SearchResult } from '../../core/providers/BaseProvider';

interface Mem0Config {
    apiKey: string;
    baseUrl: string;
}

export default class Mem0Provider extends BaseProvider {
    private apiConfig: Mem0Config;

    constructor() {
        const config: ProviderConfig = {
            name: 'mem0',
            requiresApiKey: true,
            apiKeyEnvVar: 'MEM0_API_KEY',
            supportsMetadata: true,
            supportsChunking: false,
        };
        super(config);

        this.apiConfig = {
            apiKey: process.env.MEM0_API_KEY || '',
            baseUrl: process.env.MEM0_API_URL || 'https://api.mem0.ai/v1',
        };
    }

    public async initialize(): Promise<void> {
        // Validate API key is available
        if (!this.apiConfig.apiKey) {
            throw new Error('MEM0_API_KEY environment variable is required');
        }
    }

    public async ingest(content: string, containerTag: string, options?: IngestOptions): Promise<void> {
        const response = await fetch(`${this.apiConfig.baseUrl}/memories/`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Token ${this.apiConfig.apiKey}`,
            },
            body: JSON.stringify({
                messages: [
                    {
                        role: 'user',
                        content: content
                    }
                ],
                user_id: containerTag,
                metadata: options?.metadata || {},
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            let errorDetails;
            try {
                errorDetails = JSON.parse(errorText);
            } catch {
                errorDetails = errorText;
            }
            throw new Error(`Failed to ingest content to Mem0: ${response.status} ${response.statusText}\n${JSON.stringify(errorDetails, null, 2)}`);
        }
    }

    public async search(query: string, containerTag: string, options?: SearchOptions): Promise<SearchResult[]> {
        const limit = options?.limit || 10;

        const response = await fetch(`${this.apiConfig.baseUrl}/memories/search/`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Token ${this.apiConfig.apiKey}`,
            },
            body: JSON.stringify({
                query: query,
                user_id: containerTag,
                limit: limit,
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            let errorDetails;
            try {
                errorDetails = JSON.parse(errorText);
            } catch {
                errorDetails = errorText;
            }
            throw new Error(`Failed to search Mem0: ${response.status} ${response.statusText}\n${JSON.stringify(errorDetails, null, 2)}`);
        }

        const data = await response.json();
        
        // Mem0 API returns array directly, or wrapped in results/memories
        const results = Array.isArray(data) ? data : (data.results || data.memories || []);

        return results.map((result: any) => ({
            id: result.id || result.memory_id || '',
            content: result.memory || result.text || result.content || '',
            score: result.score || result.relevance || 0,
            metadata: result.metadata || {},
        }));
    }
}
