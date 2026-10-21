import { existsSync, readFileSync } from "fs"
import { join } from "path"
import type { Benchmark, BenchmarkConfig, QuestionFilter } from "../../types/benchmark"
import type {
  UnifiedQuestion,
  UnifiedSession,
  UnifiedMessage,
  QuestionTypeRegistry,
} from "../../types/unified"
import type { BABILongItem } from "./types"
import { logger } from "../../utils/logger"

const DEFAULT_DATA_PATH = "./data/benchmarks/babilong"
const DEFAULT_CONTEXT_LENGTH = "0k"

// qa subfolders (all use 0k format)
const QA_FOLDERS = Array.from({ length: 20 }, (_, i) => `qa${i + 1}`)

/**
 * BABILong question types - native task types from the dataset.
 */
export const BABILONG_QUESTION_TYPES: QuestionTypeRegistry = {
  qa1: { id: "qa1", alias: "single", description: "Single supporting fact" },
  qa2: { id: "qa2", alias: "two", description: "Two supporting facts" },
  qa3: { id: "qa3", alias: "three", description: "Three supporting facts" },
  qa4: { id: "qa4", alias: "two-arg", description: "Two argument relations" },
  qa5: { id: "qa5", alias: "three-arg", description: "Three argument relations" },
  qa6: { id: "qa6", alias: "yes-no", description: "Yes/no questions" },
  qa7: { id: "qa7", alias: "counting", description: "Counting" },
  qa8: { id: "qa8", alias: "lists-sets", description: "Lists/sets" },
  qa9: { id: "qa9", alias: "simple-neg", description: "Simple negation" },
  qa10: { id: "qa10", alias: "indef-know", description: "Indefinite knowledge" },
  qa11: { id: "qa11", alias: "basic-coref", description: "Basic coreference" },
  qa12: { id: "qa12", alias: "conjunction", description: "Conjunction" },
  qa13: { id: "qa13", alias: "compound-coref", description: "Compound coreference" },
  qa14: { id: "qa14", alias: "time-reasoning", description: "Time reasoning" },
  qa15: { id: "qa15", alias: "basic-deduction", description: "Basic deduction" },
  qa16: { id: "qa16", alias: "basic-induction", description: "Basic induction" },
  qa17: { id: "qa17", alias: "positional-reasoning", description: "Positional reasoning" },
  qa18: { id: "qa18", alias: "size-reasoning", description: "Size reasoning" },
  qa19: { id: "qa19", alias: "path-finding", description: "Path finding" },
  qa20: { id: "qa20", alias: "qa20", description: "Task 20" },
}

export class BABILongBenchmark implements Benchmark {
  name = "babilong"

  private questions: UnifiedQuestion[] = []
  private sessionsMap: Map<string, UnifiedSession[]> = new Map()
  private dataPath: string = ""

  async load(config?: BenchmarkConfig): Promise<void> {
    this.dataPath = config?.dataPath || DEFAULT_DATA_PATH
    const fullPath = join(process.cwd(), this.dataPath)

    if (!existsSync(fullPath)) {
      throw new Error(
        `BABILong dataset not found at ${fullPath}. Download the dataset from https://huggingface.co/datasets/RMT-team/babilong and place the qa1-qa20 folders under ${this.dataPath}.`
      )
    }

    this.loadQuestions(fullPath)
  }

  private loadQuestions(fullPath: string): void {
    for (const qaFolder of QA_FOLDERS) {
      const filePath = join(fullPath, qaFolder, `${DEFAULT_CONTEXT_LENGTH}.json`)

      if (!existsSync(filePath)) {
        logger.warn(`Missing file for ${qaFolder}: ${filePath}`)
        continue
      }

      try {
        const content = readFileSync(filePath, "utf8")
        const items: BABILongItem[] = JSON.parse(content)

        for (let i = 0; i < items.length; i++) {
          this.processItem(items[i], qaFolder, i)
        }
      } catch (e) {
        logger.error(`Failed to load BABILong data for ${qaFolder}: ${e}`)
      }
    }

    logger.info(`Loaded ${this.questions.length} questions from BABILong`)
  }

  private processItem(item: BABILongItem, qaFolder: string, index: number): void {
    const questionId = `babilong-${qaFolder}-${String(index).padStart(3, "0")}`

    const session = this.extractSession(item, questionId)

    this.questions.push({
      questionId,
      question: item.question,
      questionType: qaFolder,
      groundTruth: item.target,
      haystackSessionIds: [session.sessionId],
      metadata: {
        task: qaFolder,
        contextLength: DEFAULT_CONTEXT_LENGTH,
      },
    })

    this.sessionsMap.set(questionId, [session])
  }

  private extractSession(item: BABILongItem, questionId: string): UnifiedSession {
    const message: UnifiedMessage = {
      role: "user",
      content: item.input,
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
    return question?.groundTruth || ""
  }

  getQuestionTypes(): QuestionTypeRegistry {
    return BABILONG_QUESTION_TYPES
  }
}

export default BABILongBenchmark