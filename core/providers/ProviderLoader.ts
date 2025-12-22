/**
 * Provider Loader
 * Automatically discovers and registers all providers
 */

import { readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { getProviderRegistry } from './ProviderRegistry';

export class ProviderLoader {
    private static loaded = false;

    /**
     * Auto-discover and load all providers from the providers directory
     */
    public static async loadAll(): Promise<void> {
        if (this.loaded) {
            return;
        }

        const providersDir = join(process.cwd(), 'providers');
        if (!existsSync(providersDir)) {
            throw new Error(`Providers directory not found: ${providersDir}`);
        }

        const registry = getProviderRegistry();
        const providerDirs = readdirSync(providersDir, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .filter(dirent => !dirent.name.startsWith('_')) // Ignore template and private dirs
            .map(dirent => dirent.name);

        console.log(`Discovering providers in: ${providersDir}`);
        console.log(`Found ${providerDirs.length} provider directories`);

        for (const providerName of providerDirs) {
            try {
                await this.loadProvider(providerName);
            } catch (error) {
                console.error(`Failed to load provider '${providerName}':`, error);
            }
        }

        this.loaded = true;
        console.log(`Loaded ${registry.getAvailableProviders().length} providers successfully`);
    }

    /**
     * Load a specific provider by name
     */
    private static async loadProvider(providerName: string): Promise<void> {
        const providerPath = join(process.cwd(), 'providers', providerName);
        const indexPath = join(providerPath, 'Provider.ts');

        // Check if Provider.ts exists (new pattern)
        if (existsSync(indexPath)) {
            const module = await import(indexPath);
            const ProviderClass = module.default || module[`${this.capitalize(providerName)}Provider`];

            if (ProviderClass) {
                const registry = getProviderRegistry();
                registry.register(providerName, ProviderClass);
                console.log(`  ✓ Registered provider: ${providerName}`);
            } else {
                console.warn(`  ✗ Provider class not found in ${providerName}/Provider.ts`);
            }
        } else {
            console.warn(`  ⚠ Provider.ts not found for ${providerName} (skipping)`);
        }
    }

    /**
     * Reload all providers (clears cache and reloads)
     */
    public static async reload(): Promise<void> {
        const registry = getProviderRegistry();
        await registry.clearCache();
        this.loaded = false;
        await this.loadAll();
    }

    /**
     * Capitalize first letter
     */
    private static capitalize(str: string): string {
        return str.charAt(0).toUpperCase() + str.slice(1);
    }
}

/**
 * Convenience function to ensure providers are loaded
 */
export async function ensureProvidersLoaded(): Promise<void> {
    await ProviderLoader.loadAll();
}
