import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from "fs"
import { join } from "path"
import type { Benchmark, BenchmarkConfig, QuestionFilter } from "../../types/benchmark"
import type {
  UnifiedQuestion,
  UnifiedSession,
  UnifiedMessage,
  QuestionTypeRegistry,
} from "../../types/unified"
import { logger } from "../../utils/logger"

const DEFAULT_DATA_PATH = "./data/benchmarks/convomem"
const HF_BASE_URL =
  "https://huggingface.co/datasets/Salesforce/ConvoMem/resolve/main/core_benchmark/pre_mixed_testcases"

interface ConvoMemEvidence {
  question: string
  answer: string
  message_evidences: { speaker: string; text: string }[]
  conversations: { messages: { speaker: string; text: string }[] }[]
}

interface PreMixedTestCase {
  evidenceItems: ConvoMemEvidence[]
}

// Categories and their evidence subfolders (all use 1_evidence format)
const EVIDENCE_CATEGORIES: Record<string, string[]> = {
  user_evidence: ["1_evidence"],
  assistant_facts_evidence: ["1_evidence"],
  changing_evidence: ["2_evidence"],
  abstention_evidence: ["1_evidence"],
  preference_evidence: ["1_evidence"],
  implicit_connection_evidence: ["1_evidence"],
}

/**
 * ConvoMem question types - native evidence category types from the dataset.
 */
export const CONVOMEM_QUESTION_TYPES: QuestionTypeRegistry = {
  user_evidence: { id: "user_evidence", alias: "user", description: "User-stated facts" },
  assistant_facts_evidence: {
    id: "assistant_facts_evidence",
    alias: "asst",
    description: "Assistant-stated facts",
  },
  preference_evidence: {
    id: "preference_evidence",
    alias: "pref",
    description: "User preferences",
  },
  changing_evidence: {
    id: "changing_evidence",
    alias: "change",
    description: "Information updates",
  },
  implicit_connection_evidence: {
    id: "implicit_connection_evidence",
    alias: "implicit",
    description: "Implicit reasoning",
  },
  abstention_evidence: {
    id: "abstention_evidence",
    alias: "abstain",
    description: "Abstention (unanswerable)",
  },
}

export class ConvoMemBenchmark implements Benchmark {
  name = "convomem"
  private questions: UnifiedQuestion[] = []
  private sessionsMap: Map<string, UnifiedSession[]> = new Map()
  private dataPath: string = ""

  async load(config?: BenchmarkConfig): Promise<void> {
    this.dataPath = config?.dataPath || DEFAULT_DATA_PATH
    const fullPath = join(process.cwd(), this.dataPath)

    if (!existsSync(fullPath)) {
      mkdirSync(fullPath, { recursive: true })
    }

    const dataFile = join(fullPath, "convomem_data.json")
    if (!existsSync(dataFile)) {
      logger.info("Downloading ConvoMem dataset from HuggingFace...")
      await this.downloadDataset(fullPath, dataFile)
    }

    this.loadQuestions(dataFile)
  }

  private async downloadDataset(fullPath: string, dataFile: string): Promise<void> {
    const allItems: { category: string; item: ConvoMemEvidence }[] = []

    // Calculate total downloads for progress
    const totalDownloads = Object.entries(EVIDENCE_CATEGORIES).reduce(
      (sum, [_, subfolders]) => sum + subfolders.length,
      0
    )
    let completed = 0

    for (const [category, subfolders] of Object.entries(EVIDENCE_CATEGORIES)) {
      for (const subfolder of subfolders) {
        const url = `${HF_BASE_URL}/${category}/${subfolder}/batched_000.json`

        try {
          logger.progress(completed, totalDownloads, `Downloading ${category}/${subfolder}`)

          const response = await fetch(url, { redirect: "follow" })

          if (!response.ok) {
            logger.warn(`Failed to fetch ${category}/${subfolder}: ${response.status}`)
            completed++
            continue
          }

          const data: PreMixedTestCase[] = await response.json()

          // Extract evidence items from batched format
          for (const testCase of data) {
            if (testCase.evidenceItems) {
              for (const item of testCase.evidenceItems) {
                allItems.push({ category, item })
              }
            }
          }

          completed++
          logger.progress(completed, totalDownloads, `Downloaded ${category}/${subfolder}`)
        } catch (e) {
          logger.warn(`Error fetching ${category}/${subfolder}: ${e}`)
          completed++
        }
      }
    }

    // Save all items to a single file
    writeFileSync(dataFile, JSON.stringify(allItems, null, 2))
    logger.success(`Downloaded ConvoMem dataset (${allItems.length} items)`)
  }

  private loadQuestions(dataFile: string): void {
    try {
      const content = readFileSync(dataFile, "utf8")
      const items: { category: string; item: ConvoMemEvidence }[] = JSON.parse(content)

      for (let i = 0; i < items.length; i++) {
        const { category, item } = items[i]
        this.processItem(item, category, i)
      }

      logger.info(`Loaded ${this.questions.length} questions from ConvoMem`)
    } catch (e) {
      logger.error(`Failed to load ConvoMem data: ${e}`)
    }
  }

  private processItem(item: ConvoMemEvidence, category: string, index: number): void {
    const questionId = `convomem-${category}-${index}`

    const sessions = this.extractSessions(item, questionId)
    const sessionIds = sessions.map((s) => s.sessionId)

    this.questions.push({
      questionId,
      question: item.question,
      questionType: category,
      groundTruth: item.answer,
      haystackSessionIds: sessionIds,
      metadata: {
        evidences: item.message_evidences,
      },
    })

    this.sessionsMap.set(questionId, sessions)
  }

  private extractSessions(item: ConvoMemEvidence, questionId: string): UnifiedSession[] {
    const sessions: UnifiedSession[] = []

    if (!item.conversations) return sessions

    for (let i = 0; i < item.conversations.length; i++) {
      const conv = item.conversations[i]
      const unifiedMessages: UnifiedMessage[] = conv.messages.map((m) => ({
        role: m.speaker.toLowerCase() === "user" ? ("user" as const) : ("assistant" as const),
        content: m.text,
      }))

      sessions.push({
        sessionId: `${questionId}-session-${i}`,
        messages: unifiedMessages,
      })
    }

    return sessions
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
    return CONVOMEM_QUESTION_TYPES
  }
}

export default ConvoMemBenchmark
