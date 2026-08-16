import { existsSync, readFileSync } from "fs"
import { join } from "path"
import type { Benchmark, BenchmarkConfig, QuestionFilter } from "../../types/benchmark"
import type {
  QuestionTypeRegistry,
  UnifiedMessage,
  UnifiedQuestion,
  UnifiedSession,
} from "../../types/unified"
import { logger } from "../../utils/logger"
import type { LongMemEvalV2Question, LongMemEvalV2State, LongMemEvalV2Trajectory } from "./types"

const DEFAULT_DATA_PATH = "./data/benchmarks/longmemeval-v2"
const DEFAULT_TIER = "small"
const TREE_EXCERPT_CHAR_LIMIT = 12000
const COMPACT_UI_CHAR_LIMIT = 12000
const POST_INDEXING_DELAY_MS = 60_000

type HaystackMap = Record<string, string[]>
type TrajectoryFormat = "raw" | "clean" | "clean-tree"
type TrajectoryDocumentSelection =
  | { type: "all" }
  | { type: "overview" }
  | { type: "state"; stateIndex: number }
  | { type: "result" }

function parseTrajectoryDocument(value?: string): TrajectoryDocumentSelection {
  if (value === undefined) return { type: "all" }
  if (value === "overview") return { type: "overview" }
  if (value === "result") return { type: "result" }

  const match = /^state:(0|[1-9]\d*)$/.exec(value)
  if (match) return { type: "state", stateIndex: Number(match[1]) }

  throw new Error("LongMemEval-V2 trajectoryDocument must be overview, state:<index>, or result")
}

function parseTrajectoryFormat(value?: string): TrajectoryFormat {
  if (value === undefined || value === "raw") return "raw"
  if (value === "clean") return "clean"
  if (value === "clean-tree") return "clean-tree"
  throw new Error("LongMemEval-V2 trajectoryFormat must be raw, clean, or clean-tree")
}

function isCleanFormat(format: TrajectoryFormat): boolean {
  return format === "clean" || format === "clean-tree"
}

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T)
}

