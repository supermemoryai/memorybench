/**
 * Visualization Pipeline for MemoryBench
 * 
 * Generates PNG plots comparing memory providers on benchmarks.
 * 
 * Usage: bun scripts/generate-plots.ts [benchmark]
 * Example: bun scripts/generate-plots.ts NoLiMa
 *          bun scripts/generate-plots.ts LoCoMo
 *          bun scripts/generate-plots.ts LongMemEval
 *          bun scripts/generate-plots.ts all
 */

import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';
import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import type { ChartConfiguration } from 'chart.js';

// ============================================================================
// Configuration
// ============================================================================

const RESULTS_DIR = join(process.cwd(), 'results');
const PLOTS_DIR = join(process.cwd(), 'plots');

// Consistent provider colors
const PROVIDER_COLORS: Record<string, string> = {
    supermemory: '#3B82F6',  // Blue
    zep: '#F97316',          // Orange
    mem0: '#FBBF24',         // Yellow/Amber
    fullcontext: '#8B5CF6',  // Purple
    langchain: '#10B981',    // Green
    default: '#6B7280',      // Gray
};

// Context length order for NoLiMa
const CONTEXT_LENGTH_ORDER = ['1K', '4K', '8K', '16K', '32K'];

// LoCoMo categories
const LOCOMO_CATEGORIES = [
    { id: 1, name: 'Single-hop Factual' },
    { id: 2, name: 'Temporal Reasoning' },
    { id: 3, name: 'Multi-hop Reasoning' },
    { id: 4, name: 'Simple Factual' },
    { id: 5, name: 'Adversarial' },
];

// LongMemEval question types
const LONGMEMEVAL_TYPES = [
    'single-session-user',
    'single-session-assistant', 
    'single-session-preference',
    'knowledge-update',
    'temporal-reasoning',
    'multi-session',
];

const LONGMEMEVAL_LABELS: Record<string, string> = {
    'single-session-user': 'User (Single)',
    'single-session-assistant': 'Assistant (Single)',
    'single-session-preference': 'Preference',
    'knowledge-update': 'Knowledge Update',
    'temporal-reasoning': 'Temporal',
    'multi-session': 'Multi-Session',
};

// Chart dimensions
const CHART_WIDTH = 1200;
const CHART_HEIGHT = 700;

// ============================================================================
// Types
// ============================================================================

interface EvaluationSummary {
    benchmark: string;
    metadata: {
        runId: string;
        provider: string;
        answeringModel: string;
        judgeModel?: string;
        evalMethod?: string;
        evaluatedAt: string;
        totalTests?: number;
        totalQuestions?: number;
        correctAnswers: number;
        accuracy: string;
    };
    metrics?: {
        overallAccuracy: number;
        baseScore: number;
        effectiveLength?: number;
        retrievalRate?: number;
    };
    byContextLength?: Array<{
        contextLength: string;
        correct: number;
        total: number;
        accuracy: string;
        retrievalRate?: string;
    }>;
    byCategory?: Array<{
        category: number;
        categoryName: string;
        correct: number;
        total: number;
        accuracy: string;
    }>;
    byQuestionType?: Array<{
        questionType: string;
        correct: number;
        total: number;
        accuracy: string;
    }>;
}

// ============================================================================
// Utilities
// ============================================================================

function getProviderColor(provider: string): string {
    return PROVIDER_COLORS[provider] || PROVIDER_COLORS.default;
}

function parseAccuracy(value: string | number): number {
    if (typeof value === 'number') return value;
    return parseFloat(value.replace('%', '')) || 0;
}

// ============================================================================
// Data Loading
// ============================================================================

