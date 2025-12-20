/**
 * Ingestion Strategies Module
 *
 * Provides reusable ingestion strategies for data-driven benchmarks.
 * Each strategy implements a specific ingestion pattern.
 *
 * @module src/ingestion
 * @see specs/006-benchmark-interface/data-driven-benchmark-design.md
 */

// Types
export type {
	AddDeleteVerifyConfig,
	IngestionContext,
	IngestionMode,
	IngestionResult,
	IngestionStrategy,
	IngestionStrategyFactory,
	Message,
	SessionBasedConfig,
	SimpleIngestionConfig,
} from "./types";

// Utility functions
export { formatConversation } from "./types";

// Strategies
export { createSimpleIngestion } from "./strategies/simple";
export { createSessionBasedIngestion } from "./strategies/session-based";

// Cleanup utilities
export {
	checkCleanupCapabilities,
	cleanupIngested,
	resetScope,
} from "./cleanup";
