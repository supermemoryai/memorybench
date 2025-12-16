/*
LoCoMo Report Generator
Generates aggregate accuracy report from evaluation results.

Usage: bun run generate-report.ts <runId>
       bun run generate-report.ts --all
*/

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CATEGORY_NAMES: { [key: number]: string } = {
    1: 'Single-hop',
    2: 'Multi-hop',
    3: 'Temporal',
    4: 'Open-domain',
    5: 'Adversarial'
};

// Get command line arguments
const args = process.argv.slice(2);
if (args.length < 1) {
    console.error("Usage: bun run generate-report.ts <runId>");
    console.error("bun run generate-report.ts --all");
    process.exit(1);
}

const resultsDir = join(__dirname, '../../results');

if (!existsSync(resultsDir)) {
    console.error(`Results directory not found: ${resultsDir}`);
    process.exit(1);
}

// Determine if we're processing all files or a specific run
const isAllMode = args[0] === '--all';
let resultFiles: string[];
let runId: string | null = null;

if (isAllMode) {
    // Find all result files
    resultFiles = readdirSync(resultsDir)
        .filter(f => f.startsWith('result-') && f.endsWith('.json'))
        .sort();
    
    if (resultFiles.length === 0) {
        console.error('No result files found');
        process.exit(1);
    }
    
    console.log(`Found ${resultFiles.length} result files\n`);
} else {
    // Find result files for this specific run
    runId = args[0]!;
    resultFiles = readdirSync(resultsDir)
        .filter(f => f.startsWith('result-') && f.includes(`-${runId}`) && f.endsWith('.json'))
        .sort();
    
    if (resultFiles.length === 0) {
        console.error(`No result files found for run: ${runId}`);
        process.exit(1);
    }
    
    console.log(`Found ${resultFiles.length} result files for ${runId}\n`);
}

interface ConvStats {
    convId: string;
    total: number;
    correct: number;
    accuracy: number;
    weightedAccuracy: number;
    categoryAccuracies: { [key: number]: { total: number; correct: number; accuracy: number } };
}

// Process each file
const allStats: ConvStats[] = [];
const allResults: any[] = [];

for (const file of resultFiles) {
    const filePath = join(resultsDir, file);
    try {
        const data = JSON.parse(readFileSync(filePath, 'utf8'));
        const results = data.results || [];
        
        allResults.push(...results);
        
        const total = results.length;
        const correct = results.filter((r: any) => r.score === 1).length;
        const accuracy = total > 0 ? (correct / total) * 100 : 0;
        
        // Category breakdown
        const categoryAccuracies: { [key: number]: { total: number; correct: number; accuracy: number } } = {};
        for (const cat of [1, 2, 3, 4, 5]) {
            const catResults = results.filter((r: any) => r.question_category === cat);
            const catCorrect = catResults.filter((r: any) => r.score === 1).length;
            const catTotal = catResults.length;
            categoryAccuracies[cat] = {
                total: catTotal,
                correct: catCorrect,
                accuracy: catTotal > 0 ? (catCorrect / catTotal) * 100 : 0
            };
        }
        
        // Weighted accuracy
        const catsWithData = Object.values(categoryAccuracies).filter(c => c.total > 0);
        const weightedAccuracy = catsWithData.length > 0
            ? catsWithData.reduce((sum, c) => sum + c.accuracy, 0) / catsWithData.length
            : 0;
        
        allStats.push({
            convId: data.metadata?.conversation_id || file,
            total,
            correct,
            accuracy,
            weightedAccuracy,
            categoryAccuracies
        });
        
    } catch (error) {
        console.error(`Error processing ${file}:`, error);
    }
}

// Generate bar
function bar(pct: number, len: number): string {
    const filled = Math.round((pct / 100) * len);
    return '█'.repeat(filled) + '░'.repeat(len - filled);
}

// Calculate aggregates
const totalQuestions = allStats.reduce((sum, s) => sum + s.total, 0);
const totalCorrect = allStats.reduce((sum, s) => sum + s.correct, 0);
const overallAccuracy = totalQuestions > 0 ? (totalCorrect / totalQuestions) * 100 : 0;

