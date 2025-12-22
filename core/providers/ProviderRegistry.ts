/**
 * Provider Registry - Singleton pattern
 * Manages all available providers and provides factory methods
 */

import { BaseProvider } from './BaseProvider';

type ProviderConstructor = new (...args: any[]) => BaseProvider;

export class ProviderRegistry {
    private static instance: ProviderRegistry;
    private providers: Map<string, ProviderConstructor> = new Map();
    private providerInstances: Map<string, BaseProvider> = new Map();

    private constructor() {
        // Private constructor for singleton
    }

    /**
     * Get singleton instance
     */
    public static getInstance(): ProviderRegistry {
        if (!ProviderRegistry.instance) {
            ProviderRegistry.instance = new ProviderRegistry();
        }
        return ProviderRegistry.instance;
    }

    /**
     * Register a provider class
     * @param name - Provider name (lowercase, e.g., 'supermemory', 'mem0')
     * @param providerClass - Provider class constructor
     */
    public register(name: string, providerClass: ProviderConstructor): void {
        const normalizedName = name.toLowerCase();
        if (this.providers.has(normalizedName)) {
            console.warn(`Provider '${normalizedName}' is already registered. Overwriting...`);
        }
        this.providers.set(normalizedName, providerClass);
    }

    /**
     * Get a provider instance (creates new instance or returns cached)
     * @param name - Provider name
     * @param createNew - Force creation of new instance
     */
    public async getProvider(name: string, createNew: boolean = false): Promise<BaseProvider> {
        const normalizedName = name.toLowerCase();

        // Return cached instance if exists and not forcing new
        if (!createNew && this.providerInstances.has(normalizedName)) {
            return this.providerInstances.get(normalizedName)!;
        }

        // Get provider class
        const ProviderClass = this.providers.get(normalizedName);
        if (!ProviderClass) {
            throw new Error(
                `Provider '${normalizedName}' not found. Available providers: ${this.getAvailableProviders().join(', ')}`
            );
        }

        // Create instance
        const provider = new ProviderClass();
        await provider.initialize();

        // Cache instance
        if (!createNew) {
            this.providerInstances.set(normalizedName, provider);
        }

        return provider;
    }

    /**
     * Check if a provider is registered
     */
    public hasProvider(name: string): boolean {
        return this.providers.has(name.toLowerCase());
    }

    /**
     * Get list of all available provider names
     */
    public getAvailableProviders(): string[] {
        return Array.from(this.providers.keys());
    }

    /**
     * Clear cached provider instances
     */
    public async clearCache(): Promise<void> {
        // Cleanup all cached instances
        for (const provider of this.providerInstances.values()) {
            await provider.cleanup();
        }
        this.providerInstances.clear();
    }

    /**
     * Remove a provider from registry
     */
    public unregister(name: string): void {
        const normalizedName = name.toLowerCase();
        this.providers.delete(normalizedName);
        this.providerInstances.delete(normalizedName);
    }
}

/**
 * Convenience function to get registry instance
 */
export function getProviderRegistry(): ProviderRegistry {
    return ProviderRegistry.getInstance();
}
