/**
 * Ingestion module for LongMemEval
 * Handles ingesting all questions of a specific type
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getProviderRegistry } from '../../../core/providers/ProviderRegistry';
import type { BaseProvider } from '../../../core/providers/BaseProvider';

interface IngestOptions {
    startPosition?: number;
    endPosition?: number;
}

interface SessionCheckpoint {
    index: number;
    date: string;
    ingested: boolean;
    timestamp?: string;
    error?: string;
}

interface QuestionCheckpoint {
    questionId: string;
    runId: string;
    containerTag: string;
    sessions: SessionCheckpoint[];
}

export async function ingestAllQuestions(
    providerName: string,
    runId: string,
    questionType: string,
    options?: IngestOptions
) {
    console.log(`Ingesting ${questionType} questions...`);
    console.log(`Provider: ${providerName}`);
    console.log(`Run ID: ${runId}`);
    console.log('');

    // Get all question files of this type
    const questionsDir = join(process.cwd(), 'benchmarks/LongMemEval/datasets/questions');
    const allFiles = readdirSync(questionsDir).filter(f => f.endsWith('.json'));

    const questionFiles = allFiles.filter(filename => {
        const filePath = join(questionsDir, filename);
        const data = JSON.parse(readFileSync(filePath, 'utf8'));
        return data.question_type === questionType;
    });

    if (questionFiles.length === 0) {
        console.log(`No questions found for type: ${questionType}`);
        return;
    }

    console.log(`Found ${questionFiles.length} questions of type ${questionType}`);

    // Apply position filtering if provided
    let filesToProcess = questionFiles;
    if (options?.startPosition && options?.endPosition) {
        const start = options.startPosition - 1; // Convert to 0-indexed
        const end = options.endPosition;
        filesToProcess = questionFiles.slice(start, end);
        console.log(`Processing positions ${options.startPosition}-${options.endPosition}: ${filesToProcess.length} questions`);
    }

    console.log('');

    let successCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    for (let i = 0; i < filesToProcess.length; i++) {
        const filename = filesToProcess[i];
        const questionId = filename.replace('.json', '');

        console.log(`[${i + 1}/${filesToProcess.length}] Processing ${questionId}...`);

        try {
            await ingestSingleQuestion(questionId, runId, questionsDir, providerName);
            successCount++;
            console.log(`  ✓ Success`);

            // Wait between questions to avoid rate limiting
            if (i < filesToProcess.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        } catch (error) {
            failedCount++;
            console.error(`  ✗ Failed: ${error instanceof Error ? error.message : String(error)}`);
        }

        console.log('');
    }

    console.log('Ingestion Summary:');
    console.log(`  Success: ${successCount}`);
    console.log(`  Failed: ${failedCount}`);
    console.log(`  Total: ${filesToProcess.length}`);
    console.log('');
}

async function ingestSingleQuestion(
    questionId: string,
    runId: string,
    questionsDir: string,
    providerName: string
) {
    const questionFilePath = join(questionsDir, `${questionId}.json`);
    const data = JSON.parse(readFileSync(questionFilePath, 'utf8'));

    const haystackDates = data.haystack_dates;
    const haystackSessions = data.haystack_sessions;
    const containerTag = `${questionId}-${runId}`;

    // Setup checkpoint in centralized results directory
    const checkpointDir = join(process.cwd(), 'results', runId, 'checkpoints', 'ingest');
    if (!existsSync(checkpointDir)) {
        mkdirSync(checkpointDir, { recursive: true });
    }

    const checkpointPath = join(checkpointDir, `checkpoint-${questionId}-${runId}.json`);
    let checkpoint: QuestionCheckpoint;

    if (existsSync(checkpointPath)) {
        checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8'));
    } else {
        // Initialize checkpoint
        const numberOfSessions = Math.min(haystackDates.length, haystackSessions.length);
        checkpoint = {
            questionId,
            runId,
            containerTag,
            sessions: []
        };

        for (let i = 0; i < numberOfSessions; i++) {
            checkpoint.sessions.push({
                index: i,
                date: haystackDates[i],
                ingested: false
            });
        }
    }

    // Get provider from registry
    const registry = getProviderRegistry();
    const provider = await registry.getProvider(providerName);
    await provider.initialize();

    // Ingest each session
    const numberOfSessions = checkpoint.sessions.length;
    let sessionSuccessCount = 0;

    for (let i = 0; i < numberOfSessions; i++) {
        const session = checkpoint.sessions[i];
        if (!session) continue;

        if (session.ingested) {
            sessionSuccessCount++;
            continue;
        }

        try {
            // Format the session content
            const sessionStr = JSON.stringify(haystackSessions[i])
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');

            const content = `Here is the date the following session took place: ${JSON.stringify(haystackDates[i])}

Here is the session as a stringified JSON:
${sessionStr}`;

            // Ingest using provider
            await provider.ingest(content, containerTag);

            // Mark as successfully ingested
            session.ingested = true;
            session.timestamp = new Date().toISOString();
            sessionSuccessCount++;

            // Save checkpoint after each session
            writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));

            // Wait between sessions
            if (i < numberOfSessions - 1) {
                await new Promise(resolve => setTimeout(resolve, 10000));
            }
        } catch (error) {
            session.error = error instanceof Error ? error.message : String(error);
            writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));
            throw new Error(`Failed at session ${i + 1}/${numberOfSessions}: ${session.error}`);
        }
    }

    if (sessionSuccessCount !== numberOfSessions) {
        throw new Error(`Only ${sessionSuccessCount}/${numberOfSessions} sessions ingested`);
    }
}
