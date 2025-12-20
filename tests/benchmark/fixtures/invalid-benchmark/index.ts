/**
 * Invalid benchmark fixture for testing error handling
 * Missing the 'meta' property - should fail validation
 */

export default {
	// Missing meta property
	cases() {
		return [];
	},

	async run_case() {
		return {
			case_id: "test",
			status: "pass" as const,
			scores: {},
			duration_ms: 0,
		};
	},
};
