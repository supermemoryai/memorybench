import type {
  Benchmark,
  BenchmarkConfig,
  BenchmarkScope,
  DatasetIdentity,
  QuestionFilter,
} from "../../types/benchmark"
import type { BenchmarkProtocol } from "../../types/protocol"
import type {
  QuestionTypeRegistry,
  UnifiedMessage,
  UnifiedQuestion,
  UnifiedSession,
} from "../../types/unified"
import { BeamPaperProtocol } from "../../protocols/beam-paper"
import { BEAM_MEM0_NUGGET_PROFILE, BeamMem0NuggetProtocol } from "../../protocols/beam-mem0"
import { logger } from "../../utils/logger"
import {
  computeDatasetFingerprint,
  computeManifestHash,
  describeBeamSnapshot,
  describeBeamTemporalCoverage,
  loadPreparedBeamDataset,
  resolvePreparedSnapshotPath,
} from "./dataset"
import type {
  BeamCanonicalChat,
  BeamCanonicalQuestion,
  BeamDatasetManifest,
  BeamScale,
} from "./types"

const DEFAULT_DATA_PATH = "./data/benchmarks/beam"

export const BEAM_QUESTION_TYPES: QuestionTypeRegistry = {
  abstention: {
    id: "abstention",
    alias: "abstain",
    description: "Withhold answers when evidence is missing",
  },
  contradiction_resolution: {
    id: "contradiction_resolution",
    alias: "contradict",
    description: "Detect and reconcile inconsistent statements",
  },
  event_ordering: {
    id: "event_ordering",
    alias: "order",
    description: "Reconstruct event or information order",
  },
  information_extraction: {
    id: "information_extraction",
    alias: "extract",
    description: "Recall entities and factual details",
  },
  instruction_following: {
    id: "instruction_following",
    alias: "instruction",
    description: "Follow sustained user instructions",
  },
  knowledge_update: {
    id: "knowledge_update",
    alias: "update",
    description: "Retain updated facts over stale facts",
  },
  multi_session_reasoning: {
    id: "multi_session_reasoning",
    alias: "multi",
    description: "Reason across non-adjacent dialogue segments",
  },
  preference_following: {
    id: "preference_following",
    alias: "preference",
    description: "Adapt to evolving user preferences",
  },
  summarization: {
    id: "summarization",
    alias: "summary",
    description: "Summarize dialogue content",
  },
  temporal_reasoning: {
    id: "temporal_reasoning",
    alias: "temporal",
    description: "Reason about explicit and implicit time relations",
  },
}

function selectTierRecord<T>(
  record: Partial<Record<BeamScale, T>>,
  scales: readonly BeamScale[]
): Partial<Record<BeamScale, T>> {
  return Object.fromEntries(
    scales.map((scale) => {
      const value = record[scale]
      if (value === undefined) throw new Error(`BEAM manifest identity is missing tier ${scale}`)
      return [scale, value]
    })
  )
}

