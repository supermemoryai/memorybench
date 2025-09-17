import type { BenchmarkRegistry, BenchmarkType } from "../../benchmarks";
import type { PreparedData, TemplateType } from "../_template";
import { addDocument } from "./src/add";
import { initDatabase } from "./src/db";
import { retrieve } from "./src/retrieve";

await initDatabase();

export default {
	name: "AQRAG",
	addContext: async (data: PreparedData) => {
		console.log(`Processing AQRAG context: ${data.context}`);
		console.log(`Metadata:`, data.metadata);

		// Process the context as a document using AQRAG (with question generation)
		await addDocument(data.context);
	},

	searchQuery: async (query: string) => {
		console.log(`Searching with AQRAG (question-enhanced): ${query}`);
		const results = await retrieve(query);

		// Transform WeightedSearchResult[] to expected format with actual similarity scores
		return results.map((result) => ({
			id: result.id.toString(),
			context: result.content,
			score: result.similarity_score,
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
					context: `AQRAG Format:\nQuery: ${item.question}\n\nContext Sources:\n${item.documents.map((d, idx) => `[${idx + 1}] ${d.title || `Source ${idx + 1}`}:\n${d.content}`).join("\n\n")}`,
					metadata: {
						benchmarkId: item.id,
						query: item.question,
						expectedResponse: item.expected_answer,
						difficulty: item.metadata.difficulty,
						category: item.metadata.category,
						sources: item.documents.map((d) => ({
							id: d.id,
							title: d.title,
							source: d.source,
						})),
						aqragProcessed: true,
					},
				}));
			}

			default:
				throw new Error(
					`AQRAG provider does not support benchmark type: ${benchmarkType}`,
				);
		}
	},
} satisfies TemplateType;
