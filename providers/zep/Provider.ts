/**
 * Zep Provider
 * Implements the BaseProvider interface for Zep long-term memory API
 * Docs: https://docs.getzep.com/
 * 
 * Zep uses a session-based model:
 * - Users contain sessions
 * - Sessions contain messages (memory)
 * - Graph search operates on user-level facts extracted from sessions
 */

import { BaseProvider, type ProviderConfig, type IngestOptions, type SearchOptions, type SearchResult } from '../../core/providers/BaseProvider';

interface ZepConfig {
    apiKey: string;
    baseUrl: string;
}

// Zep has a 4096 character limit for messages
const MAX_CHUNK_SIZE = 4000;

export default class ZepProvider extends BaseProvider {
    private apiConfig: ZepConfig;

    constructor() {
        const config: ProviderConfig = {
            name: 'zep',
            requiresApiKey: true,
            apiKeyEnvVar: 'ZEP_API_KEY',
            supportsMetadata: true,
            supportsChunking: true,
        };
        super(config);

        this.apiConfig = {
            apiKey: process.env.ZEP_API_KEY || '',
            baseUrl: process.env.ZEP_API_URL || 'https://api.getzep.com',
        };
    }

    public async initialize(): Promise<void> {
        if (!this.apiConfig.apiKey) {
            throw new Error('ZEP_API_KEY environment variable is required');
        }
    }

