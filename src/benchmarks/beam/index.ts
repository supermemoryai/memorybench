import { existsSync, readFileSync } from "fs"
import type { LanguageModel } from "ai"
import { join } from "path"
import type { Benchmark, BenchmarkConfig, QuestionFilter } from "../../types/benchmark"
import type { UnifiedQuestion, UnifiedSession, QuestionTypeRegistry } from "../../types/unified"
import { logger } from "../../utils/logger"
import { buildBeamAnswerPrompt } from "./prompts"
import { evaluateBeamAnswer } from "./scoring"

const DEFAULT_DATA_PATH = "./data/benchmarks/beam/1M/oracle.json"

interface BeamOracleSession {
  sessionId: string
  chatId: string
  batchNumber: number
  turnIndex: number
  documentDate: string | null
  messages: { role: "user" | "assistant"; content: string; messageId: number }[]
}

interface BeamOracleQuestion {
  questionId: string
  v4QuestionId: string | null
  chatId: string
  questionType: string
  question: string
  referenceAnswer: string | null
  rubric: string[]
  difficulty: string | null
  questionDate?: string | null
  evidenceSessionIds: string[]
  evidenceMessageIds: number[]
  details: Record<string, unknown>
}

interface BeamOracleFile {
  source: { file: string; sha256: string; scale: string }
  /** "shared": all questions use one container holding every question's evidence */
  container?: "per-question" | "shared"
  questions: BeamOracleQuestion[]
  sessions: Record<string, BeamOracleSession>
}

export const BEAM_QUESTION_TYPES: QuestionTypeRegistry = {
  abstention: { id: "abstention", alias: "ab", description: "Abstention: the chat never says" },
  contradiction_resolution: {
    id: "contradiction_resolution",
    alias: "cr",
    description: "Contradiction resolution: conflicting statements",
  },
  event_ordering: { id: "event_ordering", alias: "eo", description: "Event ordering" },
  information_extraction: {
    id: "information_extraction",
    alias: "ie",
    description: "Information extraction",
  },
  instruction_following: {
    id: "instruction_following",
    alias: "if",
    description: "Instruction following",
  },
  knowledge_update: { id: "knowledge_update", alias: "ku", description: "Knowledge update" },
  multi_session_reasoning: {
    id: "multi_session_reasoning",
    alias: "msr",
    description: "Multi-session reasoning",
  },
  preference_following: {
    id: "preference_following",
    alias: "pf",
    description: "Preference following",
  },
  summarization: { id: "summarization", alias: "sum", description: "Summarization" },
  temporal_reasoning: { id: "temporal_reasoning", alias: "tr", description: "Temporal reasoning" },
}

/** "2024-03-15" -> "15 March 2024" */
function formatDate(isoDay: string): string {
  const d = new Date(`${isoDay}T00:00:00Z`)
  const month = d.toLocaleString("en-US", { month: "long", timeZone: "UTC" })
  return `${d.getUTCDate()} ${month} ${d.getUTCFullYear()}`
}

/**
 * BEAM 1M in oracle mode: a question's haystack is only the sessions holding its
 * evidence (BEAM's source_chat_ids). Each question gets its own container, or, for a
 * "shared" subset file, all questions share one container with every question's evidence.
 * Build the data file with scripts/prepare-beam-oracle.py.
 */
export class BeamBenchmark implements Benchmark {
  name = "beam"
  private questions: UnifiedQuestion[] = []
  private sessions: Map<string, UnifiedSession> = new Map()
  private shared = false
  private scale = "1M"
  private sessionDates: Map<string, string> = new Map()

