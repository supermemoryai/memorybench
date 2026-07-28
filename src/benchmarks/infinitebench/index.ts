import { existsSync, readFileSync } from "fs"
import { join } from "path"

import type { Benchmark, BenchmarkConfig, QuestionFilter } from "../../types/benchmark"
import type {
  UnifiedMessage,
  UnifiedQuestion,
  UnifiedSession,
  QuestionTypeRegistry,
} from "../../types/unified"

import type { InfiniteBenchItem } from "./types"
import { logger } from "../../utils/logger"

const DEFAULT_DATA_PATH = "./data/benchmarks/infinitebench"

const TASKS = [
  "passkey",
  "kv_retrieval",
  "number_string",
  "code_run",
  "code_debug",
  "math_find",
  "math_calc",
  "longdialogue_qa_eng",
  "longbook_qa_eng",
  "longbook_sum_eng",
  "longbook_choice_eng",
  "longbook_qa_chn",
] as const

type InfiniteBenchTask = (typeof TASKS)[number]

export const INFINITEBENCH_QUESTION_TYPES: QuestionTypeRegistry = Object.fromEntries(
  TASKS.map((task) => [
    task,
    {
      id: task,
      alias: task,
      description: `InfiniteBench ${task} task`,
    },
  ])
)

export class InfiniteBenchBenchmark implements Benchmark {
  name = "infinitebench"

  private questions: UnifiedQuestion[] = []
  private sessions: Map<string, UnifiedSession[]> = new Map()

  private dataPath = DEFAULT_DATA_PATH

  async load(config?: BenchmarkConfig): Promise<void> {
    this.dataPath = config?.dataPath ?? DEFAULT_DATA_PATH

    const datasetPath = join(process.cwd(), this.dataPath)

    if (!existsSync(datasetPath)) {
      throw new Error(`InfiniteBench dataset missing: ${datasetPath}`)
    }

    this.loadDataset(datasetPath)
  }

  private loadDataset(datasetPath: string): void {
    for (const task of TASKS) {
      const file = join(datasetPath, `${task}.jsonl`)

      if (!existsSync(file)) {
        logger.warn(`Skipping missing task file: ${file}`)
        continue
      }

      const rows = readFileSync(file, "utf-8").split("\n").filter(Boolean)

      for (const row of rows) {
        try {
          const item: InfiniteBenchItem = JSON.parse(row)

          this.addQuestion(item, task)
        } catch (error) {
          logger.error(`Failed parsing ${file}: ${error}`)
        }
      }
    }

    logger.info(`Loaded ${this.questions.length} InfiniteBench questions`)
  }

  private addQuestion(item: InfiniteBenchItem, task: InfiniteBenchTask): void {
    const questionId = `infinitebench-${task}-${item.id}`

    const session = this.createSession(item.context, questionId)

    const question: UnifiedQuestion = {
      questionId,

      question: item.input,

      questionType: task,

      groundTruth: item.answer.at(0) ?? "",

      haystackSessionIds: [session.sessionId],

      metadata: {
        task,
        options: item.options,
      },
    }

    this.questions.push(question)

    this.sessions.set(questionId, [session])
  }

  private createSession(context: string, questionId: string): UnifiedSession {
    const message: UnifiedMessage = {
      role: "user",

      content: context,
    }

    return {
      sessionId: `${questionId}-session`,

      messages: [message],
    }
  }

  getQuestions(filter?: QuestionFilter): UnifiedQuestion[] {
    let result = this.questions

    if (filter?.questionTypes?.length) {
      result = result.filter((q) => filter.questionTypes!.includes(q.questionType))
    }

    if (filter?.offset) {
      result = result.slice(filter.offset)
    }

    if (filter?.limit) {
      result = result.slice(0, filter.limit)
    }

    return result
  }

  getHaystackSessions(questionId: string): UnifiedSession[] {
    return this.sessions.get(questionId) ?? []
  }

  getGroundTruth(questionId: string): string {
    return this.questions.find((q) => q.questionId === questionId)?.groundTruth ?? ""
  }

  getQuestionTypes(): QuestionTypeRegistry {
    return INFINITEBENCH_QUESTION_TYPES
  }
}

export default InfiniteBenchBenchmark