import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import type { Benchmark } from "../../types/benchmark"
import type { RunCheckpoint } from "../../types/checkpoint"
import type { Provider, ProviderSearchResponse } from "../../types/provider"
import { UNIFIED_SEARCH_RESULT_TYPES, type UnifiedSearchResult } from "../../types/unified"
import { resolveConcurrency } from "../../types/concurrency"
import { logger } from "../../utils/logger"
import { CheckpointManager } from "../checkpoint"
import { ConcurrentExecutor } from "../concurrent"

function validateProviderResults(
  results: UnifiedSearchResult[],
  provider: Pick<Provider, "name">,
  requestedTopK: number
): void {
  if (results.length > requestedTopK) {
    throw new Error(
      `${provider.name} returned ${results.length} results for requested Top-K ${requestedTopK}`
    )
  }
  const ranks = new Set<number>()
  for (const [index, result] of results.entries()) {
    if (!result.text.trim())
      throw new Error(`${provider.name} returned empty text at index ${index}`)
    if (!(UNIFIED_SEARCH_RESULT_TYPES as readonly string[]).includes(result.resultType)) {
      throw new Error(
        `${provider.name} returned unsupported result type ${JSON.stringify(result.resultType)} at index ${index}`
      )
    }
    if (result.provider !== provider.name) {
      throw new Error(
        `${provider.name} returned a result attributed to ${result.provider} at index ${index}`
      )
    }
    if (!Number.isInteger(result.rank) || result.rank < 1 || ranks.has(result.rank)) {
      throw new Error(`${provider.name} returned an invalid or duplicate rank at index ${index}`)
    }
    ranks.add(result.rank)
  }
}

export function validateProviderSearchResponse(
  response: ProviderSearchResponse,
  provider: Pick<Provider, "name" | "searchRequestStructure">,
  requestedTopK: number
): void {
  const { results, diagnostics } = response
  const inconsistent = (reason: string): never => {
    throw new Error(`${provider.name} returned inconsistent retrieval diagnostics: ${reason}`)
  }

  if (diagnostics.requestedLimit !== requestedTopK) {
    inconsistent(
      `adapter requestedLimit ${diagnostics.requestedLimit} does not equal benchmark Top-K ${requestedTopK}`
    )
  }

  for (const [index, request] of diagnostics.providerRequests.entries()) {
    if (!request.operation.trim()) inconsistent(`provider request ${index} has no operation`)
    if (!Number.isInteger(request.limit) || request.limit < 1) {
      inconsistent(`provider request ${index} has invalid limit ${request.limit}`)
    }
  }

  const providerRequestLimit = diagnostics.providerRequests.reduce(
    (sum, request) => sum + request.limit,
    0
  )
  if (provider.searchRequestStructure.kind === "single") {
    if (diagnostics.providerRequests.length !== 1) {
      inconsistent(
        `single-request adapter reported ${diagnostics.providerRequests.length} provider requests`
      )
    }
    if (diagnostics.providerRequests[0].limit !== requestedTopK) {
      inconsistent(
        `single provider request limit ${diagnostics.providerRequests[0].limit} does not equal benchmark Top-K ${requestedTopK}`
      )
    }
  } else if (providerRequestLimit !== requestedTopK) {
    inconsistent(
      `split provider request limits total ${providerRequestLimit}, expected benchmark Top-K ${requestedTopK}`
    )
  }

  const counts = [
    ["rawReturnedCount", diagnostics.rawReturnedCount],
    ["normalizedCount", diagnostics.normalizedCount],
    ["droppedCount", diagnostics.droppedCount],
  ] as const
  for (const [name, value] of counts) {
    if (!Number.isInteger(value) || value < 0) inconsistent(`${name} is invalid: ${value}`)
  }
  if (diagnostics.rawReturnedCount > requestedTopK) {
    inconsistent(
      `rawReturnedCount ${diagnostics.rawReturnedCount} exceeds benchmark Top-K ${requestedTopK}`
    )
  }
  if (diagnostics.normalizedCount !== results.length) {
    inconsistent(
      `normalizedCount ${diagnostics.normalizedCount} does not equal evidence count ${results.length}`
    )
  }
  if (diagnostics.droppedCount !== diagnostics.rawReturnedCount - diagnostics.normalizedCount) {
    inconsistent(
      `droppedCount ${diagnostics.droppedCount} does not equal raw minus normalized count`
    )
  }
  if (!Array.isArray(diagnostics.droppedResults)) {
    inconsistent("droppedResults is missing")
  }
  if (diagnostics.droppedResults.length !== diagnostics.droppedCount) {
    inconsistent(
      `recorded ${diagnostics.droppedResults.length} drop reasons for droppedCount ${diagnostics.droppedCount}`
    )
  }
  const droppedIndices = new Set<number>()
  for (const dropped of diagnostics.droppedResults) {
    if (
      !Number.isInteger(dropped.index) ||
      dropped.index < 0 ||
      dropped.index >= diagnostics.rawReturnedCount ||
      droppedIndices.has(dropped.index)
    ) {
      inconsistent(`invalid or duplicate dropped result index ${dropped.index}`)
    }
    droppedIndices.add(dropped.index)
  }

  validateProviderResults(results, provider, requestedTopK)
}

