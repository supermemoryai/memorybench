/**
 * Ingestion module for LoCoMo benchmark
 * Handles uploading conversation sessions to memory providers
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { LoCoMoBenchmarkItem, sessionItem } from '../types';
import { getProviderRegistry } from '../../../core/providers/ProviderRegistry';
import type { BaseProvider } from '../../../core/providers/BaseProvider';

interface IngestOptions {
    startPosition?: number;
    endPosition?: number;
    sessionDelay?: number;
}

interface SessionCheckpoint {
    sessionId: string;
    dateTime: string;
    ingested: boolean;
    timestamp?: string;
    error?: string;
}

interface SampleCheckpoint {
    sampleId: string;
    runId: string;
    containerTag: string;
    sessions: SessionCheckpoint[];
}

export async function ingestAllSamples(
    providerName: string,
    runId: string,
    options?: IngestOptions
) {
    console.log(`[LoCoMo] Ingesting conversation samples...`);
    console.log(`Provider: ${providerName}`);
    console.log(`Run ID: ${runId}`);
    console.log('');

    const dataPath = join(process.cwd(), 'benchmarks/LoCoMo/locomo10.json');
    const allSamples: LoCoMoBenchmarkItem[] = JSON.parse(readFileSync(dataPath, 'utf8'));

    console.log(`Found ${allSamples.length} samples in dataset`);

    // Apply position filtering if provided
    let samplesToProcess = allSamples;
    if (options?.startPosition && options?.endPosition) {
        const start = options.startPosition - 1;
        const end = options.endPosition;
        samplesToProcess = allSamples.slice(start, end);
        console.log(`Processing positions ${options.startPosition}-${options.endPosition}: ${samplesToProcess.length} samples`);
    }

    console.log('');

    // Get provider from registry
    const registry = getProviderRegistry();
    const provider = await registry.getProvider(providerName);
    await provider.initialize();
    let successCount = 0;
    let failedCount = 0;

    for (let i = 0; i < samplesToProcess.length; i++) {
        const sample = samplesToProcess[i];
        const sampleId = sample.sample_id;

        console.log(`[${i + 1}/${samplesToProcess.length}] Processing ${sampleId}...`);

        try {
            await ingestSingleSample(sample, runId, provider, options);
            successCount++;
            console.log(`  ✓ Success`);

            if (i < samplesToProcess.length - 1) {
                await new Promise(resolve => setTimeout(resolve, options?.sessionDelay || 2000));
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
    console.log(`  Total: ${samplesToProcess.length}`);
    console.log('');
}

async function ingestSingleSample(
    sample: LoCoMoBenchmarkItem,
    runId: string,
    provider: BaseProvider,
    options?: IngestOptions
) {
    const sampleId = sample.sample_id;
    const containerTag = `${sampleId}-${runId}`;
    const conversation = sample.conversation;

    // Setup checkpoint
    const checkpointDir = join(process.cwd(), 'results', runId, 'checkpoints', 'ingest');
    if (!existsSync(checkpointDir)) {
        mkdirSync(checkpointDir, { recursive: true });
    }

    const checkpointPath = join(checkpointDir, `checkpoint-${sampleId}-${runId}.json`);
    let checkpoint: SampleCheckpoint;

    if (existsSync(checkpointPath)) {
        checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8'));
    } else {
        // Create new checkpoint with all sessions
        checkpoint = {
            sampleId,
            runId,
            containerTag,
            sessions: []
        };

        // Extract all sessions from conversation object
        const sessionKeys = Object.keys(conversation).filter(key => key.startsWith('session_') && !key.endsWith('_date_time'));

        for (const sessionKey of sessionKeys) {
            const dateTimeKey = `${sessionKey}_date_time`;
            const dateTime = conversation[dateTimeKey] as string || '';

            checkpoint.sessions.push({
                sessionId: sessionKey,
                dateTime,
                ingested: false
            });
        }
    }

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
            const sessionData = conversation[session.sessionId] as sessionItem[];
            if (!sessionData || sessionData.length === 0) {
                // Skip empty sessions
                session.ingested = true;
                session.timestamp = new Date().toISOString();
                sessionSuccessCount++;
                writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));
                continue;
            }

            // Format the session for ingestion
            const speakerA = conversation.speaker_a as string;
            const speakerB = conversation.speaker_b as string;
            const dateTime = session.dateTime;

            // Build conversation text
            let conversationText = `Session Date/Time: ${dateTime}\n\n`;
            conversationText += `Participants: ${speakerA} and ${speakerB}\n\n`;
            conversationText += `Conversation:\n`;

            for (const message of sessionData) {
                conversationText += `${message.speaker}: ${message.text}\n`;
                if (message.img_url && message.img_url.length > 0) {
                    conversationText += `  [Image: ${message.img_url.join(', ')}]\n`;
                }
                if (message.blip_caption) {
                    conversationText += `  [Image caption: ${message.blip_caption}]\n`;
                }
            }

            const content = `Here is a conversation session that took place on ${dateTime}:\n\n${conversationText}`;

            console.log(`  Ingesting session ${i + 1}/${numberOfSessions}: ${session.sessionId} (${content.length} bytes)...`);
            await provider.ingest(content, containerTag);

            session.ingested = true;
            session.timestamp = new Date().toISOString();
            sessionSuccessCount++;

            writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));

            if (i < numberOfSessions - 1) {
                await new Promise(resolve => setTimeout(resolve, options?.sessionDelay || 10000));
            }
        } catch (error) {
            session.error = error instanceof Error ? error.message : String(error);
            writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));
            console.error(`  ✗ Failed: ${session.error}`);
            
            // For fullcontext provider, this is often a 500 error due to content issues
            // Log but continue with next session instead of failing entire run
            if (error instanceof Error && error.message.includes('500')) {
                console.warn(`  ⚠ Server error - skipping session ${i + 1}/${numberOfSessions}, continuing with next session`);
                // Don't increment success count, but don't throw either
                continue;
            }
            
            // For other errors, throw to stop
            throw new Error(`Failed at session ${i + 1}/${numberOfSessions}: ${session.error}`);
        }
    }

    if (sessionSuccessCount !== numberOfSessions) {
        throw new Error(`Only ${sessionSuccessCount}/${numberOfSessions} sessions ingested`);
    }
}
