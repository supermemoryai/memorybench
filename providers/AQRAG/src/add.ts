import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import { insertChunk, insertDocument } from "./db";
import type { Document } from "./types";
import {
	CHUNK_OVERLAP_IN_TOKENS,
	CHUNK_SIZE_IN_TOKENS,
	NUMBER_OF_QUESTIONS_PER_CHUNK,
} from "./utils/config";
import { generateEmbeddings } from "./utils/llm";
import { contextualRetrievalWithQuestionsPrompt } from "./utils/prompts";

const chunkText = (document: string) => {
	const chunks = [];
	let start = 0;
	let end = CHUNK_SIZE_IN_TOKENS;

	while (start < document.length) {
		const chunk = document.slice(start, end);
		chunks.push(chunk);
		start += CHUNK_SIZE_IN_TOKENS - CHUNK_OVERLAP_IN_TOKENS;
		end += CHUNK_SIZE_IN_TOKENS - CHUNK_OVERLAP_IN_TOKENS;
	}

	return chunks;
};

const processChunk = async (chunk: string, document: Document) => {
	const enhancedChunkPrompt = contextualRetrievalWithQuestionsPrompt(
		document.content,
		chunk,
		NUMBER_OF_QUESTIONS_PER_CHUNK,
	);

	const { object } = await generateObject({
		model: anthropic("claude-3-5-haiku"),
		prompt: enhancedChunkPrompt,
		schema: z.object({
			enhancedChunk: z.string(),
			anticipatedQuestions: z
				.array(z.string())
				.max(NUMBER_OF_QUESTIONS_PER_CHUNK),
		}),
	});

	const anticipatoryQuestionsEmbeddings = await generateEmbeddings([
		object.anticipatedQuestions.join(", "),
	]);
	const embedding = await generateEmbeddings(object.enhancedChunk);

	await insertChunk(
		document.id,
		object.enhancedChunk,
		embedding[0]!,
		anticipatoryQuestionsEmbeddings[0]!,
	);

	return object.enhancedChunk;
};

export const addDocument = async (document: string) => {
	const dbDoc = await insertDocument(document);

	const chunks = chunkText(document);

	const processedChunks = await Promise.all(
		chunks.map((chunk) => processChunk(chunk, dbDoc)),
	);

	return processedChunks;
};