export function createBeamDatasetIdentity(
  manifest: BeamDatasetManifest,
  scales: readonly BeamScale[]
): DatasetIdentity {
  const selectedScales = [...scales]
  const selectedScaleSet = new Set(selectedScales)
  const sources = manifest.sources.filter((source) => selectedScaleSet.has(source.tier))
  const canonicalFiles = manifest.canonicalFiles.filter((file) =>
    selectedScales.some((scale) => file.path.startsWith(`canonical/${scale}/`))
  )
  const effectiveManifestCore: Omit<BeamDatasetManifest, "datasetFingerprint" | "manifestHash"> = {
    manifestSchemaVersion: manifest.manifestSchemaVersion,
    canonicalSchemaVersion: manifest.canonicalSchemaVersion,
    converter: manifest.converter,
    includedTiers: selectedScales,
    sources,
    canonicalFiles,
    counts: selectTierRecord(manifest.counts, selectedScales),
    orderedChatIds: selectTierRecord(manifest.orderedChatIds, selectedScales),
    orderedChatIdsDigest: selectTierRecord(manifest.orderedChatIdsDigest, selectedScales),
    orderedQuestionIds: selectTierRecord(manifest.orderedQuestionIds, selectedScales),
    orderedQuestionIdsDigest: selectTierRecord(manifest.orderedQuestionIdsDigest, selectedScales),
  }
  const datasetFingerprint = computeDatasetFingerprint(effectiveManifestCore)
  const manifestHash = computeManifestHash({ ...effectiveManifestCore, datasetFingerprint })
  return {
    datasetFingerprint,
    manifestHash,
    snapshotFingerprint: manifest.datasetFingerprint,
    snapshotManifestHash: manifest.manifestHash,
    manifestSchemaVersion: manifest.manifestSchemaVersion,
    canonicalSchemaVersion: manifest.canonicalSchemaVersion,
    converterVersion: manifest.converter.version,
    converterImplementationHash: manifest.converter.implementationHash,
    includedTiers: selectedScales,
    counts: effectiveManifestCore.counts as Record<string, unknown>,
    orderedQuestionIdsDigest: effectiveManifestCore.orderedQuestionIdsDigest as Record<
      string,
      string
    >,
    sourceFiles: sources.flatMap((source) =>
      source.files.map((file) => ({
        path: `${source.tier}/${file.path}`,
        byteSize: file.byteSize,
        sha256: file.sha256,
      }))
    ),
    canonicalFiles: canonicalFiles.map((file) => ({
      path: file.path,
      byteSize: file.byteSize,
      sha256: file.sha256,
    })),
    sources: sources.map((source) => ({
      repository: source.repository,
      split: source.split,
      revision: source.revision,
      sourceIdentity: source.sourceIdentity,
    })),
  }
}

function createSessions(chat: BeamCanonicalChat): UnifiedSession[] {
  return chat.sessions.map((session) => ({
    sessionId: session.sessionId,
    messages: session.messages.map(
      (message): UnifiedMessage => ({
        role: message.role,
        content: message.content,
        speaker: message.role,
        timestamp: message.timeAnchor,
      })
    ),
    metadata: {
      scale: chat.scale,
      chatId: chat.chatId,
      ...(session.planNumber ? { planNumber: session.planNumber } : {}),
      batchNumber: session.batchNumber,
      turnIndex: session.turnIndex,
      ...(session.documentDate
        ? { date: session.documentDate, documentDate: session.documentDate }
        : {}),
      ...(session.hadInvalidTimeAnchor ? { hadInvalidTimeAnchor: true } : {}),
      ...(session.hasPaddedAssistant ? { hasPaddedAssistant: true } : {}),
    },
  }))
}

function groundTruth(question: BeamCanonicalQuestion): string {
  return question.referenceAnswer || question.rubric.join("\n")
}

export class BeamBenchmark implements Benchmark {
  readonly name: string
  readonly scope: BenchmarkScope
  protocol: BenchmarkProtocol
  private readonly scales: BeamScale[]
  private questions: UnifiedQuestion[] = []
  private sessionsByQuestion = new Map<string, UnifiedSession[]>()
  private ingestionGroupByQuestion = new Map<string, string>()
  private datasetIdentity?: DatasetIdentity

  constructor(scales: BeamScale[], name: string) {
    this.scales = scales
    this.name = name
    this.scope = {
      displayName: scales.length === 1 ? `BEAM ${scales[0]}` : `BEAM ${scales.join("/")}`,
      includedTiers: [...scales],
      coverage: "subset",
    }
    this.protocol = new BeamPaperProtocol()
  }

