/**
 * Model utilities for unified model selection across providers
 * Supports OpenAI, Anthropic, and Google Vertex AI
 */

import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { createVertex } from '@ai-sdk/google-vertex';

// Lazy-initialized Vertex client
let vertexClient: ReturnType<typeof createVertex> | null = null;

/**
 * Get or create Vertex AI client
 */
function getVertexClient() {
    if (!vertexClient) {
        if (!process.env.GOOGLE_VERTEX_PROJECT_ID) {
            throw new Error('GOOGLE_VERTEX_PROJECT_ID environment variable is required for Gemini models');
        }
        vertexClient = createVertex({
            project: process.env.GOOGLE_VERTEX_PROJECT_ID,
            location: process.env.GOOGLE_VERTEX_LOCATION || 'us-central1',
        });
    }
    return vertexClient;
}

/**
 * Detect the provider from a model name
 */
export function detectProvider(modelName: string): 'openai' | 'anthropic' | 'google' {
    const lowerName = modelName.toLowerCase();
    
    // Anthropic models
    if (lowerName.startsWith('claude')) {
        return 'anthropic';
    }
    
    // Google models
    if (lowerName.startsWith('gemini')) {
        return 'google';
    }
    
    // Default to OpenAI (gpt-*, o1*, etc.)
    return 'openai';
}

/**
 * Get a model instance for the AI SDK based on model name
 * Automatically detects the provider from the model name
 * 
 * @param modelName - Model name (e.g., 'gpt-4o', 'claude-3-5-sonnet-20241022', 'gemini-1.5-pro')
 * @returns Model instance for use with generateText()
 */
export function getModel(modelName: string) {
    const provider = detectProvider(modelName);
    
    switch (provider) {
        case 'anthropic':
            if (!process.env.ANTHROPIC_API_KEY) {
                throw new Error('ANTHROPIC_API_KEY environment variable is required for Claude models');
            }
            return anthropic(modelName);
            
        case 'google':
            const vertex = getVertexClient();
            return vertex(modelName);
            
        case 'openai':
        default:
            if (!process.env.OPENAI_API_KEY) {
                throw new Error('OPENAI_API_KEY environment variable is required for OpenAI models');
            }
            return openai(modelName);
    }
}

/**
 * Check if required environment variables are set for a model
 */
export function validateModelEnv(modelName: string): void {
    const provider = detectProvider(modelName);
    
    switch (provider) {
        case 'anthropic':
            if (!process.env.ANTHROPIC_API_KEY) {
                throw new Error('ANTHROPIC_API_KEY environment variable is required for Claude models');
            }
            break;
            
        case 'google':
            if (!process.env.GOOGLE_VERTEX_PROJECT_ID) {
                throw new Error('GOOGLE_VERTEX_PROJECT_ID environment variable is required for Gemini models');
            }
            break;
            
        case 'openai':
        default:
            if (!process.env.OPENAI_API_KEY) {
                throw new Error('OPENAI_API_KEY environment variable is required for OpenAI models');
            }
            break;
    }
}

/**
 * Get provider display name
 */
export function getProviderName(modelName: string): string {
    const provider = detectProvider(modelName);
    switch (provider) {
        case 'anthropic':
            return 'Anthropic';
        case 'google':
            return 'Google Vertex AI';
        case 'openai':
        default:
            return 'OpenAI';
    }
}

