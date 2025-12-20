import type { BenchmarkRegistry, BenchmarkType } from "../../benchmarks";
import type { PreparedData, TemplateType } from "../_template";
import { processDocument } from "./src/add";
import { initDatabase } from "./src/db";
import { retrieve } from "./src/retrieve";

await initDatabase();

export default {
	name: "ContextualRetrieval",
	addContext: async (data: PreparedData) => {
		console.log(`Processing ContextualRetrieval context: ${data.context}`);
		console.log(`Metadata:`, data.metadata);

		// Process the context as a document using contextual retrieval
		await processDocument(data.context);
	},

	searchQuery: async (query: string) => {
		console.log(`Searching with ContextualRetrieval: ${query}`);
		const results = await retrieve(query);

		// Transform ChunkWithEmbedding[] to expected format with actual similarity scores
		return results.map((chunk) => ({
			id: chunk.id.toString(),
			context: chunk.content,
			score: chunk.similarity_score || 0,
		}));
	},

	prepareProvider: <T extends BenchmarkType>(
		benchmarkType: T,
		data: BenchmarkRegistry[T][],
	): PreparedData[] => {
		switch (benchmarkType) {
			case "RAG-template-benchmark": {
				const ragData = data as BenchmarkRegistry["RAG-template-benchmark"][];
				return ragData.map((item) => ({
					context: `Question: ${item.question}\n\nRelevant Documents:\n${item.documents.map((d) => `- ${d.title || "Document"}: ${d.content}`).join("\n")}`,
					metadata: {
						benchmarkId: item.id,
						expectedAnswer: item.expected_answer,
						category: item.metadata.category,
						difficulty: item.metadata.difficulty,
						documentCount: item.documents.length,
						sourceDataset: item.metadata.source_dataset,
					},
				}));
			}
			// Future benchmark types can be added here
			// case "LoCoMo": { ... }
			default:
				throw new Error(
					`RAG provider does not support benchmark type: ${benchmarkType}`,
				);
		}
	},
} satisfies TemplateType;