  async load(config?: BenchmarkConfig): Promise<void> {
    const dataPath = config?.dataPath || process.env.BEAM_DATA_PATH || DEFAULT_DATA_PATH
    const fullPath = join(process.cwd(), dataPath)
    if (!existsSync(fullPath)) {
      throw new Error(
        `BEAM oracle data not found at ${dataPath}. Build it with: uv run --with pyarrow scripts/prepare-beam-oracle.py --parquet <BEAM 1M parquet>`
      )
    }

    const data = JSON.parse(readFileSync(fullPath, "utf8")) as BeamOracleFile
    this.shared = data.container === "shared"
    this.scale = data.source.scale
    for (const s of Object.values(data.sessions)) {
      if (s.documentDate) this.sessionDates.set(s.sessionId, s.documentDate)
      this.sessions.set(s.sessionId, {
        sessionId: s.sessionId,
        messages: s.messages.map((m) => ({ role: m.role, content: m.content })),
        metadata: {
          ...(s.documentDate
            ? {
                date: `${s.documentDate}T00:00:00.000Z`,
                formattedDate: formatDate(s.documentDate),
                documentDate: s.documentDate,
              }
            : {}),
          chatId: s.chatId,
          batchNumber: s.batchNumber,
          turnIndex: s.turnIndex,
        },
      })
    }

    this.questions = data.questions.map((q) => ({
      questionId: q.questionId,
      question: q.question,
      questionType: q.questionType,
      groundTruth: q.referenceAnswer || q.rubric.join("\n"),
      haystackSessionIds: q.evidenceSessionIds,
      metadata: {
        chatId: q.chatId,
        v4QuestionId: q.v4QuestionId,
        rubric: q.rubric,
        difficulty: q.difficulty,
        questionDate: q.questionDate ?? undefined,
        evidenceMessageIds: q.evidenceMessageIds,
        details: q.details,
      },
    }))

    logger.info(
      `Loaded BEAM ${data.source.scale} oracle: ${this.questions.length} questions, ${this.sessions.size} evidence sessions, ${this.shared ? "one shared container" : "one container per question"} (source ${data.source.sha256.slice(0, 12)})`
    )
  }

  getQuestions(filter?: QuestionFilter): UnifiedQuestion[] {
    let result = [...this.questions]
    if (filter?.questionTypes?.length) {
      result = result.filter((q) => filter.questionTypes!.includes(q.questionType))
    }
    if (filter?.offset) result = result.slice(filter.offset)
    if (filter?.limit) result = result.slice(0, filter.limit)
    return result
  }

  getHaystackSessions(questionId: string): UnifiedSession[] {
    // Ingest each chat in conversation order so updates land after what they replace
    if (this.shared) {
      const order = (s: UnifiedSession) =>
        [s.metadata?.chatId, s.metadata?.batchNumber, s.metadata?.turnIndex].map(Number)
      return [...this.sessions.values()].sort((x, y) => {
        const [a, b] = [order(x), order(y)]
        return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
      })
    }
    const question = this.questions.find((q) => q.questionId === questionId)
    return (question?.haystackSessionIds || []).map((id) => this.sessions.get(id)!)
  }

  getContainerKey(questionId: string): string {
    return this.shared ? `beam-${this.scale}-oracle` : questionId
  }

  buildAnswerPrompt(question: UnifiedQuestion, _context: string, results: unknown[] = []): string {
    return buildBeamAnswerPrompt(
      question.question,
      question.questionType,
      results,
      this.sessionDates
    )
  }

  /** The standard BEAM answer rules, for agentic answering */
  agentRules(question: UnifiedQuestion): string {
    const prompt = buildBeamAnswerPrompt(question.question, question.questionType, [], new Map())
    return prompt
      .slice(
        prompt.indexOf("IMPORTANT RULES:") + "IMPORTANT RULES:".length,
        prompt.indexOf("QUESTION:")
      )
      .trim()
  }

  evaluateAnswer(question: UnifiedQuestion, hypothesis: string, model: LanguageModel) {
    return evaluateBeamAnswer(question, hypothesis, model)
  }

  getGroundTruth(questionId: string): string {
    return this.questions.find((q) => q.questionId === questionId)?.groundTruth || ""
  }

  getQuestionTypes(): QuestionTypeRegistry {
    return BEAM_QUESTION_TYPES
  }
}

export default BeamBenchmark
