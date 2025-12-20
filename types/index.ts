/**
 * Central export point for all MemoryBench types.
 * (T048)
 */

// Core types (003-core-types)
export type {
	ScopeContext,
	MemoryRecord,
	RetrievalItem,
	ProviderCapabilities,
} from "./core";
export { isScopeContext } from "./core";

// Manifest types (004-provider-manifest)
export type { ProviderManifest, LoadedProvider } from "./manifest";
export type {
	ManifestValidationError,
	FieldError,
} from "./manifest";
export { SUPPORTED_MANIFEST_VERSIONS } from "./manifest";

// Provider contract types (005-provider-contract)
export type {
	BaseProvider,
	LoadedProviderEntry,
	ProviderLoadWarning,
	ProviderLoadError,
	ProviderRegistryResult,
} from "./provider";
export {
	UnsupportedOperationError,
	LegacyProviderAdapter,
	isBaseProvider,
	isLegacyTemplate,
	hasCapability,
} from "./provider";
