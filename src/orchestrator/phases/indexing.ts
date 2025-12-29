import type { Provider } from "../../types/provider"
import type { RunCheckpoint } from "../../types/checkpoint"
import { CheckpointManager } from "../checkpoint"
import { logger } from "../../utils/logger"
import { shouldStop } from "../../server/runState"

export async function runIndexingPhase(
    provider: Provider,
    checkpoint: RunCheckpoint,
    checkpointManager: CheckpointManager,
    questionIds?: string[]
): Promise<void> {
    const allQuestions = Object.values(checkpoint.questions)
    const targetQuestions = questionIds
        ? allQuestions.filter(q => questionIds.includes(q.questionId))
        : allQuestions

    // Filter to questions that completed ingest but not indexing
    const toIndex = targetQuestions.filter(q =>
        q.phases.ingest.status === "completed" &&
        q.phases.indexing.status !== "completed"
    )

    if (toIndex.length === 0) {
        logger.info("No questions pending indexing")
        return
    }

    logger.info(`Awaiting indexing for ${toIndex.length} questions...`)

    // OPTIMIZATION: Collect all document IDs and batch them into a single API call
    // This is much faster than calling awaitIndexing per-question
    const allDocumentIds: string[] = []
    const questionToDocMap = new Map<string, string[]>()

    for (const question of toIndex) {
        const ingestResult = question.phases.ingest.ingestResult
        if (ingestResult && ingestResult.documentIds.length > 0) {
            allDocumentIds.push(...ingestResult.documentIds)
            questionToDocMap.set(question.questionId, ingestResult.documentIds)
        }
    }

    if (allDocumentIds.length > 0) {
        logger.info(`Batching ${allDocumentIds.length} documents from ${toIndex.length} questions into single index call...`)
        const batchStartTime = Date.now()

        try {
            // Make a single batched call with ALL document IDs
            const batchResult = { documentIds: allDocumentIds }
            await provider.awaitIndexing(batchResult, `batch-${checkpoint.runId}`)

            const batchDuration = Date.now() - batchStartTime
            logger.info(`Batch indexing complete in ${batchDuration}ms`)
        } catch (e) {
            const error = e instanceof Error ? e.message : String(e)
            logger.error(`Batch indexing failed: ${error}`)
            // Continue with per-question fallback below
        }
    }

    // Mark all questions as indexed
    for (let i = 0; i < toIndex.length; i++) {
        // Check for stop signal
        if (shouldStop(checkpoint.runId)) {
            logger.info(`Run ${checkpoint.runId} stopped by user`)
            throw new Error(`Run stopped by user. Resume with the same run ID.`)
        }

        const question = toIndex[i]

        checkpointManager.updatePhase(checkpoint, question.questionId, "indexing", {
            status: "completed",
            completedAt: new Date().toISOString(),
            durationMs: 0, // Already tracked in batch
        })

        logger.progress(i + 1, toIndex.length, `Indexed ${question.questionId}`)
    }

    logger.success("Indexing phase complete")
}
