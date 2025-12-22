/**
 * Type definitions for NoLiMa benchmark
 */

export interface NeedleTest {
    input_args: string[];
}

export interface NeedleItem {
    id: string;
    reasoning_type: string;
    system_prompt: string;
    task_template: string;
    needle: string;
    questions: {
        onehop: string;
        twohop?: string;
    };
    character_set: string[];
    tests: Record<string, NeedleTest>;
}

export interface TestCase {
    needleId: string;
    testId: string;
    question: string;
    questionType: 'onehop' | 'twohop';
    needle: string;
    answer: string; // Expected answer (character name)
    haystack: string;
    contextLength: number; // in tokens
}

export interface SearchResult {
    testCaseId: string;
    needleId: string;
    testId: string;
    question: string;
    retrievedContext: string;
    retrievedNeedle: boolean; // Did retrieval include the needle?
    timestamp: string;
}

export interface EvaluationResult {
    testCaseId: string;
    needleId: string;
    testId: string;
    question: string;
    contextLength: number;
    expectedAnswer: string;
    generatedAnswer: string;
    correct: boolean;
    retrievedNeedle: boolean;
    explanation: string;
}

export interface PerformanceMetrics {
    contextLength: number;
    totalTests: number;
    correctAnswers: number;
    accuracy: number;
    retrievalRate: number; // % of times needle was retrieved
}

export interface NoLiMaReport {
    metadata: {
        runId: string;
        providerName: string;
        answeringModel: string;
        judgeModel: string;
        needleSetType: string;
        evaluatedAt: string;
    };
    summary: {
        totalTests: number;
        correctAnswers: number;
        overallAccuracy: number;
        baseScore: number; // Accuracy at shortest context (1K)
        effectiveLength: number | null; // Longest context maintaining 85% of base score
    };
    byContextLength: PerformanceMetrics[];
    evaluations: EvaluationResult[];
}
