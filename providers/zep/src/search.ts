/**
 * Search module for Zep
 * Handles searching memories in Zep
 */

import { config } from './config';

export interface SearchOptions {
    limit?: number;
    sessionId?: string;
    searchScope?: 'messages' | 'summary';
}

export interface SearchResult {
    id: string;
    content: string;
    score?: number;
    metadata?: Record<string, any>;
    sessionId?: string;
    createdAt?: string;
}

export async function searchMemories(
    query: string,
    sessionId?: string,
    options?: SearchOptions
): Promise<SearchResult[]> {
    const sessionIdToUse = sessionId || options?.sessionId || 'default-session';
    const limit = options?.limit || 10;
    const searchScope = options?.searchScope || 'messages';

    const response = await fetch(`${config.baseUrl}/api/v2/sessions/${sessionIdToUse}/search`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Api-Key ${config.apiKey}`,
        },
        body: JSON.stringify({
            text: query,
            search_scope: searchScope,
            search_type: 'similarity',
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
        throw new Error(`Failed to search Zep: ${response.status} ${response.statusText}\n${JSON.stringify(errorDetails, null, 2)}`);
    }

    const data = await response.json();
    
    // Handle both array response and wrapped response
    const results = Array.isArray(data) ? data : (data.results || []);

    return results.map((result: any) => ({
        id: result.message?.uuid || result.uuid || '',
        content: result.message?.content || result.content || '',
        score: result.score || result.dist,
        metadata: result.message?.metadata || result.metadata || {},
        sessionId: sessionIdToUse,
        createdAt: result.message?.created_at || result.created_at,
    }));
}
