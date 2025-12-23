/**
 * Data Aggregation Module
 * Reads benchmark results from evaluation-summary.json files for visualization
 */

import { join } from 'path';
import { readdirSync, readFileSync, statSync, existsSync } from 'fs';

// ============================================================================
// Types
// ============================================================================

export interface NoLiMaContextLength {
    contextLength: string;
    correct: number;
    total: number;
    accuracy: number;
    retrievalRate: number;
}

export interface PerformanceStats {
    avgSearchTimeMs?: number;
    minSearchTimeMs?: number;
    maxSearchTimeMs?: number;
    totalSearches?: number;
}

export interface NoLiMaResult {
    runId: string;
    provider: string;
    answeringModel: string;
    judgeModel: string;
    timestamp: string;
    evaluatedAt: string;
    totalTests: number;
    correctAnswers: number;
    accuracy: number;
    retrievalRate: number;
    byContextLength: NoLiMaContextLength[];
    isFormal: boolean;
    performance?: PerformanceStats;
}

export interface LoCoMoCategory {
    category: number;
    categoryName: string;
    correct: number;
    total: number;
    accuracy: number;
}

export interface LoCoMoResult {
    runId: string;
    provider: string;
    answeringModel: string;
    evalMethod: string;
    judgeModel: string | null;
    timestamp: string;
    evaluatedAt: string;
    totalQuestions: number;
    correctAnswers: number;
    accuracy: number;
    byCategory: LoCoMoCategory[];
    isFormal: boolean;
    performance?: PerformanceStats;
}

export interface LongMemEvalQuestionType {
    questionType: string;
    correct: number;
    total: number;
    accuracy: number;
}

export interface LongMemEvalResult {
    runId: string;
    provider: string;
    answeringModel: string;
    judgeModel: string;
    timestamp: string;
    evaluatedAt: string;
    totalQuestions: number;
    correctAnswers: number;
    accuracy: number;
    byQuestionType: LongMemEvalQuestionType[];
    isFormal: boolean;
    performance?: PerformanceStats;
}

export interface AggregatedData {
    noLiMa: NoLiMaResult[];
    loCoMo: LoCoMoResult[];
    longMemEval: LongMemEvalResult[];
    providers: string[];
    benchmarks: string[];
}

// ============================================================================
// Constants
// ============================================================================

const RESULTS_DIR = join(process.cwd(), 'results');

// Provider display colors (matching supermemory.ai theme)
export const PROVIDER_COLORS: Record<string, string> = {
    supermemory: '#3B82F6', // Blue - Primary brand
    zep: '#F97316',         // Orange - Secondary
    mem0: '#FBBF24',        // Yellow/Amber
    fullcontext: '#8B5CF6', // Purple
    langchain: '#10B981',   // Green
    default: '#6B7280',     // Gray for unknown
};

// Question type labels for LongMemEval
export const LONGMEMEVAL_LABELS: Record<string, string> = {
    'single-session-user': 'Single-Session User',
    'single-session-assistant': 'Single-Session Assistant',
    'single-session-preference': 'Single-Session Preference',
    'knowledge-update': 'Knowledge Update',
    'temporal-reasoning': 'Temporal Reasoning',
    'multi-session': 'Multi-Session',
};

// Category labels for LoCoMo
export const LOCOMO_LABELS: Record<number, string> = {
    1: 'Single-hop Factual',
    2: 'Temporal Reasoning',
    3: 'Multi-hop Reasoning',
    4: 'Simple Factual',
    5: 'Adversarial',
};

// ============================================================================
// Helper Functions
// ============================================================================

function extractTimestamp(runId: string): string {
    const parts = runId.split('_');
    // Format: Benchmark_Provider_YYYYMMDD_HHMMSS[_formal]
    if (parts.length >= 4) {
        return `${parts[2]}_${parts[3].replace('_formal', '')}`;
    }
    return new Date().toISOString();
}

function parseAccuracy(value: string | number): number {
    if (typeof value === 'number') return value;
    return parseFloat(value.replace('%', '')) || 0;
}

/**
 * Extract performance stats from search results in a run directory
 */
