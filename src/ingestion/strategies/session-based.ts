/**
 * Session-Based Ingestion Strategy
 *
 * Ingests data session-by-session with configurable modes:
 * - lazy: Only answer sessions (for dev testing)
 * - shared: Sample of sessions + answer sessions (for demo)
 * - full: All sessions (for production)
 *
 * Extracted from: benchmarks/LongMemEval/ingestion.ts
 *
 * @module src/ingestion/strategies/session-based
 * @see specs/006-benchmark-interface/data-driven-benchmark-design.md
 */

import type {
	IngestionContext,
	IngestionResult,
	IngestionStrategy,
	Message,
	SessionBasedConfig,
} from "../types";
import { formatConversation } from "../types";

/**
 * Default configuration for session-based ingestion
 */
const DEFAULT_CONFIG: Partial<SessionBasedConfig> = {
	mode: "full",
	sharedSampleSize: 10,
	contentFormatter: "conversation",
};

/**
 * Select a distributed sample of indices
 * Ensures even distribution across the array
 */
function selectDistributedSample(
	totalCount: number,
	sampleSize: number,
): number[] {
	if (sampleSize >= totalCount) {
		return Array.from({ length: totalCount }, (_, i) => i);
	}

	const step = totalCount / sampleSize;
	const indices: number[] = [];

	for (let i = 0; i < sampleSize; i++) {
		const index = Math.floor(i * step);
		if (!indices.includes(index)) {
			indices.push(index);
		}
	}

	return indices;
}

/**
 * Determine which session indices to ingest based on mode
 */
function getSessionIndicesToIngest(
	sessions: unknown[],
	sessionIds: string[] | undefined,
	answerSessionIds: string[] | undefined,
	mode: SessionBasedConfig["mode"],
	sharedSampleSize: number,
): number[] {
	const totalSessions = sessions.length;

	switch (mode) {
		case "lazy": {
			// Only ingest sessions that contain the answer
			if (!answerSessionIds || !sessionIds) {
				return [0]; // Default to first session if no answer info
			}

			const answerIndices: number[] = [];
			for (let idx = 0; idx < sessionIds.length; idx++) {
				const sessionId = sessionIds[idx];
				if (sessionId && answerSessionIds.includes(sessionId)) {
					answerIndices.push(idx);
				}
			}
			return answerIndices.length > 0 ? answerIndices : [0];
		}

		case "shared": {
			// Ingest a sample of sessions including answer sessions
			const answerIndices = new Set<number>();

			if (answerSessionIds && sessionIds) {
				for (let idx = 0; idx < sessionIds.length; idx++) {
					const sessionId = sessionIds[idx];
					if (sessionId && answerSessionIds.includes(sessionId)) {
						answerIndices.add(idx);
					}
				}
			}

			// Get distributed sample of remaining indices
			const remainingSampleSize = Math.max(sharedSampleSize - answerIndices.size, 5);
			const sampleIndices = selectDistributedSample(totalSessions, remainingSampleSize);

			// Combine answer indices with sample
			const combined = new Set([...answerIndices, ...sampleIndices]);
			return Array.from(combined).sort((a, b) => a - b);
		}

		case "full":
		default: {
			// Ingest all sessions
			return Array.from({ length: totalSessions }, (_, i) => i);
		}
	}
}

/**
 * Get convergence wait time from provider if available
 */
async function getConvergenceWaitMs(
	provider: IngestionContext["provider"],
): Promise<number> {
	if (provider.get_capabilities) {
		try {
			const capabilities = await provider.get_capabilities();
			return capabilities?.system_flags?.convergence_wait_ms ?? 0;
		} catch {
			return 0;
		}
	}
	return 0;
}

/**
 * Create a session-based ingestion strategy
 *
 * @param config - Configuration for session-based ingestion
 * @returns Ingestion strategy implementation
 *
 * @example
 * ```typescript
 * const strategy = createSessionBasedIngestion({
 *   sessionsField: "haystack_sessions",
 *   sessionIdsField: "haystack_session_ids",
 *   datesField: "haystack_dates",
 *   answerSessionIdsField: "answer_session_ids",
 *   mode: "full"
 * });
 *
 * const result = await strategy.ingest({
 *   provider,
 *   scope,
 *   input: {
 *     haystack_sessions: [[{role: "user", content: "..."}, ...]],
 *     haystack_session_ids: ["s1", "s2", ...],
 *     haystack_dates: ["2024-01-01", ...],
 *     answer_session_ids: ["s5"]
 *   }
 * });
 * ```
 */
export function createSessionBasedIngestion(
	config: SessionBasedConfig,
): IngestionStrategy {
	const mergedConfig = { ...DEFAULT_CONFIG, ...config };

	return {
		name: "session-based",

		async ingest(context: IngestionContext): Promise<IngestionResult> {
			const { provider, scope, input, metadata: extraMetadata } = context;
			const ingestedIds: string[] = [];
			const errors: string[] = [];

			// Get sessions from input
			const sessions = input[mergedConfig.sessionsField] as unknown[] | undefined;

			if (!sessions || !Array.isArray(sessions)) {
				return {
					ingestedIds: [],
					ingestedCount: 0,
					skippedCount: 0,
					totalCount: 0,
					errors: [`Sessions field '${mergedConfig.sessionsField}' not found or not an array`],
				};
			}

			// Get optional fields
			const sessionIds = mergedConfig.sessionIdsField
				? (input[mergedConfig.sessionIdsField] as string[] | undefined)
				: undefined;
			const dates = mergedConfig.datesField
				? (input[mergedConfig.datesField] as string[] | undefined)
				: undefined;
			const answerSessionIds = mergedConfig.answerSessionIdsField
				? (input[mergedConfig.answerSessionIdsField] as string[] | undefined)
				: undefined;

			const totalSessions = sessions.length;

			// Determine which sessions to ingest
			const indicesToIngest = getSessionIndicesToIngest(
				sessions,
				sessionIds,
				answerSessionIds,
				mergedConfig.mode,
				mergedConfig.sharedSampleSize ?? 10,
			);

			// Ingest selected sessions
			for (const idx of indicesToIngest) {
				const session = sessions[idx];
				const sessionId = sessionIds?.[idx];
				const sessionDate = dates?.[idx];

				if (!session) {
					continue;
				}

				// Format session content
				let content: string;
				if (mergedConfig.contentFormatter === "conversation") {
					const messages = session as Message[];
					content = formatConversation(messages, sessionId, sessionDate);
				} else {
					content = typeof session === "string" ? session : JSON.stringify(session);
				}

				try {
					const record = await provider.add_memory(scope, content, {
						...extraMetadata,
						_sessionId: sessionId,
						_sessionDate: sessionDate,
						_sessionIndex: idx,
					});
					ingestedIds.push(record.id);
				} catch (error) {
					errors.push(
						`Failed to ingest session ${sessionId ?? idx}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}

			// Respect provider convergence time if specified
			const convergenceWaitMs = await getConvergenceWaitMs(provider);
			if (convergenceWaitMs > 0) {
				await new Promise((resolve) => setTimeout(resolve, convergenceWaitMs));
			}

			return {
				ingestedIds,
				ingestedCount: ingestedIds.length,
				skippedCount: totalSessions - indicesToIngest.length,
				totalCount: totalSessions,
				errors: errors.length > 0 ? errors : undefined,
			};
		},
	};
}
