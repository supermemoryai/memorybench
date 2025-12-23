/**
 * Data Aggregation Module
 * Reads benchmark results from evaluation-summary.json files for visualization
 */

import { join } from 'path';
import { readdirSync, readFileSync, statSync, existsSync } from 'fs';

export interface NoLiMaResult {
    runId: string;
    provider: string;
    answeringModel: string;
    judgeModel: string;
    timestamp: string;
    totalTests: number;
    correctAnswers: number;
    accuracy: number;
    retrievalRate: number;
}

export interface LoCoMoResult {
    runId: string;
    provider: string;
    answeringModel: string;
    judgeModel: string;
    timestamp: string;
    totalQuestions: number;
    correctAnswers: number;
    accuracy: number;
}

export interface LongMemEvalResult {
    runId: string;
    provider: string;
    answeringModel: string;
    judgeModel: string;
    timestamp: string;
    totalQuestions: number;
    correctAnswers: number;
    accuracy: number;
    questionTypes: {
        questionType: string;
        correct: number;
        total: number;
        accuracy: string;
    }[];
}

export interface AggregatedData {
    noLiMa: NoLiMaResult[];
    loCoMo: LoCoMoResult[];
    longMemEval: LongMemEvalResult[];
    providers: string[];
}

const RESULTS_DIR = join(process.cwd(), 'results');

/**
 * Parse runId to extract timestamp
 */
function extractTimestamp(runId: string): string {
    const parts = runId.split('_');
    return parts.slice(2).join('_') || new Date().toISOString();
}

/**
 * Aggregate all benchmarks by reading evaluation-summary.json from each run directory
 */
function aggregateAllBenchmarks(): { noLiMa: NoLiMaResult[], loCoMo: LoCoMoResult[], longMemEval: LongMemEvalResult[] } {
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

            if (benchmark === 'NoLiMa') {
                const accuracy = typeof data.metadata.accuracy === 'string' 
                    ? parseFloat(data.metadata.accuracy) 
                    : data.metadata.accuracy;
                const retrievalRate = data.metrics?.retrievalRate || 
                    (data.byContextLength?.[0]?.retrievalRate ? parseFloat(data.byContextLength[0].retrievalRate) : 0);
                
                noLiMa.push({
                    runId: data.metadata.runId,
                    provider: data.metadata.provider,
                    answeringModel: data.metadata.answeringModel,
                    judgeModel: data.metadata.judgeModel,
                    timestamp,
                    totalTests: data.metadata.totalTests,
                    correctAnswers: data.metadata.correctAnswers,
                    accuracy,
                    retrievalRate
                });
            } else if (benchmark === 'LoCoMo') {
                loCoMo.push({
                    runId: data.metadata.runId,
                    provider: data.metadata.provider,
                    answeringModel: data.metadata.answeringModel,
                    judgeModel: data.metadata.judgeModel,
                    timestamp,
                    totalQuestions: data.metadata.totalQuestions,
                    correctAnswers: data.metadata.correctAnswers,
                    accuracy: parseFloat(data.metadata.accuracy)
                });
            } else if (benchmark === 'LongMemEval') {
                longMemEval.push({
                    runId: data.metadata.runId,
                    provider: data.metadata.provider,
                    answeringModel: data.metadata.answeringModel,
                    judgeModel: data.metadata.judgeModel,
                    timestamp,
                    totalQuestions: data.metadata.totalQuestions,
                    correctAnswers: data.metadata.correctAnswers,
                    accuracy: parseFloat(data.metadata.accuracy),
                    questionTypes: data.byQuestionType
                });
            }
        } catch (err) {
            console.error(`Error reading ${summaryPath}:`, err);
        }
    }

    return { noLiMa, loCoMo, longMemEval };
}

export interface AggregationOptions {
    formalOnly?: boolean; // Default: true (only include _formal runs)
}

/**
 * Get all aggregated data
 */
export function getAllAggregatedData(options: AggregationOptions = {}): AggregatedData {
    let { noLiMa, loCoMo, longMemEval } = aggregateAllBenchmarks();

    const providersSet = new Set<string>();
    noLiMa.forEach(r => providersSet.add(r.provider));
    loCoMo.forEach(r => providersSet.add(r.provider));
    longMemEval.forEach(r => providersSet.add(r.provider));

    return {
        noLiMa,
        loCoMo,
        longMemEval,
        providers: Array.from(providersSet).sort()
    };
}