function extractPerformanceStats(runDir: string): PerformanceStats | undefined {
    const searchDir = join(RESULTS_DIR, runDir, 'search');
    const checkpointsDir = join(RESULTS_DIR, runDir, 'checkpoints', 'search');
    
    const durations: number[] = [];
    
    // Try to read from search directory (LongMemEval style)
    if (existsSync(searchDir)) {
        try {
            const files = readdirSync(searchDir).filter(f => f.endsWith('.json'));
            for (const file of files) {
                try {
                    const data = JSON.parse(readFileSync(join(searchDir, file), 'utf-8'));
                    if (data.metadata?.searchDurationMs) {
                        durations.push(data.metadata.searchDurationMs);
                    }
                } catch {}
            }
        } catch {}
    }
    
    // Try to read from checkpoint files (NoLiMa/LoCoMo style)
    if (existsSync(checkpointsDir)) {
        try {
            const files = readdirSync(checkpointsDir).filter(f => f.endsWith('.json'));
            for (const file of files) {
                try {
                    const data = JSON.parse(readFileSync(join(checkpointsDir, file), 'utf-8'));
                    // NoLiMa checkpoint format
                    if (data.searchResults && Array.isArray(data.searchResults)) {
                        for (const result of data.searchResults) {
                            if (result.searchDurationMs) {
                                durations.push(result.searchDurationMs);
                            }
                        }
                    }
                    // LoCoMo checkpoint format
                    if (data.questionsSearched && Array.isArray(data.questionsSearched)) {
                        for (const result of data.questionsSearched) {
                            if (result.searchDurationMs) {
                                durations.push(result.searchDurationMs);
                            }
                        }
                    }
                } catch {}
            }
        } catch {}
    }
    
    if (durations.length === 0) return undefined;
    
    return {
        avgSearchTimeMs: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
        minSearchTimeMs: Math.min(...durations),
        maxSearchTimeMs: Math.max(...durations),
        totalSearches: durations.length,
    };
}

// ============================================================================
// Data Aggregation
// ============================================================================

function aggregateAllBenchmarks(): { 
    noLiMa: NoLiMaResult[], 
    loCoMo: LoCoMoResult[], 
    longMemEval: LongMemEvalResult[] 
} {
    const noLiMa: NoLiMaResult[] = [];
    const loCoMo: LoCoMoResult[] = [];
    const longMemEval: LongMemEvalResult[] = [];

    if (!existsSync(RESULTS_DIR)) {
        return { noLiMa, loCoMo, longMemEval };
    }

    const runDirs = readdirSync(RESULTS_DIR).filter(dir => {
        const fullPath = join(RESULTS_DIR, dir);
        return statSync(fullPath).isDirectory();
    });

    for (const runDir of runDirs) {
        const summaryPath = join(RESULTS_DIR, runDir, 'evaluation-summary.json');

        if (!existsSync(summaryPath)) continue;

        try {
            const data = JSON.parse(readFileSync(summaryPath, 'utf-8'));
            const benchmark = data.benchmark;
            const timestamp = extractTimestamp(data.metadata.runId);
            const isFormal = data.metadata.runId.includes('_formal');

            // Extract performance stats for all benchmarks
            const performance = extractPerformanceStats(runDir);

            if (benchmark === 'NoLiMa') {
                const byContextLength = (data.byContextLength || []).map((ctx: any) => ({
                    contextLength: ctx.contextLength,
                    correct: ctx.correct,
                    total: ctx.total,
                    accuracy: parseAccuracy(ctx.accuracy),
                    retrievalRate: parseAccuracy(ctx.retrievalRate || '0'),
                }));

                noLiMa.push({
                    runId: data.metadata.runId,
                    provider: data.metadata.provider,
                    answeringModel: data.metadata.answeringModel,
                    judgeModel: data.metadata.judgeModel,
                    timestamp,
                    evaluatedAt: data.metadata.evaluatedAt,
                    totalTests: data.metadata.totalTests,
                    correctAnswers: data.metadata.correctAnswers,
                    accuracy: parseAccuracy(data.metadata.accuracy),
                    retrievalRate: data.metrics?.retrievalRate || 0,
                    byContextLength,
                    isFormal,
                    performance,
                });
            } else if (benchmark === 'LoCoMo') {
                const byCategory = (data.byCategory || []).map((cat: any) => ({
                    category: cat.category,
                    categoryName: cat.categoryName || LOCOMO_LABELS[cat.category] || `Category ${cat.category}`,
                    correct: cat.correct,
                    total: cat.total,
                    accuracy: parseAccuracy(cat.accuracy),
                }));

                loCoMo.push({
                    runId: data.metadata.runId,
                    provider: data.metadata.provider,
                    answeringModel: data.metadata.answeringModel,
                    evalMethod: data.metadata.evalMethod || 'llm',
                    judgeModel: data.metadata.judgeModel,
                    timestamp,
                    evaluatedAt: data.metadata.evaluatedAt,
                    totalQuestions: data.metadata.totalQuestions,
                    correctAnswers: data.metadata.correctAnswers,
                    accuracy: parseAccuracy(data.metadata.accuracy),
                    byCategory,
                    isFormal,
                    performance,
                });
            } else if (benchmark === 'LongMemEval') {
                const byQuestionType = (data.byQuestionType || []).map((qt: any) => ({
                    questionType: qt.questionType,
                    correct: qt.correct,
                    total: qt.total,
                    accuracy: parseAccuracy(qt.accuracy),
                }));

                longMemEval.push({
                    runId: data.metadata.runId,
                    provider: data.metadata.provider,
                    answeringModel: data.metadata.answeringModel,
                    judgeModel: data.metadata.judgeModel,
                    timestamp,
                    evaluatedAt: data.metadata.evaluatedAt,
                    totalQuestions: data.metadata.totalQuestions,
                    correctAnswers: data.metadata.correctAnswers,
                    accuracy: parseAccuracy(data.metadata.accuracy),
                    byQuestionType,
                    isFormal,
                    performance,
                });
            }
        } catch (err) {
            console.error(`Error reading ${summaryPath}:`, err);
        }
    }

    // Sort by evaluated time (most recent first)
    const sortByDate = (a: { evaluatedAt: string }, b: { evaluatedAt: string }) => {
        return new Date(b.evaluatedAt).getTime() - new Date(a.evaluatedAt).getTime();
    };

    noLiMa.sort(sortByDate);
    loCoMo.sort(sortByDate);
    longMemEval.sort(sortByDate);

    return { noLiMa, loCoMo, longMemEval };
}

