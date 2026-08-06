import type { Benchmark } from "../../types/benchmark"
import type { AnswerPhaseCheckpoint, RunCheckpoint } from "../../types/checkpoint"
import type { Judge } from "../../types/judge"
import type { Provider } from "../../types/provider"
import { resolveConcurrency } from "../../types/concurrency"
import { logger } from "../../utils/logger"
import { CheckpointManager } from "../checkpoint"
import { ConcurrentExecutor } from "../concurrent"
import { JudgeEvaluationRuntime } from "../evaluation-runtime"
import { calculateProtocolRetrievalMetrics } from "./retrieval-eval"

export function hasEvaluableAnswer(answer: AnswerPhaseCheckpoint | undefined): boolean {
  if (!answer || answer.status !== "completed" || typeof answer.hypothesis !== "string") {
    return false
  }
  return (
    answer.hypothesis.trim().length > 0 ||
    (answer.hypothesis === "" && answer.terminalEmptyAccepted === true)
  )
}

export async function runEvaluatePhase(
  judge: Judge,
  benchmark: Benchmark,
  checkpoint: RunCheckpoint,
  checkpointManager: CheckpointManager,
  questionIds?: string[],
  provider?: Provider
): Promise<void> {
  const questions = benchmark.getQuestions()
  const targetQuestions = questionIds
    ? questions.filter((question) => questionIds.includes(question.questionId))
    : questions
  const pendingQuestions = targetQuestions.filter((question) => {
    const phases = checkpoint.questions[question.questionId]?.phases
    return phases?.evaluate.status !== "completed" && hasEvaluableAnswer(phases?.answer)
  })

  if (pendingQuestions.length === 0) {
    logger.info("No questions pending evaluation")
    return
  }

  const concurrency = resolveConcurrency("evaluate", checkpoint.concurrency, provider?.concurrency)
  logger.info(
    `Evaluating ${pendingQuestions.length} questions with ${judge.name} (concurrency: ${concurrency})...`
  )

  await ConcurrentExecutor.execute(
    pendingQuestions,
    concurrency,
    checkpoint.runId,
    "evaluate",
    async ({ item: question, index, total }) => {
      const questionCheckpoint = checkpoint.questions[question.questionId]
      const hypothesis = questionCheckpoint.phases.answer.hypothesis
      if (typeof hypothesis !== "string") {
        throw new Error(`Missing completed hypothesis for ${question.questionId}`)
      }
      const search = questionCheckpoint.phases.search
      if (!search.retrievalPlan)
        throw new Error(`Missing retrieval plan for ${question.questionId}`)
      const results = search.results || []
      const startedAt = new Date().toISOString()
      const startedMs = Date.now()
      checkpointManager.updatePhase(checkpoint, question.questionId, "evaluate", {
        status: "in_progress",
        startedAt,
        costUsd: null,
        error: undefined,
      })
      await checkpointManager.flush(checkpoint.runId)
      const runtime = new JudgeEvaluationRuntime(judge)

      try {
        const evaluation = await benchmark.protocol.evaluateQuestion(
          {
            question,
            hypothesis,
            results,
            retrieval: search.retrievalPlan,
            providerPrompts: provider?.prompts,
            protocolProgress: questionCheckpoint.phases.evaluate.protocolProgress,
            onProtocolProgress: async (protocolProgress) => {
              checkpointManager.updatePhase(checkpoint, question.questionId, "evaluate", {
                protocolProgress,
              })
              await checkpointManager.flush(checkpoint.runId)
            },
          },
          runtime
        )
        const retrievalMetrics = await calculateProtocolRetrievalMetrics(
          benchmark.protocol.auxiliaryRetrievalEvaluation,
          runtime,
          question.question,
          question.groundTruth,
          results,
          search.retrievalPlan.answerCutoff
        )
        if (
          !Number.isFinite(evaluation.primaryScore) ||
          evaluation.primaryScore < 0 ||
          evaluation.primaryScore > 1
        ) {
          throw new Error(`Protocol returned invalid primary score ${evaluation.primaryScore}`)
        }

        const completedAt = new Date().toISOString()
        const durationMs = Date.now() - startedMs
        const passed = evaluation.passed
        checkpointManager.updatePhase(checkpoint, question.questionId, "evaluate", {
          status: "completed",
          evaluation,
          score: evaluation.primaryScore,
          label: passed ? "correct" : "incorrect",
          explanation: evaluation.explanation,
          details: {
            ...(evaluation.details || {}),
            ...(evaluation.metrics ? { protocolMetrics: evaluation.metrics } : {}),
          },
          ...(retrievalMetrics ? { retrievalMetrics } : {}),
          ...(runtime.getUsage?.() ? { usage: runtime.getUsage!() } : {}),
          completedAt,
          durationMs,
          error: undefined,
        })

        const retrievalInfo = retrievalMetrics
          ? ` | Hit@${retrievalMetrics.k}=${retrievalMetrics.hitAtK}, MRR=${retrievalMetrics.mrr.toFixed(2)}`
          : ""
        logger.progress(
          index + 1,
          total,
          `Evaluated ${question.questionId}: ${passed ? "pass" : "fail"} (${evaluation.primaryScore.toFixed(3)})${retrievalInfo} (${durationMs}ms)`
        )
        return { questionId: question.questionId, durationMs, passed }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        checkpointManager.updatePhase(checkpoint, question.questionId, "evaluate", {
          status: "failed",
          ...(runtime.getUsage?.() ? { usage: runtime.getUsage!() } : {}),
          error: message,
        })
        throw new Error(
          `Evaluate failed at ${question.questionId}: ${message}. Fix the issue and resume with the same run ID.`
        )
      }
    }
  )

  logger.success("Evaluate phase complete")
}
