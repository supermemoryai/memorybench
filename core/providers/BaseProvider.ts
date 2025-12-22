/**
 * Base Provider Interface and Abstract Class
 * All memory providers must implement this interface
 */

export interface ProviderConfig {
    name: string;
    requiresApiKey?: boolean;
    apiKeyEnvVar?: string;
    supportsMetadata?: boolean;
    supportsChunking?: boolean;
    maxContentLength?: number;
}

export interface IngestOptions {
    containerTag?: string;
    metadata?: Record<string, any>;
}

export interface SearchOptions {
    limit?: number;
    containerTag?: string;
    threshold?: number;
}

export interface SearchResult {
    id: string;
    content: string;
    score: number;
    metadata?: Record<string, any>;
}

/**
 * Abstract base class for all providers
 * Provides common functionality and enforces interface contract
 */
export abstract class BaseProvider {
    protected config: ProviderConfig;

    constructor(config: ProviderConfig) {
        this.config = config;
        this.validateConfig();
    }

    /**
     * Validate provider configuration
     */
    protected validateConfig(): void {
        if (!this.config.name) {
            throw new Error('Provider name is required');
        }

        if (this.config.requiresApiKey && this.config.apiKeyEnvVar) {
            const apiKey = process.env[this.config.apiKeyEnvVar];
            if (!apiKey) {
                throw new Error(`${this.config.apiKeyEnvVar} environment variable is required for ${this.config.name}`);
            }
        }
    }

    /**
     * Get provider name
     */
    public getName(): string {
        return this.config.name;
    }

    /**
     * Get provider configuration
     */
    public getConfig(): ProviderConfig {
        return { ...this.config };
    }

    /**
     * Initialize provider (optional)
     * Called once before any operations
     */
    public async initialize(): Promise<void> {
        // Default implementation - can be overridden
    }

    /**
     * Cleanup provider resources (optional)
     * Called when provider is no longer needed
     */
    public async cleanup(): Promise<void> {
        // Default implementation - can be overridden
    }

    /**
     * Ingest content into the provider
     * @param content - The content to ingest
     * @param containerTag - Container/namespace identifier
     * @param options - Additional ingest options
     */
    public abstract ingest(
        content: string,
        containerTag: string,
        options?: IngestOptions
    ): Promise<void>;

    /**
     * Search for content in the provider
     * @param query - The search query
     * @param containerTag - Container/namespace identifier
     * @param options - Search options (limit, threshold, etc.)
     */
    public abstract search(
        query: string,
        containerTag: string,
        options?: SearchOptions
    ): Promise<SearchResult[]>;

    /**
     * Prepare container for use (optional)
     * @param containerTag - Container identifier to prepare
     */
    public async prepareContainer(containerTag: string): Promise<void> {
        // Default implementation - can be overridden
        console.log(`Preparing container: ${containerTag} for provider: ${this.config.name}`);
    }

    /**
     * Delete a container and all its contents (optional)
     * @param containerTag - Container identifier to delete
     */
    public async deleteContainer(containerTag: string): Promise<void> {
        // Default implementation - can be overridden
        console.log(`Deleting container: ${containerTag} for provider: ${this.config.name}`);
    }
}