export interface AggregationOptions {
    formalOnly?: boolean;
}

/**
 * Get all aggregated data
 */
export function getAllAggregatedData(options: AggregationOptions = {}): AggregatedData {
    let { noLiMa, loCoMo, longMemEval } = aggregateAllBenchmarks();
    
    const formalOnly = options.formalOnly !== false; // Default to true

    if (formalOnly) {
        noLiMa = noLiMa.filter(r => r.isFormal);
        loCoMo = loCoMo.filter(r => r.isFormal);
        longMemEval = longMemEval.filter(r => r.isFormal);
    }

    // Get unique providers
    const providersSet = new Set<string>();
    noLiMa.forEach(r => providersSet.add(r.provider));
    loCoMo.forEach(r => providersSet.add(r.provider));
    longMemEval.forEach(r => providersSet.add(r.provider));

    // Get unique benchmarks with data
    const benchmarks: string[] = [];
    if (noLiMa.length > 0) benchmarks.push('NoLiMa');
    if (loCoMo.length > 0) benchmarks.push('LoCoMo');
    if (longMemEval.length > 0) benchmarks.push('LongMemEval');

    return {
        noLiMa,
        loCoMo,
        longMemEval,
        providers: Array.from(providersSet).sort(),
        benchmarks,
    };
}

/**
 * Get the most recent run for each provider for comparison charts
 */
export function getLatestRunsByProvider(options: AggregationOptions = {}): AggregatedData {
    const data = getAllAggregatedData(options);
    
    // For each benchmark, keep only the most recent run per provider
    const latestNoLiMa: NoLiMaResult[] = [];
    const latestLoCoMo: LoCoMoResult[] = [];
    const latestLongMemEval: LongMemEvalResult[] = [];
    
    const seenNoLiMa = new Set<string>();
    const seenLoCoMo = new Set<string>();
    const seenLongMemEval = new Set<string>();
    
    for (const r of data.noLiMa) {
        if (!seenNoLiMa.has(r.provider)) {
            seenNoLiMa.add(r.provider);
            latestNoLiMa.push(r);
        }
    }
    
    for (const r of data.loCoMo) {
        if (!seenLoCoMo.has(r.provider)) {
            seenLoCoMo.add(r.provider);
            latestLoCoMo.push(r);
        }
    }
    
    for (const r of data.longMemEval) {
        if (!seenLongMemEval.has(r.provider)) {
            seenLongMemEval.add(r.provider);
            latestLongMemEval.push(r);
        }
    }
    
    return {
        noLiMa: latestNoLiMa,
        loCoMo: latestLoCoMo,
        longMemEval: latestLongMemEval,
        providers: data.providers,
        benchmarks: data.benchmarks,
    };
}

// ============================================================================
// Dataset Statistics
// ============================================================================

export interface LoCoMoDatasetStats {
    conversations: {
        total: number;
        avgSessions: number;
        avgTurns: number;
        avgTokens: number;
    };
    questions: {
        total: number;
        byCategory: Array<{
            category: number;
            name: string;
            count: number;
            percentage: number;
        }>;
    };
    multimodal: {
        avgImages: number;
        totalImages: number;
    };
}