function scanEvaluationFiles(benchmarkFilter?: string): EvaluationSummary[] {
    const summaries: EvaluationSummary[] = [];

    if (!existsSync(RESULTS_DIR)) {
        console.error('Results directory not found:', RESULTS_DIR);
        return summaries;
    }

    const runDirs = readdirSync(RESULTS_DIR).filter(dir => {
        const fullPath = join(RESULTS_DIR, dir);
        try {
            return statSync(fullPath).isDirectory();
        } catch {
            return false;
        }
    });

    for (const runDir of runDirs) {
        // Filter by benchmark if specified
        if (benchmarkFilter && benchmarkFilter !== 'all') {
            if (!runDir.startsWith(benchmarkFilter + '_')) {
                continue;
            }
        }

        // Only include formal runs
        if (!runDir.includes('_formal')) {
            continue;
        }

        const summaryPath = join(RESULTS_DIR, runDir, 'evaluation-summary.json');
        if (!existsSync(summaryPath)) continue;

        try {
            const data = JSON.parse(readFileSync(summaryPath, 'utf-8'));
            summaries.push(data as EvaluationSummary);
        } catch (err) {
            console.warn(`Error reading ${summaryPath}:`, err);
        }
    }

    // Sort by evaluatedAt descending
    summaries.sort((a, b) => {
        const dateA = new Date(a.metadata.evaluatedAt || 0).getTime();
        const dateB = new Date(b.metadata.evaluatedAt || 0).getTime();
        return dateB - dateA;
    });

    return summaries;
}

function getLatestByProvider(summaries: EvaluationSummary[], benchmark: string): Map<string, EvaluationSummary> {
    const providerMap = new Map<string, EvaluationSummary>();
    
    for (const summary of summaries) {
        if (summary.benchmark !== benchmark) continue;
        if (providerMap.has(summary.metadata.provider)) continue;
        providerMap.set(summary.metadata.provider, summary);
    }
    
    return providerMap;
}

// ============================================================================
// Chart Creation
// ============================================================================

async function createChart(config: ChartConfiguration, filename: string): Promise<void> {
    const chartJSNodeCanvas = new ChartJSNodeCanvas({ 
        width: CHART_WIDTH, 
        height: CHART_HEIGHT,
        backgroundColour: '#0B0D14',
    });

    const buffer = await chartJSNodeCanvas.renderToBuffer(config);
    const outputPath = join(PLOTS_DIR, filename);
    writeFileSync(outputPath, buffer);
    console.log(`  ✓ Generated: ${filename}`);
}

function getBaseChartOptions(title: string, xLabel: string, yLabel: string, yMax: number = 100): any {
    return {
        responsive: false,
        plugins: {
            title: {
                display: true,
                text: title,
                color: '#F8FAFC',
                font: { size: 24, weight: 'bold' },
                padding: 20,
            },
            legend: {
                display: true,
                position: 'top',
                labels: {
                    color: '#94A3B8',
                    font: { size: 14 },
                    padding: 20,
                    usePointStyle: true,
                },
            },
        },
        scales: {
            x: {
                title: {
                    display: true,
                    text: xLabel,
                    color: '#94A3B8',
                    font: { size: 14 },
                },
                ticks: { color: '#64748B' },
                grid: { color: 'rgba(255,255,255,0.1)' },
            },
            y: {
                title: {
                    display: true,
                    text: yLabel,
                    color: '#94A3B8',
                    font: { size: 14 },
                },
                min: 0,
                max: yMax,
                ticks: { color: '#64748B' },
                grid: { color: 'rgba(255,255,255,0.1)' },
            },
        },
    };
}

// ============================================================================
// NoLiMa Plots
// ============================================================================

