import { expect, mock, test } from "bun:test"
import type { Benchmark } from "../../types/benchmark"
import type { Judge, JudgeInput, JudgeResult } from "../../types/judge"
import type { UnifiedQuestion } from "../../types/unified"
import { CheckpointManager } from "../checkpoint"
import { runEvaluatePhase } from "./evaluate"
import { generateReport } from "./report"

class InMemoryCheckpointManager extends CheckpointManager {
  override save(): void {}
}

test("completed blank answers count as incorrect in the report", async () => {
  const questions: UnifiedQuestion[] = ["blank", "whitespace", "answered", "pending"].map(
    (questionId) => ({
      questionId,
      question: "Which city?",
      groundTruth: "Paris",
      questionType: "example",
      haystackSessionIds: [],
    })
  )
  const benchmark: Benchmark = {
    name: "fixture",
    async load() {},
    getQuestions: () => questions,
    getHaystackSessions: () => [],
    getGroundTruth: () => "Paris",
    getQuestionTypes: () => ({}),
  }
  const manager = new InMemoryCheckpointManager()
  const checkpoint = manager.create("fixture", "fixture", "fixture", "fixture", "fixture")
  for (const question of questions) {
    manager.initQuestion(checkpoint, question.questionId, question.questionId, question)
  }
  for (const [questionId, hypothesis] of Object.entries({
    blank: "",
    whitespace: " \n",
    answered: "Paris",
  })) {
    manager.updatePhase(checkpoint, questionId, "search", { status: "completed", results: [] })
    manager.updatePhase(checkpoint, questionId, "answer", { status: "completed", hypothesis })
  }

  const evaluate = mock(
    async (_input: JudgeInput): Promise<JudgeResult> => ({
      score: 1,
      label: "correct",
      explanation: "",
    })
  )
  const judge: Judge = {
    name: "fixture",
    async initialize() {},
    evaluate,
    getPromptForQuestionType: () => "",
    getModel: () => "fixture/model",
  }

  await runEvaluatePhase(judge, benchmark, checkpoint, manager)

  expect(evaluate).toHaveBeenCalledTimes(1)
  expect(evaluate.mock.calls[0][0].hypothesis).toBe("Paris")
  for (const id of ["blank", "whitespace"]) {
    expect(checkpoint.questions[id].phases.evaluate).toMatchObject({
      status: "completed",
      score: 0,
      label: "incorrect",
    })
  }
  expect(checkpoint.questions.pending.phases.evaluate.status).toBe("pending")
  expect(generateReport(benchmark, checkpoint).summary).toMatchObject({
    totalQuestions: 3,
    correctCount: 1,
    accuracy: 1 / 3,
  })
})