  async load(config: BenchmarkConfig = {}): Promise<void> {
    if (config.evaluationProfile === BEAM_MEM0_NUGGET_PROFILE) {
      this.protocol = new BeamMem0NuggetProtocol({
        retrievalTopK: config.retrievalTopK,
        answerCutoff: config.answerCutoff,
      })
    } else {
      if (config.evaluationProfile) {
        throw new Error(`Unsupported BEAM evaluation profile: ${config.evaluationProfile}`)
      }
      if (config.answerCutoff !== undefined) {
        throw new Error("--answer-cutoff is only valid with --evaluation-profile mem0-nugget")
      }
      this.protocol = new BeamPaperProtocol({ retrievalTopK: config.retrievalTopK })
    }
    this.questions = []
    this.sessionsByQuestion.clear()
    this.ingestionGroupByQuestion.clear()
    const dataPath = config.dataPath || DEFAULT_DATA_PATH
    const snapshotPath = resolvePreparedSnapshotPath(dataPath, config.datasetRevision)
    const prepared = await loadPreparedBeamDataset({
      snapshotPath,
      tiers: this.scales,
      expectedDatasetFingerprint: config.datasetRevision,
    })
    this.datasetIdentity = createBeamDatasetIdentity(prepared.manifest, this.scales)
    logger.info(describeBeamTemporalCoverage(prepared.manifest.counts, this.scales))

    for (const scale of this.scales) {
      const chats = prepared.chatsByTier[scale]
      const questions = prepared.questionsByTier[scale]
      if (!chats || !questions) throw new Error(`Prepared BEAM snapshot is missing ${scale}`)
      const sessionsByChat = new Map(
        chats.map((chat) => [chat.chatId, createSessions(chat)] as const)
      )
      for (const sourceQuestion of questions) {
        const sessions = sessionsByChat.get(sourceQuestion.chatId)
        if (!sessions) {
          throw new Error(
            `BEAM ${scale} question ${sourceQuestion.questionId} references missing chat ${sourceQuestion.chatId}`
          )
        }
        const sessionIds = sessions.map((session) => session.sessionId)
        const ingestionGroupId = `beam-${scale}-${sourceQuestion.chatId}`
        const question: UnifiedQuestion = {
          questionId: sourceQuestion.questionId,
          question: sourceQuestion.question,
          questionType: sourceQuestion.questionType,
          groundTruth: groundTruth(sourceQuestion),
          haystackSessionIds: sessionIds,
          metadata: {
            scale,
            chatId: sourceQuestion.chatId,
            ingestionGroupId,
            rubric: sourceQuestion.rubric,
            difficulty: sourceQuestion.difficulty,
            referenceAnswer: sourceQuestion.referenceAnswer,
          },
        }
        this.protocol.validateQuestion(question)
        this.questions.push(question)
        this.sessionsByQuestion.set(question.questionId, sessions)
        this.ingestionGroupByQuestion.set(question.questionId, ingestionGroupId)
      }
    }

    logger.info(
      `Loaded ${this.questions.length} validated questions from ${describeBeamSnapshot(prepared.manifest)} (${this.scales.join(", ")})`
    )
  }

  getQuestions(filter?: QuestionFilter): UnifiedQuestion[] {
    let questions = [...this.questions]
    if (filter?.questionTypes?.length) {
      questions = questions.filter((question) =>
        filter.questionTypes!.includes(question.questionType)
      )
    }
    if (filter?.offset != null) questions = questions.slice(filter.offset)
    if (filter?.limit != null) questions = questions.slice(0, filter.limit)
    return questions
  }

  getHaystackSessions(questionId: string): UnifiedSession[] {
    const sessions = this.sessionsByQuestion.get(questionId)
    if (!sessions) throw new Error(`Unknown BEAM question: ${questionId}`)
    return sessions
  }

  getGroundTruth(questionId: string): string {
    const question = this.questions.find((candidate) => candidate.questionId === questionId)
    if (!question) throw new Error(`Unknown BEAM question: ${questionId}`)
    return question.groundTruth
  }

  getQuestionTypes(): QuestionTypeRegistry {
    return BEAM_QUESTION_TYPES
  }

  getIngestionGroupId(questionId: string): string {
    const groupId = this.ingestionGroupByQuestion.get(questionId)
    if (!groupId) throw new Error(`Unknown BEAM question: ${questionId}`)
    return groupId
  }

  getDatasetIdentity(): DatasetIdentity | undefined {
    return this.datasetIdentity
  }
}

export class Beam1MBenchmark extends BeamBenchmark {
  constructor() {
    super(["1M"], "beam-1m")
  }
}

export class Beam10MBenchmark extends BeamBenchmark {
  constructor() {
    super(["10M"], "beam-10m")
  }
}

export class Beam1M10MBenchmark extends BeamBenchmark {
  constructor() {
    super(["1M", "10M"], "beam-1m-10m")
  }
}

export default BeamBenchmark