async function generateNoLiMaPlots(summaries: EvaluationSummary[]): Promise<void> {
    const providers = getLatestByProvider(summaries, 'NoLiMa');
    
    if (providers.size === 0) {
        console.log('  ⚠ No NoLiMa results found');
        return;
    }

    console.log(`  Processing ${providers.size} providers: ${Array.from(providers.keys()).join(', ')}`);

    // (A) Accuracy vs Context Length
    const accuracyDatasets = Array.from(providers.values()).map(s => ({
        label: s.metadata.provider,
        data: CONTEXT_LENGTH_ORDER.map(ctx => {
            const ctxData = s.byContextLength?.find(c => c.contextLength === ctx);
            return ctxData ? parseAccuracy(ctxData.accuracy) : 0;
        }),
        borderColor: getProviderColor(s.metadata.provider),
        backgroundColor: getProviderColor(s.metadata.provider) + '40',
        borderWidth: 3,
        pointRadius: 6,
        tension: 0.3,
        fill: false,
    }));

    await createChart({
        type: 'line',
        data: { labels: CONTEXT_LENGTH_ORDER, datasets: accuracyDatasets },
        options: getBaseChartOptions('NoLiMa: Accuracy vs Context Length', 'Context Length', 'Accuracy (%)'),
    }, 'nolima_accuracy_vs_context.png');

    // (B) Retrieval Rate vs Context Length
    const retrievalDatasets = Array.from(providers.values()).map(s => ({
        label: s.metadata.provider,
        data: CONTEXT_LENGTH_ORDER.map(ctx => {
            const ctxData = s.byContextLength?.find(c => c.contextLength === ctx);
            return ctxData ? parseAccuracy(ctxData.retrievalRate || '0') : 0;
        }),
        borderColor: getProviderColor(s.metadata.provider),
        backgroundColor: getProviderColor(s.metadata.provider) + '40',
        borderWidth: 3,
        pointRadius: 6,
        tension: 0.3,
        fill: false,
    }));

    await createChart({
        type: 'line',
        data: { labels: CONTEXT_LENGTH_ORDER, datasets: retrievalDatasets },
        options: getBaseChartOptions('NoLiMa: Retrieval Rate vs Context Length', 'Context Length', 'Retrieval Rate (%)'),
    }, 'nolima_retrieval_vs_context.png');

    // (C) Accuracy vs Retrieval Rate (Scatter)
    const scatterDatasets = Array.from(providers.values()).map(s => ({
        label: s.metadata.provider,
        data: CONTEXT_LENGTH_ORDER.map(ctx => {
            const ctxData = s.byContextLength?.find(c => c.contextLength === ctx);
            return {
                x: ctxData ? parseAccuracy(ctxData.retrievalRate || '0') : 0,
                y: ctxData ? parseAccuracy(ctxData.accuracy) : 0,
            };
        }),
        backgroundColor: getProviderColor(s.metadata.provider),
        pointRadius: 10,
    }));

    await createChart({
        type: 'scatter',
        data: { datasets: scatterDatasets },
        options: getBaseChartOptions('NoLiMa: Accuracy vs Retrieval Rate', 'Retrieval Rate (%)', 'Accuracy (%)'),
    }, 'nolima_accuracy_vs_retrieval.png');

    // (D) Memory Contribution (Stacked Bar)
    const providerNames = Array.from(providers.keys());
    const providerData = Array.from(providers.values());
    
    const baseScores = providerData.map(s => s.metrics?.baseScore || 0);
    const memoryContribs = providerData.map(s => {
        const overall = s.metrics?.overallAccuracy || parseAccuracy(s.metadata.accuracy);
        const base = s.metrics?.baseScore || 0;
        return Math.max(0, overall - base);
    });

    await createChart({
        type: 'bar',
        data: {
            labels: providerNames,
            datasets: [
                {
                    label: 'Base Score',
                    data: baseScores,
                    backgroundColor: providerNames.map(p => getProviderColor(p) + '60'),
                    borderColor: providerNames.map(p => getProviderColor(p)),
                    borderWidth: 2,
                },
                {
                    label: 'Memory Contribution',
                    data: memoryContribs,
                    backgroundColor: providerNames.map(p => getProviderColor(p)),
                    borderColor: providerNames.map(p => getProviderColor(p)),
                    borderWidth: 2,
                },
            ],
        },
        options: {
            ...getBaseChartOptions('NoLiMa: Memory Contribution', 'Provider', 'Accuracy (%)', 50),
            scales: {
                x: { stacked: true, ticks: { color: '#64748B', font: { size: 14 } }, grid: { display: false } },
                y: { stacked: true, ...getBaseChartOptions('', '', '', 50).scales.y },
            },
        },
    }, 'nolima_memory_contribution.png');
}

