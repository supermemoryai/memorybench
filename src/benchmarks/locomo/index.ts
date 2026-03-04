import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import type { Benchmark, BenchmarkConfig, QuestionFilter } from "../../types/benchmark"
import type {
  UnifiedQuestion,
  UnifiedSession,
  UnifiedMessage,
  QuestionTypeRegistry,
} from "../../types/unified"
import type { LoCoMoItem, LoCoMoMessage } from "./types"
import { logger } from "../../utils/logger"

const DEFAULT_DATA_PATH = "./data/benchmarks/locomo/locomo10.json"
const GITHUB_DATASET_URL =
  "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json"

function parseLocomoDate(dateStr: string): { iso: string; formatted: string } | null {
  const match = dateStr.match(/(\d+):(\d+)\s*(am|pm)\s*on\s*(\d+)\s*(\w+),?\s*(\d+)/i)
  if (!match) {
    logger.warn(`Failed to parse LoCoMo date: "${dateStr}" - skipping date metadata`)
    return null
  }
  const [, hourStr, min, ampm, day, monthName, year] = match
  let hour = parseInt(hourStr)
  if (ampm.toLowerCase() === "pm" && hour !== 12) hour += 12
  if (ampm.toLowerCase() === "am" && hour === 12) hour = 0
  const monthNames = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ]
  const month = monthNames.findIndex((n) => n.startsWith(monthName.toLowerCase()))
  const date = new Date(Date.UTC(parseInt(year), month, parseInt(day), hour, parseInt(min)))
  return {
    iso: date.toISOString(),
    formatted: `${hour % 12 || 12}:${min} ${hour >= 12 ? "pm" : "am"} on ${day} ${monthName}, ${year}`,
  }
}

export const LOCOMO_QUESTION_TYPES: QuestionTypeRegistry = {
  "single-hop": { id: "single-hop", alias: "single", description: "Single-hop fact recall" },
  "multi-hop": {
    id: "multi-hop",
    alias: "multi",
    description: "Multi-hop reasoning across sessions",
  },
  temporal: { id: "temporal", alias: "temporal", description: "Temporal reasoning" },
  "world-knowledge": {
    id: "world-knowledge",
    alias: "world",
    description: "Commonsense/world knowledge",
  },
  adversarial: {
    id: "adversarial",
    alias: "adversarial",
    description: "Adversarial (unanswerable)",
  },
}

const CATEGORY_TO_TYPE: Record<number, string> = {
  1: "single-hop",
  2: "multi-hop",
  3: "temporal",
  4: "world-knowledge",
  5: "adversarial",
}

export class LoCoMoBenchmark implements Benchmark {
  name = "locomo"
  private data: LoCoMoItem[] = []
  private questions: UnifiedQuestion[] = []
  private sessionsMap: Map<string, UnifiedSession[]> = new Map()

  async load(config?: BenchmarkConfig): Promise<void> {
    const dataPath = config?.dataPath || DEFAULT_DATA_PATH
    const fullPath = join(process.cwd(), dataPath)

    if (!existsSync(fullPath)) {
      logger.info("Downloading LoCoMo dataset from GitHub...")
      await this.downloadDataset(fullPath)
    }

    this.data = JSON.parse(readFileSync(fullPath, "utf8"))
    logger.info(`Loaded ${this.data.length} conversations from LoCoMo`)

    this.processData()
  }

  private async downloadDataset(destPath: string): Promise<void> {
    const dir = join(destPath, "..")
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    logger.info(`Fetching from ${GITHUB_DATASET_URL}...`)
    const response = await fetch(GITHUB_DATASET_URL)
    if (!response.ok) {
      throw new Error(`Failed to download dataset: ${response.status}`)
    }

    const data = await response.text()
    writeFileSync(destPath, data)
    logger.success(`Downloaded LoCoMo dataset (${(data.length / 1024 / 1024).toFixed(1)} MB)`)
  }

  private processData(): void {
    for (const item of this.data) {
      const sessions = this.extractSessions(item)
      const sessionIds = sessions.map((s) => s.sessionId)

      for (let i = 0; i < item.qa.length; i++) {
        const qa = item.qa[i]
        const questionId = `${item.sample_id}-q${i}`

        const questionType = CATEGORY_TO_TYPE[qa.category]
        if (!questionType) {
          throw new Error(`Unknown LoCoMo category: ${qa.category} for question ${questionId}`)
        }

        this.questions.push({
          questionId,
          question: qa.question,
          questionType,
          groundTruth: String(qa.answer),
          haystackSessionIds: sessionIds,
          metadata: {
            sampleId: item.sample_id,
            evidence: qa.evidence,
          },
        })

        this.sessionsMap.set(questionId, sessions)
      }
    }
    logger.info(`Processed ${this.questions.length} questions`)
  }

  private extractSessions(item: LoCoMoItem): UnifiedSession[] {
    const sessions: UnifiedSession[] = []
    const conv = item.conversation
    const speakerA = conv.speaker_a
    const speakerB = conv.speaker_b

    for (let i = 1; i <= 100; i++) {
      const sessionKey = `session_${i}`
      const dateKey = `session_${i}_date_time`

      if (!conv[sessionKey]) break

      const messages = conv[sessionKey] as LoCoMoMessage[]
      if (!Array.isArray(messages)) continue

      const unifiedMessages: UnifiedMessage[] = messages.map((m) => ({
        role: m.speaker === speakerA ? ("user" as const) : ("assistant" as const),
        content: m.text,
        speaker: m.speaker,
      }))

      const rawDate = conv[dateKey] as string | undefined
      const parsedDate = rawDate ? parseLocomoDate(rawDate) : null

      sessions.push({
        sessionId: `${item.sample_id}-${sessionKey}`,
        messages: unifiedMessages,
        metadata: {
          date: parsedDate?.iso,
          formattedDate: parsedDate?.formatted,
          speakerA,
          speakerB,
        },
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
    return LOCOMO_QUESTION_TYPES
  }
}

export default LoCoMoBenchmark