export function getLoCoMoDatasetStats(): LoCoMoDatasetStats | null {
    const dataPath = join(process.cwd(), 'benchmarks/LoCoMo/locomo10.json');
    
    if (!existsSync(dataPath)) {
        return null;
    }
    
    try {
        const data = JSON.parse(readFileSync(dataPath, 'utf-8'));
        
        let totalSessions = 0;
        let totalTurns = 0;
        let totalTokens = 0;
        let totalImages = 0;
        
        const categoryCounts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        let totalQuestions = 0;
        
        for (const sample of data) {
            // Count sessions and turns
            const conversation = sample.conversation || {};
            const sessionKeys = Object.keys(conversation).filter(k => k.startsWith('session_') && !k.includes('date'));
            totalSessions += sessionKeys.length;
            
            for (const key of sessionKeys) {
                const session = conversation[key];
                if (Array.isArray(session)) {
                    totalTurns += session.length;
                    
                    // Count tokens (rough estimate)
                    for (const turn of session) {
                        if (turn.text) {
                            totalTokens += turn.text.split(/\s+/).length;
                        }
                        // Count images
                        if (turn.img_url && Array.isArray(turn.img_url)) {
                            totalImages += turn.img_url.length;
                        }
                    }
                }
            }
            
            // Count questions by category
            const qa = sample.qa || [];
            for (const q of qa) {
                totalQuestions++;
                const cat = q.category || 0;
                categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
            }
        }
        
        const numConversations = data.length;
        
        // Paper category names (corrected based on paper)
        const categoryNames: Record<number, string> = {
            1: 'Multi-hop Retrieval',
            2: 'Temporal Reasoning',
            3: 'Open Domain Knowledge',
            4: 'Single-hop Retrieval',
            5: 'Adversarial',
        };
        
        return {
            conversations: {
                total: numConversations,
                avgSessions: numConversations > 0 ? Math.round((totalSessions / numConversations) * 10) / 10 : 0,
                avgTurns: totalSessions > 0 ? Math.round((totalTurns / totalSessions) * 10) / 10 : 0,
                avgTokens: numConversations > 0 ? Math.round(totalTokens / numConversations) : 0,
            },
            questions: {
                total: totalQuestions,
                byCategory: Object.entries(categoryCounts)
                    .filter(([_, count]) => count > 0)
                    .map(([cat, count]) => ({
                        category: parseInt(cat),
                        name: categoryNames[parseInt(cat)] || `Category ${cat}`,
                        count,
                        percentage: Math.round((count / totalQuestions) * 1000) / 10,
                    }))
                    .sort((a, b) => b.count - a.count),
            },
            multimodal: {
                avgImages: numConversations > 0 ? Math.round((totalImages / numConversations) * 10) / 10 : 0,
                totalImages,
            },
        };
    } catch (err) {
        console.error('Error computing LoCoMo stats:', err);
        return null;
    }
}

export interface NoLiMaDatasetStats {
    totalTests: number;
    contextLengths: string[];
    testsPerLength: number;
}

export function getNoLiMaDatasetStats(): NoLiMaDatasetStats | null {
    // NoLiMa has 52 tests per context length (1K, 4K, 8K, 16K, 32K)
    return {
        totalTests: 260,
        contextLengths: ['1K', '4K', '8K', '16K', '32K'],
        testsPerLength: 52,
    };
}

export interface LongMemEvalDatasetStats {
    totalQuestions: number;
    questionTypes: Array<{
        type: string;
        label: string;
        count: number;
    }>;
}

export function getLongMemEvalDatasetStats(): LongMemEvalDatasetStats | null {
    const dataPath = join(process.cwd(), 'benchmarks/LongMemEval/datasets/longmemeval_s_cleaned.json');
    
    if (!existsSync(dataPath)) {
        return null;
    }
    
    try {
        const data = JSON.parse(readFileSync(dataPath, 'utf-8'));
        
        const typeCounts: Record<string, number> = {};
        
        for (const item of data) {
            const qtype = item.question_type || 'unknown';
            typeCounts[qtype] = (typeCounts[qtype] || 0) + 1;
        }
        
        return {
            totalQuestions: data.length,
            questionTypes: Object.entries(typeCounts).map(([type, count]) => ({
                type,
                label: LONGMEMEVAL_LABELS[type] || type,
                count,
            })),
        };
    } catch (err) {
        console.error('Error computing LongMemEval stats:', err);
        return null;
    }
}