// ============================================================================
// LoCoMo Plots
// ============================================================================

async function generateLoCoMoPlots(summaries: EvaluationSummary[]): Promise<void> {
    const providers = getLatestByProvider(summaries, 'LoCoMo');
    
    if (providers.size === 0) {
        console.log('  ⚠ No LoCoMo results found');
        return;
    }

    console.log(`  Processing ${providers.size} providers: ${Array.from(providers.keys()).join(', ')}`);

    const categoryLabels = LOCOMO_CATEGORIES.map(c => c.name);

    // Accuracy by Category (Bar Chart)
    const datasets = Array.from(providers.values()).map(s => ({
        label: s.metadata.provider,
        data: LOCOMO_CATEGORIES.map(cat => {
            const catData = s.byCategory?.find(c => c.category === cat.id);
            return catData ? parseAccuracy(catData.accuracy) : 0;
        }),
        backgroundColor: getProviderColor(s.metadata.provider),
        borderColor: getProviderColor(s.metadata.provider),
        borderWidth: 2,
        borderRadius: 4,
    }));

    await createChart({
        type: 'bar',
        data: { labels: categoryLabels, datasets },
        options: {
            ...getBaseChartOptions('LoCoMo: Accuracy by Question Category', 'Question Category', 'Accuracy (%)'),
            scales: {
                x: {
                    ticks: { color: '#64748B', maxRotation: 45, minRotation: 45 },
                    grid: { display: false },
                },
                y: getBaseChartOptions('', '', '', 100).scales.y,
            },
        },
    }, 'locomo_accuracy_by_category.png');

    // Overall Comparison (Horizontal Bar)
    const providerNames = Array.from(providers.keys());
    const overallAccuracies = Array.from(providers.values()).map(s => parseAccuracy(s.metadata.accuracy));

    await createChart({
        type: 'bar',
        data: {
            labels: providerNames,
            datasets: [{
                label: 'Overall Accuracy',
                data: overallAccuracies,
                backgroundColor: providerNames.map(p => getProviderColor(p)),
                borderColor: providerNames.map(p => getProviderColor(p)),
                borderWidth: 2,
                borderRadius: 4,
            }],
        },
        options: {
            ...getBaseChartOptions('LoCoMo: Overall Provider Comparison', 'Provider', 'Accuracy (%)'),
            indexAxis: 'y' as const,
        },
    }, 'locomo_overall_comparison.png');
}

// ============================================================================
// LongMemEval Plots
// ============================================================================

async function generateLongMemEvalPlots(summaries: EvaluationSummary[]): Promise<void> {
    const providers = getLatestByProvider(summaries, 'LongMemEval');
    
    if (providers.size === 0) {
        console.log('  ⚠ No LongMemEval results found');
        return;
    }

    console.log(`  Processing ${providers.size} providers: ${Array.from(providers.keys()).join(', ')}`);

    const typeLabels = LONGMEMEVAL_TYPES.map(t => LONGMEMEVAL_LABELS[t] || t);

    // Accuracy by Question Type (Bar Chart)
    const datasets = Array.from(providers.values()).map(s => ({
        label: s.metadata.provider,
        data: LONGMEMEVAL_TYPES.map(qt => {
            const qtData = s.byQuestionType?.find(q => q.questionType === qt);
            return qtData ? parseAccuracy(qtData.accuracy) : 0;
        }),
        backgroundColor: getProviderColor(s.metadata.provider),
        borderColor: getProviderColor(s.metadata.provider),
        borderWidth: 2,
        borderRadius: 4,
    }));

    await createChart({
        type: 'bar',
        data: { labels: typeLabels, datasets },
        options: {
            ...getBaseChartOptions('LongMemEval: Accuracy by Question Type', 'Question Type', 'Accuracy (%)'),
            scales: {
                x: {
                    ticks: { color: '#64748B', maxRotation: 45, minRotation: 45 },
                    grid: { display: false },
                },
                y: getBaseChartOptions('', '', '', 100).scales.y,
            },
        },
    }, 'longmemeval_accuracy_by_type.png');

    // Overall Comparison
    const providerNames = Array.from(providers.keys());
    const overallAccuracies = Array.from(providers.values()).map(s => parseAccuracy(s.metadata.accuracy));

    await createChart({
        type: 'bar',
        data: {
            labels: providerNames,
            datasets: [{
                label: 'Overall Accuracy',
                data: overallAccuracies,
                backgroundColor: providerNames.map(p => getProviderColor(p)),
                borderColor: providerNames.map(p => getProviderColor(p)),
                borderWidth: 2,
                borderRadius: 4,
            }],
        },
        options: {
            ...getBaseChartOptions('LongMemEval: Overall Provider Comparison', 'Provider', 'Accuracy (%)'),
            indexAxis: 'y' as const,
        },
    }, 'longmemeval_overall_comparison.png');
}

