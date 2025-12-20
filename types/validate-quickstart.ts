/**
 * Validation script for quickstart.md examples
 * Verifies all usage patterns compile and work correctly
 */

import type {
	MemoryRecord,
	ProviderCapabilities,
	RetrievalItem,
	ScopeContext,
} from "./core";
import { isMemoryRecord, isScopeContext, isValidScore } from "./core";

// Test 1: Creating a ScopeContext
const minimalScope: ScopeContext = {
	user_id: "user_123",
	run_id: "benchmark_run_001",
};

const fullScope: ScopeContext = {
	user_id: "user_123",
	run_id: "benchmark_run_001",
	session_id: "session_456",
	namespace: "production",
};

// Test 2: Working with MemoryRecords
const memory: MemoryRecord = {
	id: "mem_" + crypto.randomUUID(),
	context: "User prefers dark mode for all interfaces",
	metadata: {
		category: "preference",
		confidence: 0.95,
		source: "explicit_statement",
	},
	timestamp: Date.now(),
};

// Test JSON serialization
const json = JSON.stringify(memory);
const parsed: unknown = JSON.parse(json);
if (!isMemoryRecord(parsed)) {
	throw new Error("JSON deserialization failed type guard validation");
}
const restored: MemoryRecord = parsed;

// Test 3: Handling RetrievalItems
const results: RetrievalItem[] = [
	{
		record: {
			id: "mem_001",
			context: "User prefers dark mode",
			metadata: { category: "preference" },
			timestamp: 1702915200000,
		},
		score: 0.92,
		match_context: "Semantic match on 'theme preference'",
	},
	{
		record: {
			id: "mem_002",
			context: "User works late nights",
			metadata: { category: "behavior" },
			timestamp: 1702915100000,
		},
		score: 0.67,
	},
];

const confident = results.filter((r) => r.score > 0.8);

// Test 4: Declaring Provider Capabilities
const minimalProvider: ProviderCapabilities = {
	core_operations: {
		add_memory: true,
		retrieve_memory: true,
		delete_memory: true,
	},
	optional_operations: {},
	system_flags: {
		async_indexing: false,
	},
	intelligence_flags: {
		auto_extraction: false,
		graph_support: false,
	},
};

const advancedProvider: ProviderCapabilities = {
	core_operations: {
		add_memory: true,
		retrieve_memory: true,
		delete_memory: true,
	},
	optional_operations: {
		update_memory: true,
		list_memories: true,
		reset_scope: true,
		get_capabilities: true,
	},
	system_flags: {
		async_indexing: true,
		processing_latency: 100,
		convergence_wait_ms: 500,
	},
	intelligence_flags: {
		auto_extraction: true,
		graph_support: true,
		graph_type: "knowledge",
	},
};

// Test 5: Type Guards
if (isScopeContext(fullScope)) {
	console.log(`✓ Valid scope for user: ${fullScope.user_id}`);
}

if (isMemoryRecord(memory)) {
	console.log(`✓ Valid record: ${memory.id}`);
}

const score = 0.85;
if (isValidScore(score)) {
	console.log(`✓ Valid score: ${score}`);
}

console.log("\n✅ All quickstart.md examples validated successfully!");
