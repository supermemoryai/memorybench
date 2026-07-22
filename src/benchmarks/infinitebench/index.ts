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

export const INFINITEBENCH_QUESTION_TYPES: QuestionTypeRegistry = {
  passkey: {
    id: "passkey",
    alias: "passkey",
    description: "Synthetic passkey retrieval",
  },
  kv_retrieval: {
    id: "kv_retrieval",
    alias: "kv",
    description: "Key-value retrieval",
  },
  number_string: {
    id: "number_string",
    alias: "number-string",
    description: "Number string retrieval",
  },
  code_run: {
    id: "code_run",
    alias: "code-run",
    description: "Code execution",
  },
  code_debug: {
    id: "code_debug",
    alias: "code-debug",
    description: "Code debugging",
  },
  math_find: {
    id: "math_find",
    alias: "math-find",
    description: "Mathematical search",
  },
  math_calc: {
    id: "math_calc",
    alias: "math-calc",
    description: "Mathematical calculation",
  },
  longdialogue_qa_eng: {
    id: "longdialogue_qa_eng",
    alias: "dialogue",
    description: "Long dialogue QA",
  },
  longbook_qa_eng: {
    id: "longbook_qa_eng",
    alias: "book-qa",
    description: "Long book question answering",
  },
  longbook_sum_eng: {
    id: "longbook_sum_eng",
    alias: "book-summary",
    description: "Long book summarization",
  },
  longbook_choice_eng: {
    id: "longbook_choice_eng",
    alias: "book-choice",
    description: "Long book multiple choice",
  },
  longbook_qa_chn: {
    id: "longbook_qa_chn",
    alias: "book-qa-zh",
    description: "Chinese long book QA",
  },
}

export class InfiniteBenchBenchmark implements Benchmark {
  name = "infinitebench"

  private questions: UnifiedQuestion[] = []
  private sessionsMap: Map<string, UnifiedSession[]> = new Map()
  private dataPath = ""

  async load(config?: BenchmarkConfig): Promise<void> {
    this.dataPath = config?.dataPath || DEFAULT_DATA_PATH

    const fullPath = join(process.cwd(), this.dataPath)

    if (!existsSync(fullPath)) {
      throw new Error(
        `InfiniteBench dataset not found at ${fullPath}. Download it from https://huggingface.co/datasets/xinrongzhang2022/InfiniteBench and place the JSONL files under ${this.dataPath}.`
      )
    }

    this.loadQuestions(fullPath)
  }

  private loadQuestions(fullPath: string): void {
    for (const task of TASKS) {
      const filePath = join(fullPath, `${task}.jsonl`)

      if (!existsSync(filePath)) {
        logger.warn(`Missing file for ${task}: ${filePath}`)
        continue
      }

      let loaded = 0

      try {
        const lines = readFileSync(filePath, "utf8").split("\n").filter(Boolean)

        for (const line of lines) {
          try {
            const item: InfiniteBenchItem = JSON.parse(line)
            this.processItem(item, task)
            loaded++
          } catch (err) {
            logger.warn(`Skipping malformed record in ${task}: ${err}`)
          }
        }

        logger.info(`Loaded ${loaded} ${task} questions`)
      } catch (error) {
        logger.error(`Failed to load ${task}: ${error}`)
      }
    }

    logger.info(`Loaded ${this.questions.length} questions from InfiniteBench`)
  }

  private processItem(item: InfiniteBenchItem, task: InfiniteBenchTask): void {
    const questionId = `infinitebench-${task}-${String(item.id).padStart(6, "0")}`

    const session = this.createSession(item, questionId)

    this.questions.push({
      questionId,
      question: item.input,
      questionType: task,
      groundTruth: String(item.answer[0]),
      haystackSessionIds: [session.sessionId],
      metadata: {
        task,
        hasOptions: (item.options?.length ?? 0) > 0,
        answerCount: item.answer.length,
        options: item.options ?? [],
      },
    })

    this.sessionsMap.set(questionId, [session])
  }

  private createSession(item: InfiniteBenchItem, questionId: string): UnifiedSession {
    const message: UnifiedMessage = {
      role: "user",
      content: item.context,
    }

    return {
      sessionId: `${questionId}-session-0`,
      messages: [message],
    }
  }

  getQuestions(filter?: QuestionFilter): UnifiedQuestion[] {
    let result = [...this.questions]

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
    return this.sessionsMap.get(questionId) || []
  }

  getGroundTruth(questionId: string): string {
    const question = this.questions.find((q) => q.questionId === questionId)
    return question?.groundTruth ?? ""
  }

  getQuestionTypes(): QuestionTypeRegistry {
    return INFINITEBENCH_QUESTION_TYPES
  }
}

export default InfiniteBenchBenchmark