// ============================================================================
// Summary Report
// ============================================================================

function generateSummaryReport(summaries: EvaluationSummary[]): void {
    const report: any = {
        generatedAt: new Date().toISOString(),
        benchmarks: {},
    };

    for (const benchmark of ['NoLiMa', 'LoCoMo', 'LongMemEval']) {
        const providers = getLatestByProvider(summaries, benchmark);
        if (providers.size === 0) continue;

        report.benchmarks[benchmark] = {
            providerCount: providers.size,
            providers: Array.from(providers.values()).map(s => ({
                provider: s.metadata.provider,
                runId: s.metadata.runId,
                overallAccuracy: parseAccuracy(s.metadata.accuracy).toFixed(2) + '%',
                totalQuestions: s.metadata.totalTests || s.metadata.totalQuestions,
                correctAnswers: s.metadata.correctAnswers,
                evaluatedAt: s.metadata.evaluatedAt,
            })),
        };
    }

    const reportPath = join(PLOTS_DIR, 'summary_report.json');
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`  ✓ Generated: summary_report.json`);
}

// ============================================================================
// Main
// ============================================================================

async function main() {
    const benchmark = process.argv[2] || 'all';
    
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║           MemoryBench Visualization Pipeline                 ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log('');

    // Create plots directory
    if (!existsSync(PLOTS_DIR)) {
        mkdirSync(PLOTS_DIR, { recursive: true });
    }

    // Scan evaluation files
    console.log(`📂 Scanning for evaluation files...`);
    const summaries = scanEvaluationFiles(benchmark);
    console.log(`   Found ${summaries.length} evaluation summaries`);

    if (summaries.length === 0) {
        console.error('❌ No evaluation summaries found. Run benchmarks with --formal flag first.');
        process.exit(1);
    }

    // Generate plots
    console.log('');
    console.log('🎨 Generating plots...');
    
    try {
        if (benchmark === 'all' || benchmark === 'NoLiMa') {
            console.log('');
            console.log('  📊 NoLiMa Benchmark:');
            await generateNoLiMaPlots(summaries);
        }
        
        if (benchmark === 'all' || benchmark === 'LoCoMo') {
            console.log('');
            console.log('  📊 LoCoMo Benchmark:');
            await generateLoCoMoPlots(summaries);
        }
        
        if (benchmark === 'all' || benchmark === 'LongMemEval') {
            console.log('');
            console.log('  📊 LongMemEval Benchmark:');
            await generateLongMemEvalPlots(summaries);
        }

        console.log('');
        console.log('  📋 Summary Report:');
        generateSummaryReport(summaries);
        
    } catch (error) {
        console.error('❌ Error generating plots:', error);
        process.exit(1);
    }

    console.log('');
    console.log('✅ All plots generated successfully!');
    console.log(`   Output directory: ${PLOTS_DIR}`);
    console.log('');
}

main().catch(console.error);