function requireFile(path: string, description: string): void {
  if (!existsSync(path)) {
    throw new Error(
      `Missing ${description}: ${path}\n` +
        "Download LongMemEval-V2 data first, then set BenchmarkConfig.dataPath or place files under data/benchmarks/longmemeval-v2."
    )
  }
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}\n...[truncated ${value.length - limit} chars]`
}

function uniquePush(items: string[], seen: Set<string>, value: string): void {
  const normalized = value.replace(/\s+/g, " ").trim()
  if (!normalized || normalized.length < 2 || seen.has(normalized)) return
  seen.add(normalized)
  items.push(normalized)
}

function extractQuotedLabels(line: string): string[] {
  const labels: string[] = []
  const patterns = [
    /\b(?:button|link|menuitem|option|combobox|textbox|searchbox|checkbox|heading|gridcell|cell|rowheader|columnheader|StaticText)\s+'([^']+)'/g,
    /\bvalue='([^']+)'/g,
    /\bplaceholder='([^']+)'/g,
  ]

  for (const pattern of patterns) {
    for (const match of line.matchAll(pattern)) {
      labels.push(match[1])
    }
  }

  return labels
}

function compactAccessibilityTree(tree?: string | null): string {
  if (!tree) return ""

  const roleLinePattern =
    /\b(button|link|menuitem|option|combobox|textbox|searchbox|checkbox|heading|gridcell|cell|rowheader|columnheader|StaticText|listitem)\b/
  const labels: string[] = []
  const roleLines: string[] = []
  const seenLabels = new Set<string>()
  const seenLines = new Set<string>()

  for (const rawLine of tree.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    for (const label of extractQuotedLabels(line)) {
      uniquePush(labels, seenLabels, label)
    }

    if (roleLinePattern.test(line)) {
      uniquePush(roleLines, seenLines, line)
    }

    const compactLength = labels.join("\n").length + roleLines.join("\n").length
    if (compactLength > COMPACT_UI_CHAR_LIMIT) break
  }

  const sections: string[] = []
  if (labels.length) {
    sections.push(`UI labels and values:\n${labels.map((label) => `- ${label}`).join("\n")}`)
  }
  if (roleLines.length) {
    sections.push(`Relevant accessibility lines:\n${roleLines.join("\n")}`)
  }

  return truncate(sections.join("\n\n"), COMPACT_UI_CHAR_LIMIT)
}

function stateToSession(
  trajectory: LongMemEvalV2Trajectory,
  state: LongMemEvalV2State,
  format: TrajectoryFormat
): UnifiedSession {
  const usesRawTreeRepresentation = format === "raw" || format === "clean-tree"
  const compactTree = usesRawTreeRepresentation
    ? compactAccessibilityTree(state.accessibility_tree)
    : ""
  const accessibilityTree =
    usesRawTreeRepresentation && state.accessibility_tree
      ? truncate(state.accessibility_tree, TREE_EXCERPT_CHAR_LIMIT)
      : ""

  const content = [
    "LongMemEval-V2 agent trajectory state",
    `Trajectory ID: ${trajectory.id}`,
    `Domain: ${trajectory.domain}`,
    `Environment: ${trajectory.environment}`,
    format === "raw" ? `Outcome: ${trajectory.outcome || "unknown"}` : "",
    format === "raw" ? `Goal: ${trajectory.goal}` : "",
    `State index: ${state.state_index}`,
    state.step !== undefined ? `Step: ${state.step}` : "",
    state.url ? `URL: ${state.url}` : "",
    state.action ? `Action: ${state.action}` : "Action: null",
    state.thought ? `Agent thought: ${state.thought}` : "",
    state.screenshot ? `Screenshot path: ${state.screenshot}` : "",
    compactTree ? `\nCompact UI extraction:\n${compactTree}` : "",
    accessibilityTree ? `\nAccessibility tree excerpt:\n${accessibilityTree}` : "",
  ]
    .filter(Boolean)
    .join("\n")

  return {
    sessionId: `lme-v2-${trajectory.id}-state-${state.state_index}`,
    messages: [{ role: "assistant", content }],
    metadata: {
      benchmark: "longmemeval-v2",
      documentTag: `STATE_${state.state_index}`,
      trajectoryId: trajectory.id,
      stateIndex: state.state_index,
      documentType: "state",
      ...(isCleanFormat(format) ? { filterByMetadata: { stateIndex: state.state_index - 1 } } : {}),
      ...(format === "clean-tree" ? { postIndexingDelayMs: POST_INDEXING_DELAY_MS } : {}),
      domain: trajectory.domain,
      environment: trajectory.environment,
      ...(format === "raw" ? { outcome: trajectory.outcome } : {}),
      url: state.url,
      screenshot: state.screenshot,
    },
  }
}

function trajectoryOverviewToSession(
  trajectory: LongMemEvalV2Trajectory,
  format: TrajectoryFormat
): UnifiedSession {
  const actionTrace = trajectory.states
    .map((state) => {
      const action = state.action || "null"
      const thought = state.thought ? ` | thought: ${state.thought}` : ""
      return `- state ${state.state_index}: action=${action}${thought}`
    })
    .join("\n")

  const overviewContent = [
    "LongMemEval-V2 trajectory overview",
    `Trajectory ID: ${trajectory.id}`,
    `Domain: ${trajectory.domain}`,
    `Environment: ${trajectory.environment}`,
    format === "raw" ? `Outcome: ${trajectory.outcome || "unknown"}` : "",
    `Start URL: ${trajectory.start_url || "unknown"}`,
    `Goal: ${trajectory.goal}`,
  ]
    .filter(Boolean)
    .join("\n")

  const messages: UnifiedMessage[] = [{ role: "user", content: overviewContent }]
  if (format === "raw") {
    messages.push({
      role: "assistant",
      content: `Action/thought trace:\n${truncate(actionTrace, TREE_EXCERPT_CHAR_LIMIT)}`,
    })
  }

  return {
    sessionId: `lme-v2-${trajectory.id}-overview`,
    messages,
    metadata: {
      benchmark: "longmemeval-v2",
      documentTag: "STATE_-1",
      trajectoryId: trajectory.id,
      stateIndex: -1,
      documentType: "overview",
      domain: trajectory.domain,
      environment: trajectory.environment,
      ...(format === "raw" ? { outcome: trajectory.outcome } : {}),
      ...(format === "clean-tree" ? { postIndexingDelayMs: POST_INDEXING_DELAY_MS } : {}),
      sessionType: "trajectory-overview",
    },
  }
}

function trajectoryResultToSession(
  trajectory: LongMemEvalV2Trajectory,
  format: TrajectoryFormat
): UnifiedSession {
  const resultStateIndex =
    trajectory.states.reduce((max, state) => Math.max(max, state.state_index), -1) + 1

  return {
    sessionId: `lme-v2-${trajectory.id}-result`,
    messages: [
      {
        role: "assistant",
        content: [
          "LongMemEval-V2 trajectory result",
          `Trajectory ID: ${trajectory.id}`,
          `Domain: ${trajectory.domain}`,
          `Environment: ${trajectory.environment}`,
          `Final outcome: ${trajectory.outcome || "unknown"}`,
        ].join("\n"),
      },
    ],
    metadata: {
      benchmark: "longmemeval-v2",
      documentTag: "RESULT",
      trajectoryId: trajectory.id,
      stateIndex: resultStateIndex,
      documentType: "result",
      filterByMetadata: { stateIndex: resultStateIndex - 1 },
      domain: trajectory.domain,
      environment: trajectory.environment,
      ...(format === "clean-tree" ? { postIndexingDelayMs: POST_INDEXING_DELAY_MS } : {}),
      sessionType: "trajectory-result",
    },
  }
}

export class LongMemEvalV2Benchmark implements Benchmark {
  name = "longmemeval-v2"
  private questions: UnifiedQuestion[] = []
  private sessionsMap: Map<string, UnifiedSession[]> = new Map()
  private questionTypes: QuestionTypeRegistry = {}

  async load(config?: BenchmarkConfig): Promise<void> {
    const dataPath = config?.dataPath || DEFAULT_DATA_PATH
    const tier = process.env.LONGMEMEVAL_V2_TIER || process.env.LME_V2_TIER || DEFAULT_TIER
    const fullPath = join(process.cwd(), dataPath)
    const questionsPath = join(fullPath, "questions.jsonl")
    const trajectoriesPath = join(fullPath, "trajectories.jsonl")
    const haystackPath = join(fullPath, "haystacks", `lme_v2_${tier}.json`)

    requireFile(questionsPath, "LongMemEval-V2 questions.jsonl")
    requireFile(trajectoriesPath, "LongMemEval-V2 trajectories.jsonl")
    requireFile(haystackPath, `LongMemEval-V2 ${tier} haystack`)

    const rawQuestions = readJsonl<LongMemEvalV2Question>(questionsPath)
    const haystack = JSON.parse(readFileSync(haystackPath, "utf8")) as HaystackMap
    const trajectoryLimit = config?.trajectoryLimit
    const trajectoryDocument = parseTrajectoryDocument(config?.trajectoryDocument)
    const trajectoryFormat = parseTrajectoryFormat(config?.trajectoryFormat)
    if (
      trajectoryLimit !== undefined &&
      (!Number.isInteger(trajectoryLimit) || trajectoryLimit < 1)
    ) {
      throw new Error("LongMemEval-V2 trajectoryLimit must be a positive integer")
    }

    const selectedHaystack = Object.fromEntries(
      Object.entries(haystack).map(([questionId, trajectoryIds]) => [
        questionId,
        trajectoryLimit === undefined ? trajectoryIds : trajectoryIds.slice(0, trajectoryLimit),
      ])
    ) as HaystackMap
    const haystackQuestionIds = new Set(Object.keys(selectedHaystack))
    const selectedTrajectoryIds = new Set(Object.values(selectedHaystack).flat())

    const trajectorySessions = this.loadTrajectorySessions(
      trajectoriesPath,
      selectedTrajectoryIds,
      trajectoryDocument,
      trajectoryFormat
    )

    for (const item of rawQuestions) {
      if (!haystackQuestionIds.has(item.id)) continue

      const sessions = selectedHaystack[item.id].flatMap((trajectoryId) => {
        const trajectorySessionList = trajectorySessions.get(trajectoryId)
        if (!trajectorySessionList) {
          logger.warn(`Missing LongMemEval-V2 trajectory ${trajectoryId} for question ${item.id}`)
          return []
        }
        return trajectorySessionList
      })

      this.questions.push({
        questionId: item.id,
        question: item.question,
        questionType: item.question_type,
        groundTruth: item.answer,
        haystackSessionIds: sessions.map((session) => session.sessionId),
        metadata: {
          domain: item.domain,
          environment: item.environment,
          image: item.image,
          evalFunction: item.eval_function,
          haystackTier: tier,
          trajectoryCount: selectedHaystack[item.id].length,
          fullTrajectoryCount: haystack[item.id].length,
          trajectoryLimit,
          trajectoryDocument: config?.trajectoryDocument,
          trajectoryFormat,
        },
      })

      this.sessionsMap.set(item.id, sessions)
      this.questionTypes[item.question_type] ||= {
        id: item.question_type,
        alias: item.question_type,
        description: `${item.question_type} questions`,
      }
    }

    logger.info(
      `Loaded ${this.questions.length} LongMemEval-V2 ${tier} questions from ${dataPath}` +
        (trajectoryLimit === undefined
          ? ""
          : ` (first ${trajectoryLimit} ordered trajectories per question)`) +
        (config?.trajectoryDocument === undefined
          ? ""
          : ` (document ${config.trajectoryDocument})`) +
        ` (format ${trajectoryFormat})`
    )
  }

  private loadTrajectorySessions(
    trajectoriesPath: string,
    selectedTrajectoryIds: Set<string>,
    documentSelection: TrajectoryDocumentSelection,
    format: TrajectoryFormat
  ): Map<string, UnifiedSession[]> {
    const sessions = new Map<string, UnifiedSession[]>()

    for (const trajectory of readJsonl<LongMemEvalV2Trajectory>(trajectoriesPath)) {
      if (!selectedTrajectoryIds.has(trajectory.id)) continue

      const trajectorySessions =
        documentSelection.type === "overview"
          ? [trajectoryOverviewToSession(trajectory, format)]
          : documentSelection.type === "state"
            ? trajectory.states
                .filter((state) => state.state_index === documentSelection.stateIndex)
                .map((state) => stateToSession(trajectory, state, format))
            : documentSelection.type === "result"
              ? isCleanFormat(format)
                ? [trajectoryResultToSession(trajectory, format)]
                : []
              : [
                  trajectoryOverviewToSession(trajectory, format),
                  ...trajectory.states.map((state) => stateToSession(trajectory, state, format)),
                  ...(isCleanFormat(format) ? [trajectoryResultToSession(trajectory, format)] : []),
                ]

      if (trajectorySessions.length === 0) {
        logger.warn(
          `Trajectory ${trajectory.id} has no selected ${documentSelection.type === "state" ? `state ${documentSelection.stateIndex}` : "document"}`
        )
      }
      sessions.set(trajectory.id, trajectorySessions)
    }

    logger.info(`Prepared ${sessions.size} LongMemEval-V2 trajectories for ingestion`)
    return sessions
  }

  getQuestions(filter?: QuestionFilter): UnifiedQuestion[] {
    let result = [...this.questions]

    if (filter?.questionTypes?.length) {
      result = result.filter((question) => filter.questionTypes!.includes(question.questionType))
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
    const question = this.questions.find((item) => item.questionId === questionId)
    return question?.groundTruth || ""
  }

  getQuestionTypes(): QuestionTypeRegistry {
    return this.questionTypes
  }
}

export default LongMemEvalV2Benchmark
