import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  createWriteStream,
  renameSync,
} from "fs"
import { join } from "path"
import { pipeline } from "stream/promises"
import { Readable } from "stream"

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

const DEFAULT_BASE_URL = "https://huggingface.co/datasets/xinrongzhang2022/InfiniteBench/resolve/main"

const INDEX_FILENAME = "_index.json"

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
  passkey: { id: "passkey", alias: "passkey", description: "Synthetic passkey retrieval" },
  kv_retrieval: { id: "kv_retrieval", alias: "kv", description: "Key-value retrieval" },
  number_string: { id: "number_string", alias: "number-string", description: "Number string retrieval" },
  code_run: { id: "code_run", alias: "code-run", description: "Code execution" },
  code_debug: { id: "code_debug", alias: "code-debug", description: "Code debugging" },
  math_find: { id: "math_find", alias: "math-find", description: "Mathematical search" },
  math_calc: { id: "math_calc", alias: "math-calc", description: "Mathematical calculation" },
  longdialogue_qa_eng: { id: "longdialogue_qa_eng", alias: "dialogue", description: "Long dialogue QA" },
  longbook_qa_eng: { id: "longbook_qa_eng", alias: "book-qa", description: "Long book question answering" },
  longbook_sum_eng: { id: "longbook_sum_eng", alias: "book-summary", description: "Long book summarization" },
  longbook_choice_eng: { id: "longbook_choice_eng", alias: "book-choice", description: "Long book multiple choice" },
  longbook_qa_chn: { id: "longbook_qa_chn", alias: "book-qa-zh", description: "Chinese long book QA" },
}

interface IndexEntry {
  questionId: string
  question: string
  questionType: InfiniteBenchTask
  groundTruth: string
  metadata: {
    task: InfiniteBenchTask
    hasOptions: boolean
    answerCount: number
    options: string[]
  }
}

export interface InfiniteBenchConfig extends BenchmarkConfig {
  tasks?: InfiniteBenchTask[]
  download?: boolean
  baseUrl?: string
}

export class InfiniteBenchBenchmark implements Benchmark {
  name = "infinitebench"

  private questions: UnifiedQuestion[] = []
  private dataPath = ""
  private fullPath = ""
  private allowDownload = true
  private baseUrl = DEFAULT_BASE_URL

  private itemCache: Map<InfiniteBenchTask, Map<string, InfiniteBenchItem>> = new Map()
  private inFlightDownloads: Map<InfiniteBenchTask, Promise<void>> = new Map()

  async load(config?: InfiniteBenchConfig): Promise<void> {
    this.dataPath = config?.dataPath || DEFAULT_DATA_PATH
    this.fullPath = join(process.cwd(), this.dataPath)
    this.allowDownload = config?.download ?? true
    this.baseUrl = config?.baseUrl || DEFAULT_BASE_URL

    mkdirSync(this.fullPath, { recursive: true })

    const tasksToLoad = config?.tasks?.length ? config.tasks : TASKS

    const index = this.readIndex()
    if (index) {
      this.hydrateFromIndex(index, tasksToLoad)
      logger.info(`Loaded ${this.questions.length} questions from cached index (no download needed)`)
      return
    }

    logger.warn(
      `No metadata index found at ${this.indexPath()}. Building it now — this ` +
        `downloads each requested task file once and is cached for every future run. ` +
        `Pass \`tasks: ["passkey", ...]\` in the config to limit this to just what you need.`
    )

    const entries: IndexEntry[] = this.readPartialIndexFromDisk()

    for (const task of tasksToLoad) {
      if (entries.some((e) => e.metadata.task === task)) continue // already indexed from a prior partial run
      await this.indexTask(task, entries)
    }

    this.writeIndex(entries)
    this.hydrateFromIndex(entries, tasksToLoad)
    logger.info(`Loaded ${this.questions.length} questions from InfiniteBench`)
  }


  private indexPath(): string {
    return join(this.fullPath, INDEX_FILENAME)
  }

  private readIndex(): IndexEntry[] | null {
    const path = this.indexPath()
    if (!existsSync(path)) return null
    try {
      return JSON.parse(readFileSync(path, "utf8"))
    } catch (err) {
      logger.warn(`Failed to parse cached index, rebuilding: ${err}`)
      return null
    }
  }

  private readPartialIndexFromDisk(): IndexEntry[] {
    const entries: IndexEntry[] = []
    for (const task of TASKS) {
      const filePath = this.taskFilePath(task)
      if (!existsSync(filePath)) continue
      this.parseTaskFile(filePath, task, (item) => entries.push(this.toIndexEntry(item, task)))
    }
    return entries
  }

  private writeIndex(entries: IndexEntry[]): void {
    writeFileSync(this.indexPath(), JSON.stringify(entries), "utf8")
  }

  private hydrateFromIndex(entries: IndexEntry[], tasksToLoad: readonly InfiniteBenchTask[]): void {
    const allowed = new Set(tasksToLoad)
    this.questions = entries
      .filter((e) => allowed.has(e.metadata.task))
      .map((e) => ({
        questionId: e.questionId,
        question: e.question,
        questionType: e.questionType,
        groundTruth: e.groundTruth,
        haystackSessionIds: [`${e.questionId}-session-0`],
        metadata: e.metadata,
      }))
  }

