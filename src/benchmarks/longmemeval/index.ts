import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import type { Benchmark, BenchmarkConfig, QuestionFilter } from "../../types/benchmark"
import type {
  UnifiedQuestion,
  UnifiedSession,
  UnifiedMessage,
  QuestionTypeRegistry,
} from "../../types/unified"
import type { LongMemEvalItem } from "./types"
import { logger } from "../../utils/logger"

const DEFAULT_DATA_PATH = "./data/benchmarks/longmemeval/datasets"
const HF_DATASET_URL =
  "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json"

function parseLongMemEvalDate(dateStr: string): { iso: string; formatted: string } | null {
  const match = dateStr.match(/(\d{4})\/(\d{2})\/(\d{2})\s*\([^)]*\)\s*(\d{2}):(\d{2})/)
  if (!match) {
    logger.warn(`Failed to parse LongMemEval date: "${dateStr}" - skipping date metadata`)
    return null
  }
  const [, year, month, day, hour, min] = match
  const date = new Date(
    Date.UTC(parseInt(year), parseInt(month) - 1, parseInt(day), parseInt(hour), parseInt(min))
  )
  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ]
  const h = parseInt(hour)
  const formattedHour = h % 12 || 12
  const ampm = h >= 12 ? "pm" : "am"
  return {
    iso: date.toISOString(),
    formatted: `${formattedHour}:${min} ${ampm} on ${parseInt(day)} ${monthNames[parseInt(month) - 1]}, ${year}`,
  }
}

/**
 * LongMemEval question types - native string types from the dataset.
 */
export const LONGMEMEVAL_QUESTION_TYPES: QuestionTypeRegistry = {
  "single-session-user": {
    id: "single-session-user",
    alias: "ss-user",
    description: "Single-session user facts",
  },
  "single-session-assistant": {
    id: "single-session-assistant",
    alias: "ss-asst",
    description: "Single-session assistant facts",
  },
  "single-session-preference": {
    id: "single-session-preference",
    alias: "ss-pref",
    description: "Single-session preferences",
  },
  "multi-session": { id: "multi-session", alias: "multi", description: "Multi-session reasoning" },
  "temporal-reasoning": {
    id: "temporal-reasoning",
    alias: "temporal",
    description: "Temporal reasoning",
  },
  "knowledge-update": {
    id: "knowledge-update",
    alias: "update",
    description: "Knowledge update tracking",
  },
}

export class LongMemEvalBenchmark implements Benchmark {
  name = "longmemeval"
  private data: LongMemEvalItem[] = []
  private questions: UnifiedQuestion[] = []
  private sessionsMap: Map<string, UnifiedSession[]> = new Map()
  private dataPath: string = ""

  async load(config?: BenchmarkConfig): Promise<void> {
    this.dataPath = config?.dataPath || DEFAULT_DATA_PATH
    const fullPath = join(process.cwd(), this.dataPath)
    const rawDataPath = join(fullPath, "longmemeval_s_cleaned.json")
    const questionsDir = join(fullPath, "questions")

    if (!existsSync(rawDataPath)) {
      logger.info("Downloading LongMemEval dataset from HuggingFace...")
      await this.downloadDataset(rawDataPath)
    }

    if (!existsSync(questionsDir) || readdirSync(questionsDir).length === 0) {
      logger.info("Splitting questions into individual files...")
      await this.splitQuestions(rawDataPath, questionsDir)
    }

    this.loadQuestions(questionsDir)
  }

  private async downloadDataset(destPath: string): Promise<void> {
    const dir = join(destPath, "..")
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    logger.info(`Fetching from ${HF_DATASET_URL}...`)
    const response = await fetch(HF_DATASET_URL)
    if (!response.ok) {
      throw new Error(`Failed to download dataset: ${response.status}`)
    }

    const contentLength = response.headers.get("content-length")
    const totalSize = contentLength ? parseInt(contentLength, 10) : 0
    if (totalSize) {
      logger.info(`Download size: ${(totalSize / 1024 / 1024).toFixed(1)} MB`)
    }

    const reader = response.body?.getReader()
    if (!reader) {
      throw new Error("Failed to get response reader")
    }

    const chunks: Uint8Array[] = []
    let downloaded = 0
    const totalMb = Math.round(totalSize / 1024 / 1024)

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      chunks.push(value)
      downloaded += value.length

      if (totalSize) {
        const currentMb = Math.round(downloaded / 1024 / 1024)
        logger.progress(currentMb, totalMb, `Downloading (${currentMb}/${totalMb} MB)`)
      }
    }

    const allChunks = new Uint8Array(downloaded)
    let offset = 0
    for (const chunk of chunks) {
      allChunks.set(chunk, offset)
      offset += chunk.length
    }

    const data = new TextDecoder().decode(allChunks)
    writeFileSync(destPath, data)
    logger.success(`Downloaded LongMemEval dataset to ${destPath}`)
  }

  private async splitQuestions(rawPath: string, questionsDir: string): Promise<void> {
    if (!existsSync(questionsDir)) {
      mkdirSync(questionsDir, { recursive: true })
    }

    const dataset: LongMemEvalItem[] = JSON.parse(readFileSync(rawPath, "utf8"))

    for (const item of dataset) {
      if (!item.question_id) continue

      if (item.haystack_sessions) {
        item.haystack_sessions.forEach((session) => {
          if (Array.isArray(session)) {
            session.forEach((msg) => {
              delete msg.has_answer
            })
          }
        })
      }

      writeFileSync(join(questionsDir, `${item.question_id}.json`), JSON.stringify(item, null, 2))
    }

    logger.success(`Split ${dataset.length} questions`)
  }

  private loadQuestions(questionsDir: string): void {
    const files = readdirSync(questionsDir).filter((f) => f.endsWith(".json"))

    for (const file of files) {
      const item: LongMemEvalItem = JSON.parse(readFileSync(join(questionsDir, file), "utf8"))
      this.data.push(item)

      const sessions = this.extractSessions(item)
      const sessionIds = sessions.map((s) => s.sessionId)

      this.questions.push({
        questionId: item.question_id,
        question: item.question,
        questionType: item.question_type,
        groundTruth: item.answer,
        haystackSessionIds: sessionIds,
        metadata: {
          questionDate: item.question_date,
        },
      })

      this.sessionsMap.set(item.question_id, sessions)
    }

    logger.info(`Loaded ${this.questions.length} questions from LongMemEval`)
  }

  private extractSessions(item: LongMemEvalItem): UnifiedSession[] {
    const sessions: UnifiedSession[] = []

    for (let i = 0; i < item.haystack_sessions.length; i++) {
      const sessionMessages = item.haystack_sessions[i]
      const sessionDate = item.haystack_dates[i]

      const unifiedMessages: UnifiedMessage[] = sessionMessages.map((m) => ({
        role: m.role,
        content: m.content,
      }))

      const parsedDate = sessionDate ? parseLongMemEvalDate(sessionDate) : null

      sessions.push({
        sessionId: `${item.question_id}-session-${i}`,
        messages: unifiedMessages,
        metadata: {
          date: parsedDate?.iso,
          formattedDate: parsedDate?.formatted,
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
    return LONGMEMEVAL_QUESTION_TYPES
  }
}

export default LongMemEvalBenchmark
