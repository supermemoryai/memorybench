export interface RAGBenchmarkItem {
	id: string;
	question: string;
	expected_answer: string;
	documents: Array<{
		id: string;
		content: string;
		title?: string;
		source?: string;
	}>;
	metadata: {
		difficulty: string;
		category: string;
		source_dataset: string;
	};
}
