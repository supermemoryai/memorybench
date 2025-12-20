/**
 * Tests for session-based ingestion strategy
 *
 * @see src/ingestion/strategies/session-based.ts
 */

import { describe, expect, test } from "bun:test";
import { createSessionBasedIngestion } from "../../src/ingestion/strategies/session-based";
import type { IngestionContext, Message } from "../../src/ingestion/types";
import type { ScopeContext } from "../../types/core";
import type { BaseProvider, MemoryRecord } from "../../types/provider";

/**
 * Create a mock provider for testing
 */
function createMockProvider(): BaseProvider & { addedRecords: MemoryRecord[] } {
	const addedRecords: MemoryRecord[] = [];
	let idCounter = 0;

	return {
		name: "mock-provider",
		addedRecords,

		async add_memory(
			_scope: ScopeContext,
			content: string,
			metadata?: Record<string, unknown>,
		): Promise<MemoryRecord> {
			const record: MemoryRecord = {
				id: `record_${++idCounter}`,
				context: content,
				timestamp: Date.now(),
				metadata,
			};
			addedRecords.push(record);
			return record;
		},

		async retrieve_memory() {
			return [];
		},

		async delete_memory() {
			return true;
		},
	};
}

/**
 * Create mock sessions for testing
 */
function createMockSessions(count: number): Message[][] {
	return Array.from({ length: count }, (_, i) => [
		{ role: "user" as const, content: `Question ${i + 1}` },
		{ role: "assistant" as const, content: `Answer ${i + 1}` },
	]);
}

describe("createSessionBasedIngestion", () => {
	test("returns ingestion strategy with correct name", () => {
		const strategy = createSessionBasedIngestion({
			sessionsField: "sessions",
		});
		expect(strategy.name).toBe("session-based");
	});

	test("ingests all sessions in full mode", async () => {
		const strategy = createSessionBasedIngestion({
			sessionsField: "sessions",
			mode: "full",
		});
		const provider = createMockProvider();
		const scope: ScopeContext = { user_id: "test", run_id: "run1" };

		const context: IngestionContext = {
			provider,
			scope,
			input: { sessions: createMockSessions(5) },
		};

		const result = await strategy.ingest(context);

		expect(result.ingestedCount).toBe(5);
		expect(result.totalCount).toBe(5);
		expect(result.skippedCount).toBe(0);
	});

	test("ingests only answer sessions in lazy mode", async () => {
		const strategy = createSessionBasedIngestion({
			sessionsField: "sessions",
			sessionIdsField: "session_ids",
			answerSessionIdsField: "answer_ids",
			mode: "lazy",
		});
		const provider = createMockProvider();
		const scope: ScopeContext = { user_id: "test", run_id: "run1" };

		const context: IngestionContext = {
			provider,
			scope,
			input: {
				sessions: createMockSessions(10),
				session_ids: ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10"],
				answer_ids: ["s3", "s7"], // Only these should be ingested
			},
		};

		const result = await strategy.ingest(context);

		expect(result.ingestedCount).toBe(2);
		expect(result.skippedCount).toBe(8);
	});

	test("ingests sample + answer sessions in shared mode", async () => {
		const strategy = createSessionBasedIngestion({
			sessionsField: "sessions",
			sessionIdsField: "session_ids",
			answerSessionIdsField: "answer_ids",
			mode: "shared",
			sharedSampleSize: 5,
		});
		const provider = createMockProvider();
		const scope: ScopeContext = { user_id: "test", run_id: "run1" };

		const context: IngestionContext = {
			provider,
			scope,
			input: {
				sessions: createMockSessions(20),
				session_ids: Array.from({ length: 20 }, (_, i) => `s${i + 1}`),
				answer_ids: ["s15"], // Answer session
			},
		};

		const result = await strategy.ingest(context);

		// Should ingest at least the answer session + sample
		expect(result.ingestedCount).toBeGreaterThanOrEqual(5);
		expect(result.ingestedCount).toBeLessThanOrEqual(10);
	});

	test("formats sessions as conversations", async () => {
		const strategy = createSessionBasedIngestion({
			sessionsField: "sessions",
			sessionIdsField: "session_ids",
			datesField: "dates",
			contentFormatter: "conversation",
			mode: "full",
		});
		const provider = createMockProvider();
		const scope: ScopeContext = { user_id: "test", run_id: "run1" };

		const context: IngestionContext = {
			provider,
			scope,
			input: {
				sessions: [[
					{ role: "user", content: "Hello" },
					{ role: "assistant", content: "Hi there" },
				]],
				session_ids: ["test_session"],
				dates: ["2024-01-01"],
			},
		};

		const result = await strategy.ingest(context);

		expect(result.ingestedCount).toBe(1);
		const content = provider.addedRecords[0]?.context;
		expect(content).toContain("=== Session: test_session ===");
		expect(content).toContain("Date: 2024-01-01");
		expect(content).toContain("[USER]: Hello");
		expect(content).toContain("[ASSISTANT]: Hi there");
	});

	test("includes session metadata", async () => {
		const strategy = createSessionBasedIngestion({
			sessionsField: "sessions",
			sessionIdsField: "session_ids",
			datesField: "dates",
			mode: "full",
		});
		const provider = createMockProvider();
		const scope: ScopeContext = { user_id: "test", run_id: "run1" };

		const context: IngestionContext = {
			provider,
			scope,
			input: {
				sessions: createMockSessions(1),
				session_ids: ["session_1"],
				dates: ["2024-01-01"],
			},
		};

		const result = await strategy.ingest(context);

		expect(result.ingestedCount).toBe(1);
		expect(provider.addedRecords[0]?.metadata?._sessionId).toBe("session_1");
		expect(provider.addedRecords[0]?.metadata?._sessionDate).toBe("2024-01-01");
		expect(provider.addedRecords[0]?.metadata?._sessionIndex).toBe(0);
	});

	test("returns error when sessions field not found", async () => {
		const strategy = createSessionBasedIngestion({
			sessionsField: "missing",
		});
		const provider = createMockProvider();
		const scope: ScopeContext = { user_id: "test", run_id: "run1" };

		const context: IngestionContext = {
			provider,
			scope,
			input: { sessions: createMockSessions(3) },
		};

		const result = await strategy.ingest(context);

		expect(result.ingestedCount).toBe(0);
		expect(result.errors).toBeDefined();
		expect(result.errors?.[0]).toContain("missing");
	});

	test("defaults to first session in lazy mode when no answer info", async () => {
		const strategy = createSessionBasedIngestion({
			sessionsField: "sessions",
			mode: "lazy",
		});
		const provider = createMockProvider();
		const scope: ScopeContext = { user_id: "test", run_id: "run1" };

		const context: IngestionContext = {
			provider,
			scope,
			input: { sessions: createMockSessions(5) },
		};

		const result = await strategy.ingest(context);

		// Should default to first session
		expect(result.ingestedCount).toBe(1);
	});

	test("handles empty sessions array", async () => {
		const strategy = createSessionBasedIngestion({
			sessionsField: "sessions",
			mode: "full",
		});
		const provider = createMockProvider();
		const scope: ScopeContext = { user_id: "test", run_id: "run1" };

		const context: IngestionContext = {
			provider,
			scope,
			input: { sessions: [] },
		};

		const result = await strategy.ingest(context);

		expect(result.ingestedCount).toBe(0);
		expect(result.totalCount).toBe(0);
	});
});
