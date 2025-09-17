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
	is_question_embedding: boolean;
}

// Combined query result types
export interface ChunkWithEmbeddings extends Chunk {
	chunk_embedding?: number[];
	question_embedding?: number[];
}

// Weighted search result type
export interface WeightedSearchResult {
	id: number;
	content: string;
	chunk_distance: number;
	chunk_weight: number;
	question_distance: number;
	weighted_distance: number;
	similarity_score: number;
}