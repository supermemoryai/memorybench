import { google } from "@ai-sdk/google";
import { embedMany } from "ai";
import { EMBEDDING_DIMENSION } from "./config";

/**
 * Generate embedding using Gemini Embedding 001
 * @param inputs - String or array of strings to embed
 * @returns Array of embedding vectors
 */
export async function generateEmbeddings(
	inputs: string | string[],
): Promise<number[][]> {
	try {
		if (typeof inputs === "string") {
			inputs = [inputs];
		}

		const { embeddings } = await embedMany({
			model: google.textEmbeddingModel("gemini-embedding-001"),
			values: inputs,
			providerOptions: {
				google: {
					outputDimensionality: EMBEDDING_DIMENSION,
					taskType: "SEMANTIC_SIMILARITY",
				},
			},
		});

		return embeddings;
	} catch (error) {
		console.error(error);
		throw new Error("Failed to generate embeddings");
	}
}
