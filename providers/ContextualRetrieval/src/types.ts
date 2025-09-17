// Database entity types
export interface Document {
	id: number;
	content: string;
}

export interface Chunk {
	id: number;
	document_id: number;
	content: string;
}

export interface Embedding {
	id: number;
	chunk_id: number;
	embedding: number[];
}

// Combined query result types
export interface ChunkWithEmbedding extends Chunk {
	embedding: number[];
	document_content?: string;
	similarity_score?: number;
}

// Function parameter types
export interface SimilarityResult extends ChunkWithEmbedding {
	similarity_score?: number;
}