export async function runSearchPhase(
  provider: Provider,
  benchmark: Benchmark,
  checkpoint: RunCheckpoint,
  checkpointManager: CheckpointManager,
  questionIds?: string[]
): Promise<void> {
  const questions = benchmark.getQuestions()
  const targetQuestions = questionIds
    ? questions.filter((question) => questionIds.includes(question.questionId))
    : questions
  for (const question of targetQuestions) {
    const questionCheckpoint = checkpoint.questions[question.questionId]
    if (!questionCheckpoint) {
      throw new Error(`Question ${question.questionId} has no checkpoint record`)
    }
    const build = checkpoint.builds[questionCheckpoint.buildId]
    if (!build) {
      throw new Error(
        `Question ${question.questionId} references missing build ${questionCheckpoint.buildId}`
      )
    }
    if (build.ingest.status !== "completed") {
      throw new Error(
        `Question ${question.questionId} cannot search because build ${build.buildId} ingestion is ${build.ingest.status}`
      )
    }
    if (build.indexing.status !== "completed" || build.indexing.failedIds.length > 0) {
      throw new Error(
        `Question ${question.questionId} cannot search because build ${build.buildId} indexing is ${build.indexing.status}${build.indexing.failedIds.length > 0 ? ` with ${build.indexing.failedIds.length} failed IDs` : ""}`
      )
    }
  }
  const pendingQuestions = targetQuestions.filter((question) => {
    const questionCheckpoint = checkpoint.questions[question.questionId]
    return questionCheckpoint.phases.search.status !== "completed"
  })

  if (pendingQuestions.length === 0) {
    logger.info("No questions pending search")
    return
  }

  const resultsDir = checkpointManager.getResultsDir(checkpoint.runId)
  if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true })
  const concurrency = resolveConcurrency("search", checkpoint.concurrency, provider.concurrency)
  logger.info(`Searching ${pendingQuestions.length} questions (concurrency: ${concurrency})...`)

  await ConcurrentExecutor.execute(
    pendingQuestions,
    concurrency,
    checkpoint.runId,
    "search",
    async ({ item: question, index, total }) => {
      const questionCheckpoint = checkpoint.questions[question.questionId]
      const build = checkpoint.builds[questionCheckpoint.buildId]
      if (!build) throw new Error(`Question ${question.questionId} references missing build`)
      const retrievalPlan = benchmark.protocol.createRetrievalPlan({ question })
      if (
        !Number.isInteger(retrievalPlan.requestedTopK) ||
        retrievalPlan.requestedTopK < 1 ||
        retrievalPlan.requestedTopK > 100
      ) {
        throw new Error(`Invalid requestedTopK ${retrievalPlan.requestedTopK}`)
      }
      if (
        !Number.isInteger(retrievalPlan.answerCutoff) ||
        retrievalPlan.answerCutoff < 0 ||
        retrievalPlan.answerCutoff > retrievalPlan.requestedTopK
      ) {
        throw new Error(`Invalid answerCutoff ${retrievalPlan.answerCutoff}`)
      }

      const startedAt = new Date().toISOString()
      const startedMs = Date.now()
      checkpointManager.updatePhase(checkpoint, question.questionId, "search", {
        status: "in_progress",
        retrievalPlan,
        requestedCount: retrievalPlan.requestedTopK,
        answerCutoff: retrievalPlan.answerCutoff,
        startedAt,
        costUsd: null,
        error: undefined,
      })

      try {
        const response = await provider.search(retrievalPlan.query, {
          containerTag: build.containerTag,
          limit: retrievalPlan.requestedTopK,
          threshold: retrievalPlan.threshold,
          searchMode: retrievalPlan.searchMode,
          filters: retrievalPlan.filters,
        })
        const { results, diagnostics } = response
        validateProviderSearchResponse(response, provider, retrievalPlan.requestedTopK)

        const completedAt = new Date().toISOString()
        const durationMs = Date.now() - startedMs
        const resultFile = checkpointManager.getQuestionResultsPath(
          checkpoint.runId,
          question.questionId
        )
        const resultData = {
          benchmark: checkpoint.benchmark,
          benchmarkScope: checkpoint.benchmarkScope,
          datasetIdentity: checkpoint.datasetIdentity,
          benchmarkInputFingerprint: checkpoint.benchmarkInputFingerprint,
          selectedQuestionIdsDigest: checkpoint.selectedQuestionIdsDigest,
          questionId: question.questionId,
          question: question.question,
          questionType: question.questionType,
          groundTruth: question.groundTruth,
          buildId: build.buildId,
          containerTag: build.containerTag,
          protocolIdentity: checkpoint.protocolIdentity,
          retrievalPlan,
          requestedCount: retrievalPlan.requestedTopK,
          rawReturnedCount: diagnostics.rawReturnedCount,
          returnedCount: diagnostics.normalizedCount,
          normalizedCount: diagnostics.normalizedCount,
          droppedCount: diagnostics.droppedCount,
          droppedResults: diagnostics.droppedResults,
          providerRequests: diagnostics.providerRequests,
          timestamp: completedAt,
          durationMs,
          results,
        }
        writeFileSync(resultFile, JSON.stringify(resultData, null, 2))
        checkpointManager.updatePhase(checkpoint, question.questionId, "search", {
          status: "completed",
          resultFile,
          results,
          rawReturnedCount: diagnostics.rawReturnedCount,
          returnedCount: diagnostics.normalizedCount,
          normalizedCount: diagnostics.normalizedCount,
          droppedCount: diagnostics.droppedCount,
          droppedResults: diagnostics.droppedResults,
          providerRequests: diagnostics.providerRequests,
          completedAt,
          durationMs,
          error: undefined,
        })
        logger.progress(
          index + 1,
          total,
          `Searched ${question.questionId}: ${results.length}/${retrievalPlan.requestedTopK} (${durationMs}ms)`
        )
        return { questionId: question.questionId, durationMs }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        checkpointManager.updatePhase(checkpoint, question.questionId, "search", {
          status: "failed",
          error: message,
        })
        throw new Error(
          `Search failed at ${question.questionId}: ${message}. Fix the issue and resume with the same run ID.`
        )
      }
    }
  )

  logger.success("Search phase complete")
}