  private toIndexEntry(item: InfiniteBenchItem, task: InfiniteBenchTask): IndexEntry {
    return {
      questionId: this.questionId(item, task),
      question: item.input,
      questionType: task,
      groundTruth: String(item.answer[0]),
      metadata: {
        task,
        hasOptions: (item.options?.length ?? 0) > 0,
        answerCount: item.answer.length,
        options: item.options ?? [],
      },
    }
  }

  private questionId(item: InfiniteBenchItem, task: InfiniteBenchTask): string {
    return `infinitebench-${task}-${String(item.id).padStart(6, "0")}`
  }

  private taskFilePath(task: InfiniteBenchTask): string {
    return join(this.fullPath, `${task}.jsonl`)
  }

  private async indexTask(task: InfiniteBenchTask, entries: IndexEntry[]): Promise<void> {
    const filePath = this.taskFilePath(task)

    if (!existsSync(filePath)) {
      await this.downloadTask(task)
    }

    if (!existsSync(filePath)) {
      logger.warn(`Missing file for ${task} after download attempt: ${filePath}`)
      return
    }

    this.parseTaskFile(filePath, task, (item) => entries.push(this.toIndexEntry(item, task)))
  }

  private parseTaskFile(
    filePath: string,
    task: InfiniteBenchTask,
    onItem: (item: InfiniteBenchItem) => void
  ): void {
    let loaded = 0
    try {
      const lines = readFileSync(filePath, "utf8").split("\n").filter(Boolean)
      for (const line of lines) {
        try {
          onItem(JSON.parse(line))
          loaded++
        } catch (err) {
          logger.warn(`Skipping malformed record in ${task}: ${err}`)
        }
      }
      logger.info(`Parsed ${loaded} ${task} records`)
    } catch (error) {
      logger.error(`Failed to read ${task}: ${error}`)
    }
  }

  private async downloadTask(task: InfiniteBenchTask): Promise<void> {
    if (!this.allowDownload) {
      throw new Error(
        `InfiniteBench task file for "${task}" is missing and downloading is disabled ` +
          `(config.download === false). Place ${task}.jsonl under ${this.dataPath} manually, ` +
          `or set download: true.`
      )
    }

    const existing = this.inFlightDownloads.get(task)
    if (existing) return existing

    const promise = this.doDownload(task).finally(() => this.inFlightDownloads.delete(task))
    this.inFlightDownloads.set(task, promise)
    return promise
  }

  private async doDownload(task: InfiniteBenchTask): Promise<void> {
    const filePath = this.taskFilePath(task)
    const tmpPath = `${filePath}.partial`
    const url = `${this.baseUrl}/${task}.jsonl`

    logger.info(`Downloading ${task}.jsonl ...`)

    const response = await fetch(url)
    if (!response.ok || !response.body) {
      throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`)
    }

    const totalBytes = Number(response.headers.get("content-length") ?? 0)
    let received = 0
    let lastLog = Date.now()

    const nodeStream = Readable.fromWeb(response.body as any)
    nodeStream.on("data", (chunk: Buffer) => {
      received += chunk.length
      const now = Date.now()
      if (now - lastLog > 2000) {
        lastLog = now
        const pct = totalBytes ? `${((received / totalBytes) * 100).toFixed(0)}%` : "?"
        logger.info(`  ${task}.jsonl: ${(received / 1e6).toFixed(1)} MB (${pct})`)
      }
    })

    await pipeline(nodeStream, createWriteStream(tmpPath))
    renameSync(tmpPath, filePath) // atomic-ish: never leave a half-written file at the real path

    logger.info(`Downloaded ${task}.jsonl (${(received / 1e6).toFixed(1)} MB)`)
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
    const item = this.getCachedItem(questionId)
    if (!item) return []

    const message: UnifiedMessage = { role: "user", content: item.context }
    return [{ sessionId: `${questionId}-session-0`, messages: [message] }]
  }

  getGroundTruth(questionId: string): string {
    return this.questions.find((q) => q.questionId === questionId)?.groundTruth ?? ""
  }

  getQuestionTypes(): QuestionTypeRegistry {
    return INFINITEBENCH_QUESTION_TYPES
  }

  async prepareQuestion(questionId: string): Promise<void> {
    const task = this.taskFromQuestionId(questionId)
    if (task) await this.ensureTaskLoaded(task)
  }

  async ensureTaskLoaded(task: InfiniteBenchTask): Promise<void> {
    if (!existsSync(this.taskFilePath(task))) {
      await this.downloadTask(task)
    }
  }

  private getCachedItem(questionId: string): InfiniteBenchItem | undefined {
    const task = this.taskFromQuestionId(questionId)
    if (!task) return undefined

    let cache = this.itemCache.get(task)
    if (cache?.has(questionId)) return cache.get(questionId)

    const filePath = this.taskFilePath(task)
    if (!existsSync(filePath)) {
      logger.warn(
        `${task}.jsonl not downloaded yet. Call ` +
          `await benchmark.prepareQuestion("${questionId}") before requesting its haystack.`
      )
      return undefined
    }

    cache = new Map()
    this.parseTaskFile(filePath, task, (item) => cache!.set(this.questionId(item, task), item))
    this.itemCache.set(task, cache)

    return cache.get(questionId)
  }

  private taskFromQuestionId(questionId: string): InfiniteBenchTask | undefined {
    return TASKS.find((t) => questionId.startsWith(`infinitebench-${t}-`))
  }
}

export default InfiniteBenchBenchmark