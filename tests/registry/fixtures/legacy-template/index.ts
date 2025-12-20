import type { PreparedData } from "../../../../providers/_template";

/**
 * Legacy provider fixture using TemplateType interface.
 * This should be automatically wrapped by LegacyProviderAdapter.
 */
const legacyTemplate = {
	name: "legacy-template",

	addContext: async (data: PreparedData) => {
		// Legacy addContext returns void
		console.log("Adding context:", data.context);
	},

	searchQuery: async (query: string) => {
		// Legacy searchQuery returns array with different format
		return [
			{
				id: "test-id",
				context: `Result for: ${query}`,
				score: 0.95,
			},
		];
	},

	prepareProvider: <T extends string>(
		_benchmarkType: T,
		_data: unknown[],
	): PreparedData[] => {
		return [];
	},
};

export default legacyTemplate;