// Aggregate category metrics
const aggCategories: { [key: number]: { total: number; correct: number; accuracy: number } } = {};
for (const cat of [1, 2, 3, 4, 5]) {
    const total = allStats.reduce((sum, s) => sum + (s.categoryAccuracies[cat]?.total || 0), 0);
    const correct = allStats.reduce((sum, s) => sum + (s.categoryAccuracies[cat]?.correct || 0), 0);
    aggCategories[cat] = {
        total,
        correct,
        accuracy: total > 0 ? (correct / total) * 100 : 0
    };
}

const catsWithData = Object.values(aggCategories).filter(c => c.total > 0);
const totalWeightedAccuracy = catsWithData.length > 0
    ? catsWithData.reduce((sum, c) => sum + c.accuracy, 0) / catsWithData.length
    : 0;

const avgConvWeightedAcc = allStats.length > 0
    ? allStats.reduce((sum, s) => sum + s.weightedAccuracy, 0) / allStats.length
    : 0;

// Build report
const lines: string[] = [];

lines.push('');
lines.push('╔══════════════════════════════════════════════════════════════════════════════╗');
lines.push('║              🏆 LOCOMO AGGREGATE SUMMARY 🏆                                  ║');
lines.push('╚══════════════════════════════════════════════════════════════════════════════╝');
lines.push('');
if (runId) {
    lines.push(`Run ID: ${runId}`);
} else {
    lines.push('All Conversations (All Runs)');
}
lines.push('');
lines.push('┌─ OVERALL METRICS ────────────────────────────────────────────────────────────┐');
lines.push(`│  Conversations:       ${allStats.length.toString().padStart(5)}                                              │`);
lines.push(`│  Total Questions:     ${totalQuestions.toString().padStart(5)}                                              │`);
lines.push(`│  Correct Answers:     ${totalCorrect.toString().padStart(5)}                                              │`);
lines.push('│                                                                              │');
lines.push(`│  Overall Accuracy:        ${overallAccuracy.toFixed(2).padStart(6)}%  (micro-avg)                         │`);
lines.push(`│  Total Weighted Accuracy: ${totalWeightedAccuracy.toFixed(2).padStart(6)}%  (macro-avg by category)        │`);
lines.push(`│  Avg Conv Weighted Acc:   ${avgConvWeightedAcc.toFixed(2).padStart(6)}%  (avg of per-conv weighted)   │`);
lines.push('└──────────────────────────────────────────────────────────────────────────────┘');
lines.push('');
lines.push('┌─ ACCURACY BY CATEGORY ───────────────────────────────────────────────────────┐');
lines.push('│  Category      │ Total │ Correct │ Accuracy │                                │');
lines.push('│  ─────────────────────────────────────────────────────────────────────────── │');

for (const cat of [1, 2, 3, 4, 5]) {
    const c = aggCategories[cat]!;
    if (c.total > 0) {
        const name = CATEGORY_NAMES[cat]!.padEnd(12);
        const totalStr = c.total.toString().padStart(5);
        const correctStr = c.correct.toString().padStart(7);
        const accStr = (c.accuracy.toFixed(1) + '%').padStart(8);
        lines.push(`│  ${name} │ ${totalStr} │ ${correctStr} │ ${accStr} │ ${bar(c.accuracy, 10)}                   │`);
    }
}

lines.push('└──────────────────────────────────────────────────────────────────────────────┘');
lines.push('');
lines.push('┌─ PER-CONVERSATION RESULTS ───────────────────────────────────────────────────┐');
lines.push('│  Conversation   │ Questions │ Correct │ Accuracy │ Weighted │                │');
lines.push('│  ─────────────────────────────────────────────────────────────────────────── │');

for (const s of allStats) {
    const convId = s.convId.substring(0, 13).padEnd(13);
    const questions = s.total.toString().padStart(9);
    const correct = s.correct.toString().padStart(7);
    const acc = (s.accuracy.toFixed(1) + '%').padStart(8);
    const weighted = (s.weightedAccuracy.toFixed(1) + '%').padStart(8);
    lines.push(`│  ${convId} │ ${questions} │ ${correct} │ ${acc} │ ${weighted} │ ${bar(s.weightedAccuracy, 10)}     │`);
}

lines.push('└──────────────────────────────────────────────────────────────────────────────┘');
lines.push('');

const report = lines.join('\n');
console.log(report);

// Save report
const reportFileName = runId ? `aggregate-${runId}.txt` : 'aggregate-all.txt';
const reportPath = join(resultsDir, reportFileName);
writeFileSync(reportPath, report);
console.log(`✓ Report saved to: ${reportPath}`);

