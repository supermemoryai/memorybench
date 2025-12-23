/**
 * Evaluation metrics for QA benchmarks
 * Supports exact match and F1 score (non-LLM evaluation)
 */

/**
 * Normalize text for comparison
 * - Lowercase
 * - Remove punctuation
 * - Normalize whitespace
 */
export function normalizeText(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')  // Replace punctuation with space
        .replace(/\s+/g, ' ')       // Normalize whitespace
        .trim();
}

/**
 * Tokenize text into words
 */
export function tokenize(text: string): string[] {
    return normalizeText(text).split(' ').filter(t => t.length > 0);
}

/**
 * Exact match evaluation
 * Returns true if the prediction contains the ground truth (case-insensitive)
 * Handles both string and number answers
 */
export function exactMatch(prediction: string, groundTruth: string | number): boolean {
    const normalizedPrediction = normalizeText(String(prediction));
    const normalizedGroundTruth = normalizeText(String(groundTruth));
    
    // Check if ground truth is contained in prediction
    // This is more lenient than strict equality
    return normalizedPrediction.includes(normalizedGroundTruth);
}

/**
 * Strict exact match - prediction must equal ground truth exactly (after normalization)
 */
export function strictExactMatch(prediction: string, groundTruth: string | number): boolean {
    const normalizedPrediction = normalizeText(String(prediction));
    const normalizedGroundTruth = normalizeText(String(groundTruth));
    
    return normalizedPrediction === normalizedGroundTruth;
}

/**
 * Calculate F1 score between prediction and ground truth
 * Based on token overlap
 */
export function f1Score(prediction: string, groundTruth: string | number): number {
    const predTokens = new Set(tokenize(String(prediction)));
    const truthTokens = new Set(tokenize(String(groundTruth)));
    
    if (truthTokens.size === 0) {
        return predTokens.size === 0 ? 1.0 : 0.0;
    }
    
    if (predTokens.size === 0) {
        return 0.0;
    }
    
    // Calculate intersection
    const intersection = new Set([...predTokens].filter(t => truthTokens.has(t)));
    const intersectionSize = intersection.size;
    
    if (intersectionSize === 0) {
        return 0.0;
    }
    
    // Precision = correct predictions / total predictions
    const precision = intersectionSize / predTokens.size;
    
    // Recall = correct predictions / total ground truth tokens
    const recall = intersectionSize / truthTokens.size;
    
    // F1 = harmonic mean of precision and recall
    const f1 = (2 * precision * recall) / (precision + recall);
    
    return f1;
}

/**
 * Evaluate using the specified method
 */
export type EvalMethod = 'exact' | 'f1' | 'strict';

export interface MetricResult {
    correct: boolean;
    score: number;
    method: EvalMethod;
}

export function evaluate(
    prediction: string,
    groundTruth: string | number,
    method: EvalMethod = 'exact'
): MetricResult {
    switch (method) {
        case 'exact':
            const emCorrect = exactMatch(prediction, groundTruth);
            return { correct: emCorrect, score: emCorrect ? 1.0 : 0.0, method };
            
        case 'strict':
            const strictCorrect = strictExactMatch(prediction, groundTruth);
            return { correct: strictCorrect, score: strictCorrect ? 1.0 : 0.0, method };
            
        case 'f1':
            const f1 = f1Score(prediction, groundTruth);
            // Consider F1 > 0.5 as "correct" for binary metrics
            return { correct: f1 >= 0.5, score: f1, method };
            
        default:
            throw new Error(`Unknown evaluation method: ${method}`);
    }
}

