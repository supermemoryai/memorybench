import { sql } from "bun";
import type { Chunk, ChunkWithEmbedding, Document } from "./types.ts";

// Initialize database by creating tables
export async function initDatabase() {
	try {
		// Read and execute schema
		const schemaFile = Bun.file("./schema.sql");
		const schema = await schemaFile.text();

		// Split by statements and execute each one
		const statements = schema
			.split(";")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);

		for (const statement of statements) {
			await sql.unsafe(statement);
		}

		console.log("Database initialized successfully");
	} catch (error) {
		console.error("Failed to initialize database:", error);
		throw error;
	}
}

// Document operations
export async function insertDocument(content: string): Promise<Document> {
	const [document] = await sql`
    INSERT INTO documents (content)
    VALUES (${content})
    RETURNING *
  `;
	return document;
}

export async function getDocument(id: number): Promise<Document | undefined> {
	const [document] = await sql`
    SELECT * FROM documents WHERE id = ${id}
  `;
	return document;
}

export async function getAllDocuments(): Promise<Document[]> {
	return await sql`
    SELECT * FROM documents ORDER BY id DESC
  `;
}

// Chunk operations
export async function insertChunk(
	documentId: number,
	content: string,
	embedding: number[],
): Promise<Chunk> {
	// First insert the chunk
	const [chunk] = await sql`
    INSERT INTO chunks (document_id, content)
    VALUES (${documentId}, ${content})
    RETURNING *
  `;

	// Then insert the embedding
	await sql`
    INSERT INTO embeddings (chunk_id, embedding)
    VALUES (${chunk.id}, ${JSON.stringify(embedding)}::vector)
  `;

	return chunk;
}

export async function getChunksByDocument(
	documentId: number,
): Promise<ChunkWithEmbedding[]> {
	return await sql`
    SELECT c.*, e.embedding
    FROM chunks c
    LEFT JOIN embeddings e ON c.id = e.chunk_id
    WHERE c.document_id = ${documentId}
    ORDER BY c.id
  `;
}

export async function getAllChunks(): Promise<ChunkWithEmbedding[]> {
	return await sql`
    SELECT c.*, e.embedding, d.content as document_content
    FROM chunks c
    LEFT JOIN embeddings e ON c.id = e.chunk_id
    LEFT JOIN documents d ON c.document_id = d.id
    ORDER BY c.id
  `;
}

export async function findSimilarChunks(
	embedding: number[],
	limit: number,
): Promise<ChunkWithEmbedding[]> {
	return await sql`
    SELECT c.*, e.embedding, d.content as document_content,
           (1 - (e.embedding <-> ${JSON.stringify(embedding)}::vector)) as similarity_score
    FROM chunks c
    JOIN embeddings e ON c.id = e.chunk_id
    JOIN documents d ON c.document_id = d.id
    ORDER BY e.embedding <-> ${JSON.stringify(embedding)}::vector
    LIMIT ${limit}
  `;
}

export { sql };
