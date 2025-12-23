#!/usr/bin/env bun
/**
 * Re-calculate LoCoMo evaluation scores using different metrics
 * Uses existing generated answers without re-running the LLM
 * 
 * Usage:
 *   bun run scripts/recalculate-locomo.ts <runId> [--method=exact|f1|strict]
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { evaluate, type EvalMethod } from '../core/utils/metrics';

const CATEGORY_NAMES: Record<number, string> = {
    1: 'Single-hop Factual',
    2: 'Temporal Reasoning',
    3: 'Multi-hop Reasoning',
    4: 'Simple Factual',
    5: 'Adversarial'
};

interface StoredEvaluation {
    questionId: string;
    category: number;
    question: string;
    groundTruth: string;
    hypothesis: string;
    label: number;
    explanation: string;
    score?: number;
}

function main() {
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
        console.log('Usage: bun run scripts/recalculate-locomo.ts <runId> [--method=exact|f1|strict]');
        console.log('');
        console.log('Re-calculates evaluation scores from existing generated answers.');
        console.log('');
        console.log('Options:');
        console.log('  --method=exact   Check if answer contains ground truth (default)');
        console.log('  --method=f1      Token overlap F1 score');
        console.log('  --method=strict  Exact string match after normalization');
        process.exit(1);
    }

    const runId = args[0];
    let method: EvalMethod = 'exact';

    for (const arg of args.slice(1)) {
        if (arg.startsWith('--method=')) {
            method = arg.split('=')[1] as EvalMethod;
        }
    }

    // Find evaluation file
    const evalDir = join(process.cwd(), 'results', runId, 'evaluation');
    
    if (!existsSync(evalDir)) {
        console.error(`Error: No evaluation directory found for run ${runId}`);
        console.error(`Expected: ${evalDir}`);
        process.exit(1);
    }

    const evalFiles = readdirSync(evalDir).filter(f => f.endsWith('.json'));
    
    if (evalFiles.length === 0) {
        console.error(`Error: No evaluation files found in ${evalDir}`);
        process.exit(1);
    }

    console.log(`Found ${evalFiles.length} evaluation file(s)`);
    console.log(`Re-calculating with method: ${method}`);
    console.log('');

    for (const filename of evalFiles) {
        const filepath = join(evalDir, filename);
        console.log(`Processing: ${filename}`);
        
        const data = JSON.parse(readFileSync(filepath, 'utf8'));
        const evaluations: StoredEvaluation[] = data.evaluations || [];

        if (evaluations.length === 0) {
            console.log('  No evaluations found, skipping');
            continue;
        }

        // Re-calculate scores
        let totalCorrect = 0;
        let totalF1 = 0;
        const categoryStats: Record<number, { correct: number; total: number; f1Sum: number }> = {};

        const updatedEvaluations = evaluations.map(ev => {
            // Track stats
            if (!categoryStats[ev.category]) {
                categoryStats[ev.category] = { correct: 0, total: 0, f1Sum: 0 };
            }
            categoryStats[ev.category].total++;

            // Category 5 is adversarial - different evaluation logic
            if (ev.category === 5) {
                // For adversarial, groundTruth contains the WRONG answer to avoid
                // Extract adversarial answer from groundTruth (format: "[ADVERSARIAL - should NOT answer: X]")
                const adversarialMatch = ev.groundTruth.match(/should NOT answer: (.+)\]$/);
                const adversarialAnswer = adversarialMatch ? adversarialMatch[1] : ev.groundTruth;
                
                const normalizedResponse = ev.hypothesis.toLowerCase();
                const normalizedAdversarial = adversarialAnswer.toLowerCase();
                
                const gaveAdversarialAnswer = normalizedAdversarial && normalizedResponse.includes(normalizedAdversarial);
                const saidDontKnow = normalizedResponse.includes("don't know") || 
                                     normalizedResponse.includes("don't have enough information") ||
                                     normalizedResponse.includes("cannot answer");
                
                let label: number;
                let explanation: string;
                
                if (gaveAdversarialAnswer) {
                    label = 0;
                    explanation = `FAILED: Model gave adversarial answer "${adversarialAnswer}"`;
                } else if (saidDontKnow) {
                    label = 0;
                    explanation = `PARTIAL: Avoided trap but said "I don't know"`;
                } else {
                    label = 1;
                    explanation = `PASSED: Avoided adversarial answer`;
                    totalCorrect++;
                    categoryStats[ev.category].correct++;
                }
                
                return { ...ev, label, explanation, score: label };
            }
            
            // Regular questions (categories 1-4)
            const result = evaluate(ev.hypothesis, ev.groundTruth, method);
            categoryStats[ev.category].f1Sum += result.score;
            
            if (result.correct) {
                totalCorrect++;
                categoryStats[ev.category].correct++;
            }
            totalF1 += result.score;

            return {
                ...ev,
                label: result.correct ? 1 : 0,
                score: result.score,
                explanation: method === 'f1' 
                    ? `F1 score: ${result.score.toFixed(3)}`
                    : `${method} match: ${result.correct ? 'yes' : 'no'}`
            };
        });

        const totalQuestions = evaluations.length;
        const accuracy = ((totalCorrect / totalQuestions) * 100).toFixed(2);
        const avgF1 = (totalF1 / totalQuestions).toFixed(3);

        // Update report
        const updatedReport = {
            ...data,
            metadata: {
                ...data.metadata,
                evalMethod: method,
                recalculatedAt: new Date().toISOString(),
                totalQuestions,
                correctAnswers: totalCorrect,
                accuracy: `${accuracy}%`,
                avgF1Score: method === 'f1' ? avgF1 : undefined
            },
            byCategory: Object.entries(categoryStats).map(([cat, stats]) => ({
                category: parseInt(cat),
                categoryName: CATEGORY_NAMES[parseInt(cat)] || `Category ${cat}`,
                correct: stats.correct,
                total: stats.total,
                accuracy: ((stats.correct / stats.total) * 100).toFixed(2) + '%',
                avgF1: method === 'f1' ? (stats.f1Sum / stats.total).toFixed(3) : undefined
            })),
            evaluations: updatedEvaluations
        };

        // Save updated report
        const newFilename = filename.replace('.json', `-${method}.json`);
        const newPath = join(evalDir, newFilename);
        writeFileSync(newPath, JSON.stringify(updatedReport, null, 2));

        // Print results
        console.log('');
        console.log(`=== Results (${method}) ===`);
        console.log(`Overall Accuracy: ${accuracy}%`);
        console.log(`Total Questions: ${totalQuestions}`);
        console.log(`Correct Answers: ${totalCorrect}`);
        if (method === 'f1') {
            console.log(`Average F1 Score: ${avgF1}`);
        }
        console.log('');
        console.log('By Category:');
        for (const [cat, stats] of Object.entries(categoryStats).sort((a, b) => parseInt(a[0]) - parseInt(b[0]))) {
            const catName = CATEGORY_NAMES[parseInt(cat)] || `Category ${cat}`;
            const catAccuracy = ((stats.correct / stats.total) * 100).toFixed(2);
            if (method === 'f1') {
                const catF1 = (stats.f1Sum / stats.total).toFixed(3);
                console.log(`  ${catName}: ${catAccuracy}% (${stats.correct}/${stats.total}) | F1: ${catF1}`);
            } else {
                console.log(`  ${catName}: ${catAccuracy}% (${stats.correct}/${stats.total})`);
            }
        }
        console.log('');
        console.log(`Saved to: ${newPath}`);
    }
}

main();

