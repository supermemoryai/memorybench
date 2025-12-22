/**
 * Helper module to prepare NoLiMa test cases
 * Generates test cases by combining needles with haystacks at various context lengths
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { NeedleItem, TestCase } from '../types';

const CONTEXT_LENGTHS = [1000, 4000, 8000, 16000, 32000]; // tokens

/**
 * Approximate token count (rough estimate: 1 token ≈ 4 characters)
 */
function estimateTokens(text: string): number {
    return Math.floor(text.length / 4);
}

/**
 * Generate all test cases from needle set and haystacks
 */
export function prepareTestCases(needleSetPath: string, haystackDir: string): TestCase[] {
    const needles: NeedleItem[] = JSON.parse(readFileSync(needleSetPath, 'utf8'));
    const haystacks = loadHaystacks(haystackDir);

    const testCases: TestCase[] = [];

    for (const needle of needles) {
        const testEntries = Object.entries(needle.tests);

        for (const [testId, test] of testEntries) {
            // Select a character and prepare needle text
            const character = needle.character_set[0]; // Use first character for simplicity
            const needleText = needle.needle
                .replace('{CHAR}', character)
                .replace('{1}', test.input_args[0] || '')
                .replace('{2}', test.input_args[1] || '')
                .replace('{3}', test.input_args[2] || '');

            // Prepare questions
            const onehopQuestion = needle.questions.onehop
                .replace('{2}', test.input_args[1] || '');

            const twohopQuestion = needle.questions.twohop
                ? needle.questions.twohop.replace('{3}', test.input_args[2] || '')
                : null;

            // Generate test cases for each context length
            for (const targetLength of CONTEXT_LENGTHS) {
                const haystack = selectHaystack(haystacks, targetLength, needleText);
                const actualLength = estimateTokens(haystack);

                // One-hop question
                testCases.push({
                    needleId: needle.id,
                    testId: `${testId}_onehop_${targetLength}`,
                    question: onehopQuestion,
                    questionType: 'onehop',
                    needle: needleText,
                    answer: character,
                    haystack,
                    contextLength: actualLength
                });

                // Two-hop question (if exists)
                if (twohopQuestion) {
                    testCases.push({
                        needleId: needle.id,
                        testId: `${testId}_twohop_${targetLength}`,
                        question: twohopQuestion,
                        questionType: 'twohop',
                        needle: needleText,
                        answer: character,
                        haystack,
                        contextLength: actualLength
                    });
                }
            }
        }
    }

    return testCases;
}

/**
 * Load haystack files
 */
function loadHaystacks(haystackDir: string): string[] {
    const haystacks: string[] = [];
    const files = readdirSync(haystackDir).filter(f => f.endsWith('.txt'));

    for (const file of files) {
        const content = readFileSync(join(haystackDir, file), 'utf8');
        haystacks.push(content);
    }

    return haystacks;
}

/**
 * Select and prepare haystack for target context length
 */
function selectHaystack(haystacks: string[], targetLength: number, needle: string): string {
    // Use first haystack and truncate to target length
    const haystack = haystacks[0] || '';
    const targetChars = targetLength * 4; // rough conversion from tokens to chars

    // Insert needle at random position (middle for simplicity)
    const halfLength = Math.floor(targetChars / 2);
    const before = haystack.substring(0, halfLength);
    const after = haystack.substring(halfLength, targetChars);

    return before + '\n\n' + needle + '\n\n' + after;
}