    public async ingest(content: string, containerTag: string, options?: IngestOptions): Promise<void> {
        // Use containerTag as userId for isolation, and create a session for it
        const userId = containerTag;
        const sessionId = `${containerTag}-session`;

        // Split content into chunks if it exceeds Zep's limit
        const chunks: string[] = [];

        if (content.length <= MAX_CHUNK_SIZE) {
            chunks.push(content);
        } else {
            for (let i = 0; i < content.length; i += MAX_CHUNK_SIZE) {
                chunks.push(content.substring(i, i + MAX_CHUNK_SIZE));
            }
        }

        // Ensure user and session exist
        await this.ensureUserExists(userId);
        await this.ensureSessionExists(sessionId, userId);

        // Ingest each chunk as messages to the session
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            
            // Create alternating user/assistant messages to help Zep extract facts
            const messages = [
                {
                    role_type: 'user',
                    content: chunk,
                    metadata: {
                        ...options?.metadata || {},
                        chunk_index: i,
                        total_chunks: chunks.length,
                    },
                }
            ];

            const response = await fetch(`${this.apiConfig.baseUrl}/api/v2/sessions/${sessionId}/memory`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Api-Key ${this.apiConfig.apiKey}`,
                },
                body: JSON.stringify({ messages }),
            });

            if (!response.ok) {
                const errorText = await response.text();
                let errorDetails;
                try {
                    errorDetails = JSON.parse(errorText);
                } catch {
                    errorDetails = errorText;
                }
                throw new Error(`Failed to ingest content to Zep: ${response.status} ${response.statusText}\n${JSON.stringify(errorDetails, null, 2)}`);
            }

            // Small delay between chunks to avoid rate limits
            if (chunks.length > 1 && i < chunks.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
    }

    public async search(query: string, containerTag: string, options?: SearchOptions): Promise<SearchResult[]> {
        const userId = containerTag;
        const sessionId = `${containerTag}-session`;
        const limit = options?.limit || 10;

        let results: SearchResult[] = [];

        // Try graph search first (searches across all user facts)
        try {
            const graphResponse = await fetch(`${this.apiConfig.baseUrl}/api/v2/graph/search`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Api-Key ${this.apiConfig.apiKey}`,
                },
                body: JSON.stringify({
                    user_id: userId,
                    query: query,
                    limit: limit,
                }),
            });

            if (graphResponse.ok) {
                const data = await graphResponse.json();
                
                // Handle graph search response (edges/facts)
                // Filter to only include edges that have actual fact content
                if (data.edges && data.edges.length > 0) {
                    for (const edge of data.edges) {
                        const content = edge.fact || '';
                        if (content && content.trim()) {
                            results.push({
                                id: edge.uuid || edge.id || '',
                                content: content,
                                score: edge.score || edge.weight || 0,
                                metadata: edge.metadata || {},
                            });
                        }
                    }
                }
            }
        } catch (err) {
            console.warn('Zep graph search failed:', err);
        }

        // If graph search returned no content, fall back to session memory
        if (results.length === 0) {
            try {
                const sessionResponse = await fetch(`${this.apiConfig.baseUrl}/api/v2/sessions/${sessionId}/memory`, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Api-Key ${this.apiConfig.apiKey}`,
                    },
                });

                if (sessionResponse.ok) {
                    const data = await sessionResponse.json();
                    
                    // Priority 1: Use context if available (Zep's pre-built relevant context)
                    if (data.context && typeof data.context === 'string' && data.context.trim()) {
                        results.push({
                            id: 'context',
                            content: data.context,
                            score: 1.0,
                            metadata: {},
                        });
                    }
                    
                    // Priority 2: Use extracted facts
                    if (results.length === 0 && data.facts && data.facts.length > 0) {
                        for (const fact of data.facts) {
                            // Facts can be strings or objects
                            const content = typeof fact === 'string' ? fact : (fact.content || fact.fact || '');
                            if (content && content.trim()) {
                                results.push({
                                    id: typeof fact === 'object' ? (fact.uuid || '') : '',
                                    content: content,
                                    score: 1.0,
                                    metadata: typeof fact === 'object' ? (fact.metadata || {}) : {},
                                });
                            }
                        }
                    }
                    
                    // Priority 3: Use raw messages (always available immediately after ingest)
                    if (results.length === 0 && data.messages && data.messages.length > 0) {
                        for (const msg of data.messages) {
                            const content = msg.content || '';
                            if (content && content.trim()) {
                                results.push({
                                    id: msg.uuid || '',
                                    content: content,
                                    score: 1.0,
                                    metadata: msg.metadata || {},
                                });
                            }
                        }
                    }
                    
                    // Priority 4: Use summary if available
                    if (results.length === 0 && data.summary) {
                        const summaryContent = typeof data.summary === 'string' ? data.summary : (data.summary.content || '');
                        if (summaryContent && summaryContent.trim()) {
                            results.push({
                                id: 'summary',
                                content: summaryContent,
                                score: 1.0,
                                metadata: {},
                            });
                        }
                    }
                }
            } catch (err) {
                console.warn('Zep session memory fetch failed:', err);
            }
        }

        return results.slice(0, limit);
    }

    public async cleanup(): Promise<void> {
        // Zep doesn't require cleanup
    }

    public async deleteContainer(containerTag: string): Promise<void> {
        const userId = containerTag;
        const sessionId = `${containerTag}-session`;
        
        try {
            // Delete session first
            await fetch(`${this.apiConfig.baseUrl}/api/v2/sessions/${sessionId}`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Api-Key ${this.apiConfig.apiKey}`,
                },
            });
            
            // Then delete user
            await fetch(`${this.apiConfig.baseUrl}/api/v2/users/${userId}`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Api-Key ${this.apiConfig.apiKey}`,
                },
            });
        } catch (error) {
            console.warn(`Error deleting Zep container: ${error}`);
        }
    }

    private async ensureUserExists(userId: string): Promise<void> {
        // Check if user exists
        const checkResponse = await fetch(`${this.apiConfig.baseUrl}/api/v2/users/${userId}`, {
            method: 'GET',
            headers: {
                'Authorization': `Api-Key ${this.apiConfig.apiKey}`,
            },
        });

        if (checkResponse.status === 404) {
            // Create user
            const createResponse = await fetch(`${this.apiConfig.baseUrl}/api/v2/users`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Api-Key ${this.apiConfig.apiKey}`,
                },
                body: JSON.stringify({
                    user_id: userId,
                    metadata: {
                        source: 'memorybench',
                    },
                }),
            });

            if (!createResponse.ok && createResponse.status !== 409) {
                const errorText = await createResponse.text();
                throw new Error(`Failed to create user in Zep: ${createResponse.status}\n${errorText}`);
            }
        }
    }

    private async ensureSessionExists(sessionId: string, userId: string): Promise<void> {
        // Check if session exists
        const checkResponse = await fetch(`${this.apiConfig.baseUrl}/api/v2/sessions/${sessionId}`, {
            method: 'GET',
            headers: {
                'Authorization': `Api-Key ${this.apiConfig.apiKey}`,
            },
        });

        if (checkResponse.status === 404) {
            // Create session
            const createResponse = await fetch(`${this.apiConfig.baseUrl}/api/v2/sessions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Api-Key ${this.apiConfig.apiKey}`,
                },
                body: JSON.stringify({
                    session_id: sessionId,
                    user_id: userId,
                    metadata: {
                        source: 'memorybench',
                    },
                }),
            });

            if (!createResponse.ok && createResponse.status !== 409) {
                const errorText = await createResponse.text();
                throw new Error(`Failed to create session in Zep: ${createResponse.status}\n${errorText}`);
            }
        }
    }
}
