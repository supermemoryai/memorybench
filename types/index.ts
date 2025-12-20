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

// Benchmark types (006-benchmark-interface)
export type {
	BenchmarkMeta,
	BenchmarkCase,
	CaseMetadata,
	CaseResult,
	CaseStatus,
	ErrorInfo,
	Benchmark,
	LoadedBenchmarkEntry,
	BenchmarkWarningCode,
	BenchmarkLoadWarning,
	BenchmarkErrorCode,
	BenchmarkLoadError,
	BenchmarkRegistryResult,
} from "./benchmark";
export { isBenchmark } from "./benchmark";

// Benchmark manifest types (data-driven benchmarks)
export type {
	BenchmarkManifest,
	IngestionConfig,
	EvaluationConfig,
	QueryConfig,
	SimpleIngestionConfig,
	SessionBasedIngestionConfig,
	ExactMatchEvaluationConfig,
	LLMJudgeEvaluationConfig,
} from "./benchmark-manifest";
export {
	validateBenchmarkManifest,
	formatManifestErrors,
	BenchmarkManifestSchema,
	SUPPORTED_BENCHMARK_MANIFEST_VERSIONS,
} from "./benchmark-manifest";
