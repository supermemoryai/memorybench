import type { RAGBenchmarkItem } from "./RAG-template-benchmark/types";

export interface BenchmarkRegistry {
	"RAG-template-benchmark": RAGBenchmarkItem;
	// Future benchmarks can be added here
	// 'QA': QABenchmarkItem;
	// 'Summarization': SummarizationBenchmarkItem;
}

export type BenchmarkType = keyof BenchmarkRegistry;
export type BenchmarkData<T extends BenchmarkType> = BenchmarkRegistry[T];

// Export all benchmark types and data
export * from "./RAG-template-benchmark";
