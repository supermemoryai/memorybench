/**
 * Tests for benchmark manifest schema validation
 *
 * @see types/benchmark-manifest.ts
 */

import { describe, expect, test } from "bun:test";
import {
	validateBenchmarkManifest,
	formatManifestErrors,
} from "../../types/benchmark-manifest";

describe("validateBenchmarkManifest", () => {
	test("validates a minimal valid manifest with simple ingestion", () => {
		const manifest = {
			manifest_version: "1",
			name: "TestBenchmark",
			version: "1.0.0",
			data_file: "data.jsonl",
			ingestion: {
				strategy: "simple",
				content_field: "content",
			},
			query: {
				question_field: "question",
				expected_answer_field: "answer",
			},
			evaluation: {
				protocol: "exact-match",
			},
			metrics: ["correctness"],
			required_capabilities: ["add_memory", "retrieve_memory"],
		};

		const result = validateBenchmarkManifest(manifest);

		expect(result.success).toBe(true);
		expect(result.data?.name).toBe("TestBenchmark");
	});

	test("validates a manifest with session-based ingestion", () => {
		const manifest = {
			manifest_version: "1",
			name: "LongMemEval",
			version: "1.0.0",
			description: "Long-term memory evaluation",
			source: "https://arxiv.org/abs/2410.10813",
			data_file: "data.jsonl",
			ingestion: {
				strategy: "session-based",
				sessions_field: "haystack_sessions",
				session_ids_field: "haystack_session_ids",
				dates_field: "haystack_dates",
				answer_session_ids_field: "answer_session_ids",
				mode: "full",
				content_formatter: "conversation",
			},
			query: {
				question_field: "question",
				expected_answer_field: "answer",
				retrieval_limit: 10,
			},
			evaluation: {
				protocol: "llm-as-judge",
				type_field: "question_type",
				type_instructions_file: "type_instructions.json",
			},
			metrics: ["correctness", "faithfulness", "retrieval_precision"],
			required_capabilities: ["add_memory", "retrieve_memory"],
		};

		const result = validateBenchmarkManifest(manifest);

		expect(result.success).toBe(true);
		expect(result.data?.ingestion.strategy).toBe("session-based");
		expect(result.data?.evaluation.protocol).toBe("llm-as-judge");
	});

	test("rejects invalid manifest version", () => {
		const manifest = {
			manifest_version: "2",
			name: "TestBenchmark",
			version: "1.0.0",
			data_file: "data.jsonl",
			ingestion: { strategy: "simple", content_field: "content" },
			query: { question_field: "q", expected_answer_field: "a" },
			evaluation: { protocol: "exact-match" },
			metrics: [],
			required_capabilities: [],
		};

		const result = validateBenchmarkManifest(manifest);

		expect(result.success).toBe(false);
		expect(result.errors).toBeDefined();
	});

	test("rejects invalid version format", () => {
		const manifest = {
			manifest_version: "1",
			name: "TestBenchmark",
			version: "v1.0", // Invalid format
			data_file: "data.jsonl",
			ingestion: { strategy: "simple", content_field: "content" },
			query: { question_field: "q", expected_answer_field: "a" },
			evaluation: { protocol: "exact-match" },
			metrics: [],
			required_capabilities: [],
		};

		const result = validateBenchmarkManifest(manifest);

		expect(result.success).toBe(false);
		expect(result.errors?.[0]?.path).toBe("version");
	});

	test("rejects missing required fields", () => {
		const manifest = {
			manifest_version: "1",
			name: "TestBenchmark",
			// Missing version, data_file, etc.
		};

		const result = validateBenchmarkManifest(manifest);

		expect(result.success).toBe(false);
		expect(result.errors).toBeDefined();
		expect(result.errors!.length).toBeGreaterThan(0);
	});

	test("rejects unknown ingestion strategy", () => {
		const manifest = {
			manifest_version: "1",
			name: "TestBenchmark",
			version: "1.0.0",
			data_file: "data.jsonl",
			ingestion: { strategy: "unknown-strategy", content_field: "content" },
			query: { question_field: "q", expected_answer_field: "a" },
			evaluation: { protocol: "exact-match" },
			metrics: [],
			required_capabilities: [],
		};

		const result = validateBenchmarkManifest(manifest);

		expect(result.success).toBe(false);
	});

	test("rejects unknown evaluation protocol", () => {
		const manifest = {
			manifest_version: "1",
			name: "TestBenchmark",
			version: "1.0.0",
			data_file: "data.jsonl",
			ingestion: { strategy: "simple", content_field: "content" },
			query: { question_field: "q", expected_answer_field: "a" },
			evaluation: { protocol: "unknown-protocol" },
			metrics: [],
			required_capabilities: [],
		};

		const result = validateBenchmarkManifest(manifest);

		expect(result.success).toBe(false);
	});

	test("applies default values", () => {
		const manifest = {
			manifest_version: "1",
			name: "TestBenchmark",
			version: "1.0.0",
			data_file: "data.jsonl",
			ingestion: {
				strategy: "session-based",
				sessions_field: "sessions",
				// mode should default to "full"
			},
			query: {
				question_field: "q",
				expected_answer_field: "a",
				// retrieval_limit should default to 10
			},
			evaluation: {
				protocol: "exact-match",
				// case_sensitive should default to false
			},
			metrics: [],
			required_capabilities: [],
		};

		const result = validateBenchmarkManifest(manifest);

		expect(result.success).toBe(true);
		if (result.data?.ingestion.strategy === "session-based") {
			expect(result.data.ingestion.mode).toBe("full");
		}
		expect(result.data?.query.retrieval_limit).toBe(10);
	});
});

describe("formatManifestErrors", () => {
	test("formats errors correctly", () => {
		const errors = [
			{ path: "version", message: "Invalid format" },
			{ path: "ingestion.strategy", message: "Unknown strategy" },
		];

		const formatted = formatManifestErrors(errors);

		expect(formatted).toContain("version: Invalid format");
		expect(formatted).toContain("ingestion.strategy: Unknown strategy");
	});

	test("handles empty errors array", () => {
		const formatted = formatManifestErrors([]);
		expect(formatted).toBe("");
	});
});
