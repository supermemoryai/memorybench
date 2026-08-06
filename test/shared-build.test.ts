import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import type { Benchmark } from "../src/types/benchmark"
import type { BuildCheckpoint, RunCheckpoint } from "../src/types/checkpoint"
import type { BenchmarkProtocol, ProtocolIdentity } from "../src/types/protocol"
import type {
  AwaitIndexingOptions,
  IngestOptions,
  Provider,
  SearchOptions,
} from "../src/types/provider"
import type {
  CanonicalIngestionDocument,
  UnifiedQuestion,
  UnifiedSearchResult,
  UnifiedSession,
} from "../src/types/unified"
import {
  assertCompletedSessionsAreOrderedPrefix,
  assertBuildCheckpointConsistency,
  assertResumeBuilds,
  cloneCompletedBuildsForReuse,
  createBuildCheckpoint,
  prepareValidatedBuildPlans,
} from "../src/orchestrator/builds"
import { CheckpointManager } from "../src/orchestrator/checkpoint"
import { runIngestPhase } from "../src/orchestrator/phases/ingest"
import { runIndexingPhase } from "../src/orchestrator/phases/indexing"
import { runSearchPhase } from "../src/orchestrator/phases/search"

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function createTempRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "memorybench-shared-build-"))
  tempRoots.push(path)
  return path
}

const protocolIdentity: ProtocolIdentity = {
  id: "test.protocol",
  version: "1.0.0",
  configFingerprint: "config",
  implementationFingerprint: "implementation",
  ingestionPolicyHash: "ingestion",
  retrievalPolicyHash: "retrieval",
  answerPromptHash: "answer",
  evaluatorHash: "evaluator",
  aggregationHash: "aggregation",
}

function question(questionId: string, haystackSessionIds = ["s1", "s2", "s3"]): UnifiedQuestion {
  return {
    questionId,
    question: `Question ${questionId}`,
    questionType: "test",
    groundTruth: `Ground truth ${questionId}`,
    haystackSessionIds,
  }
}

function sessions(): UnifiedSession[] {
  return [
    {
      sessionId: "s1",
      messages: [
        { role: "user", content: "First user message" },
        { role: "assistant", content: "First assistant message" },
      ],
      metadata: { documentDate: "2024-01-01" },
    },
    {
      sessionId: "s2",
      messages: [
        { role: "user", content: "Second user message" },
        { role: "assistant", content: "Second assistant message" },
      ],
      metadata: { documentDate: "2024-01-02" },
    },
    {
      sessionId: "s3",
      messages: [
        { role: "user", content: "Third user message" },
        { role: "assistant", content: "Third assistant message" },
      ],
    },
  ]
}

function testProtocol(input?: {
  planningCalls?: string[]
  requestedTopK?: number
  answerCutoff?: number
  readinessBarrier?: "after-build" | "after-each-document"
  processingMode?: "provider-default" | "instant"
}): BenchmarkProtocol {
  const requestedTopK = input?.requestedTopK ?? 5
  const answerCutoff = input?.answerCutoff ?? requestedTopK
  return {
    identity: protocolIdentity,
    auxiliaryRetrievalEvaluation: "disabled",
    ingestionExecutionPolicy: {
      readinessBarrier: input?.readinessBarrier ?? "after-build",
      processingMode: input?.processingMode ?? "provider-default",
    },
    validateQuestion(value) {
      if (!value.questionId) throw new Error("missing question ID")
    },
    createIngestionPlan({ question: value, sessions: sourceSessions }) {
      input?.planningCalls?.push(value.questionId)
      return sourceSessions.map((session): CanonicalIngestionDocument => {
        const documentDate =
          typeof session.metadata?.documentDate === "string"
            ? session.metadata.documentDate
            : undefined
        const transcript = session.messages
          .map((message) => `[${message.role.toUpperCase()}]\n${message.content}`)
          .join("\n\n")
        return {
          customId: session.sessionId,
          content: documentDate ? `DOCUMENT_DATE: ${documentDate}\n\n${transcript}` : transcript,
          metadata: {
            sessionId: session.sessionId,
            ...(documentDate ? { documentDate } : {}),
          },
          messages: session.messages,
        }
      })
    },
    createRetrievalPlan({ question: value }) {
      return {
        query: value.question,
        requestedTopK,
        answerCutoff,
        threshold: 0.2,
        searchMode: "hybrid",
      }
    },
    createAnswerPlan({ results }) {
      return {
        request: { prompt: "answer" },
        baseRequest: { prompt: "answer" },
        answerEvidenceCount: results.length,
      }
    },
    async evaluateQuestion({ question: value }) {
      return {
        questionId: value.questionId,
        questionType: value.questionType,
        primaryScore: 1,
        passed: true,
        explanation: "test",
      }
    },
    aggregateQuality({ evaluations }) {
      const average =
        evaluations.length === 0
          ? 0
          : evaluations.reduce((sum, evaluation) => sum + evaluation.primaryScore, 0) /
            evaluations.length
      return {
        primaryMetric: { key: "score", value: average, higherIsBetter: true },
        metrics: { average },
      }
    },
  }
}

function testBenchmark(input: {
  questions: UnifiedQuestion[]
  sessionsByQuestion: Record<string, UnifiedSession[]>
  protocol?: BenchmarkProtocol
  groupId?: string
}): Benchmark {
  return {
    name: "test-benchmark",
    scope: { displayName: "Test", includedTiers: ["test"], coverage: "full" },
    protocol: input.protocol ?? testProtocol(),
    async load() {},
    getQuestions() {
      return input.questions
    },
    getHaystackSessions(questionId) {
      return input.sessionsByQuestion[questionId] ?? []
    },
    getGroundTruth(questionId) {
      return input.questions.find((item) => item.questionId === questionId)?.groundTruth ?? ""
    },
    getQuestionTypes() {
      return { test: { id: "test", alias: "test", description: "Test" } }
    },
    getIngestionGroupId() {
      return input.groupId ?? "shared-chat"
    },
  }
}

function preparePlans(benchmark: Benchmark, questions: UnifiedQuestion[], ingestBatchSize = 1) {
  return prepareValidatedBuildPlans({
    benchmark,
    questions,
    provider: "fake",
    providerAdapterVersion: "1",
    providerPromptFingerprint: "fake-prompts",
    providerIngestionConfigFingerprint: "fake-ingestion-config",
    dataSourceRunId: "source-run",
    ingestBatchSize,
  })
}

async function initializeCheckpoint(input: {
  manager: CheckpointManager
  plans: ReturnType<typeof preparePlans>
  questions: UnifiedQuestion[]
}): Promise<RunCheckpoint> {
  const checkpoint = input.manager.create(
    "test-run",
    "fake",
    "test-benchmark",
    "fake-judge",
    "fake-answer",
    {
      providerAdapterVersion: "1",
      providerPromptFingerprint: "fake-prompts",
      benchmarkScope: { displayName: "Test", includedTiers: ["test"], coverage: "full" },
      protocolIdentity,
      selectedQuestionIdsDigest: "selected",
      benchmarkInputFingerprint: "benchmark-input",
      retrievalTopK: 5,
      concurrency: { default: 1 },
    }
  )
  for (const plan of input.plans) input.manager.initBuild(checkpoint, createBuildCheckpoint(plan))
  for (const value of input.questions) {
    const plan = input.plans.find((candidate) =>
      candidate.memberQuestionIds.includes(value.questionId)
    )!
    input.manager.initQuestion(checkpoint, value.questionId, plan.buildId, {
      question: value.question,
      groundTruth: value.groundTruth,
      questionType: value.questionType,
    })
  }
  input.manager.save(checkpoint)
  await input.manager.flush(checkpoint.runId)
  return checkpoint
}

class FakeProvider implements Provider {
  name = "fake"
  adapterVersion = "1"
  searchRequestStructure = { kind: "single" } as const
  concurrency = { default: 1 }
  ingestAttempts: string[] = []
  successfulIngests: string[] = []
  indexingCalls = 0
  searchCalls: SearchOptions[] = []
  failOnceForSession?: string
  failAlwaysForSession?: string
  omitIndexingProgress = false
  searchResults: UnifiedSearchResult[] = []
  searchRawReturnedCount?: number

  async initialize(): Promise<void> {}

  getIngestionConfigFingerprint(): string {
    return "fake-ingestion-config"
  }

  async ingest(documents: CanonicalIngestionDocument[]) {
    const sessionIds = documents.map((document) => document.metadata.sessionId)
    this.ingestAttempts.push(...sessionIds)
    const failedSession = sessionIds.find(
      (sessionId) =>
        this.failAlwaysForSession === sessionId || this.failOnceForSession === sessionId
    )
    if (failedSession) {
      if (this.failOnceForSession === failedSession) this.failOnceForSession = undefined
      throw new Error(`injected failure for ${failedSession}`)
    }
    this.successfulIngests.push(...sessionIds)
    return { documentIds: sessionIds.map((sessionId) => `doc-${sessionId}`) }
  }

  async awaitIndexing(
    result: { documentIds: string[]; taskIds?: string[] },
    _containerTag: string,
    onProgress?: (progress: { completedIds: string[]; failedIds: string[]; total: number }) => void
  ) {
    this.indexingCalls++
    if (this.omitIndexingProgress) return
    const completedIds = [...result.documentIds, ...(result.taskIds ?? [])]
    onProgress?.({ completedIds, failedIds: [], total: completedIds.length })
  }

  async search(_query: string, options: SearchOptions) {
    this.searchCalls.push(options)
    const rawReturnedCount = this.searchRawReturnedCount ?? this.searchResults.length
    return {
      results: this.searchResults,
      diagnostics: {
        requestedLimit: options.limit,
        providerRequests: [{ operation: "search", limit: options.limit }],
        rawReturnedCount,
        normalizedCount: this.searchResults.length,
        droppedCount: rawReturnedCount - this.searchResults.length,
        droppedResults: Array.from(
          { length: rawReturnedCount - this.searchResults.length },
          (_, offset) => ({
            index: this.searchResults.length + offset,
            reason: "malformed-result" as const,
          })
        ),
      },
    }
  }

  async clear(): Promise<void> {}
}

class CountingCheckpointManager extends CheckpointManager {
  saveCalls = 0

  override save(checkpoint: RunCheckpoint): void {
    this.saveCalls++
    super.save(checkpoint)
  }
}

class CausalProvider extends FakeProvider {
  events: string[] = []
  processingModes: Array<IngestOptions["processingMode"]> = []
  omitReadinessOnceForSession?: string
  readinessTimeouts: Array<number | undefined> = []

  override async ingest(documents: CanonicalIngestionDocument[], options: IngestOptions) {
    const sessionIds = documents.map((document) => document.metadata.sessionId)
    this.events.push(`add:${sessionIds.join(",")}`)
    this.processingModes.push(options.processingMode)
    return super.ingest(documents)
  }

  override async awaitIndexing(
    result: { documentIds: string[]; taskIds?: string[] },
    containerTag: string,
    onProgress?: (progress: { completedIds: string[]; failedIds: string[]; total: number }) => void,
    options?: AwaitIndexingOptions
  ) {
    this.readinessTimeouts.push(options?.timeoutMs)
    const sessionIds = result.documentIds.map((documentId) => documentId.replace(/^doc-/, ""))
    this.events.push(`wait:${sessionIds.join(",")}`)
    if (this.omitReadinessOnceForSession && sessionIds.includes(this.omitReadinessOnceForSession)) {
      this.omitReadinessOnceForSession = undefined
      this.indexingCalls++
      onProgress?.({ completedIds: [], failedIds: [], total: result.documentIds.length })
      return
    }
    await super.awaitIndexing(result, containerTag, onProgress)
    this.events.push(`ready:${sessionIds.join(",")}`)
  }
}

class PartialBatchCausalProvider extends CausalProvider {
  private returnedPartialFailure = false

  override async ingest(documents: CanonicalIngestionDocument[], options: IngestOptions) {
    if (!this.returnedPartialFailure && documents.some((document) => document.customId === "s2")) {
      this.returnedPartialFailure = true
      const sessionIds = documents.map((document) => document.metadata.sessionId)
      this.events.push(`add:${sessionIds.join(",")}`)
      this.processingModes.push(options.processingMode)
      this.ingestAttempts.push(...sessionIds)
      this.successfulIngests.push(...sessionIds.filter((sessionId) => sessionId !== "s2"))
      return {
        documentIds: sessionIds
          .filter((sessionId) => sessionId !== "s2")
          .map((sessionId) => `doc-${sessionId}`),
        items: documents.map((document) =>
          document.customId === "s2"
            ? { customId: document.customId, documentIds: [], error: "invalid document" }
            : { customId: document.customId, documentIds: [`doc-${document.customId}`] }
        ),
      }
    }
    return super.ingest(documents, options)
  }
}

class EventCheckpointManager extends CheckpointManager {
  constructor(
    root: string,
    private readonly events: string[]
  ) {
    super(root)
  }

  override recordIngestProgress(
    checkpoint: RunCheckpoint,
    buildId: string,
    input: Parameters<CheckpointManager["recordIngestProgress"]>[2]
  ): void {
    this.events.push(`checkpoint:${input.sessionId}`)
    super.recordIngestProgress(checkpoint, buildId, input)
  }
}

class ConcurrentCausalProvider extends CausalProvider {
  firstSessionContainers = new Set<string>()
  private resolveBothFirstSessions!: () => void
  private readonly bothFirstSessions = new Promise<void>((resolve) => {
    this.resolveBothFirstSessions = resolve
  })

  override async ingest(documents: CanonicalIngestionDocument[], options: IngestOptions) {
    const result = await super.ingest(documents, options)
    if (documents[0].metadata.sessionId === "s1") {
      this.firstSessionContainers.add(options.containerTag)
      if (this.firstSessionContainers.size === 2) this.resolveBothFirstSessions()
    }
    return result
  }

  override async awaitIndexing(
    result: { documentIds: string[]; taskIds?: string[] },
    containerTag: string,
    onProgress?: (progress: { completedIds: string[]; failedIds: string[]; total: number }) => void
  ) {
    if (result.documentIds[0] === "doc-s1") {
      await Promise.race([
        this.bothFirstSessions,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("independent builds did not run concurrently")), 250)
        ),
      ])
    }
    return super.awaitIndexing(result, containerTag, onProgress)
  }
}

class CrashWindowProvider extends FakeProvider {
  remoteDocuments = new Map<string, string>()
  remoteCreates = 0
  crashAfterFirstRemoteSuccess = true

  override async ingest(documents: CanonicalIngestionDocument[]) {
    const sessionId = documents[0].metadata.sessionId
    this.ingestAttempts.push(sessionId)
    const existing = this.remoteDocuments.get(sessionId)
    if (existing) return { documentIds: [existing] }

    const documentId = `doc-${sessionId}`
    this.remoteDocuments.set(sessionId, documentId)
    this.remoteCreates++
    if (this.crashAfterFirstRemoteSuccess) {
      this.crashAfterFirstRemoteSuccess = false
      throw new Error("simulated crash after remote success")
    }
    this.successfulIngests.push(sessionId)
    return { documentIds: [documentId] }
  }
}

function markBuildIngested(build: BuildCheckpoint): void {
  build.ingest.status = "completed"
  build.ingest.completedSessionIds = [...build.haystack.orderedSessionIds]
  build.ingest.documentIds = build.haystack.orderedSessionIds.map((id) => `doc-${id}`)
}

function markBuildIndexed(build: BuildCheckpoint): void {
  markBuildIngested(build)
  build.indexing.status = "completed"
  build.indexing.completedIds = [...build.ingest.documentIds, ...build.ingest.taskIds]
  build.indexing.failedIds = []
}

describe("shared-build planning and identity", () => {
  test("twenty independently planned questions create one build and twenty references", async () => {
    const questions = Array.from({ length: 20 }, (_, index) => question(`q${index + 1}`))
    const planningCalls: string[] = []
    const sessionsByQuestion = Object.fromEntries(
      questions.map((value) => [value.questionId, sessions()])
    )
    const benchmark = testBenchmark({
      questions,
      sessionsByQuestion,
      protocol: testProtocol({ planningCalls }),
    })

    const plans = preparePlans(benchmark, questions)
    expect(planningCalls).toEqual(questions.map((value) => value.questionId))
    expect(plans).toHaveLength(1)
    expect(plans[0].memberQuestionIds).toHaveLength(20)
    expect(plans[0].documents).toHaveLength(3)

    const manager = new CheckpointManager(await createTempRoot())
    const checkpoint = await initializeCheckpoint({ manager, plans, questions })
    expect(Object.keys(checkpoint.builds)).toHaveLength(1)
    expect(new Set(Object.values(checkpoint.questions).map((value) => value.buildId)).size).toBe(1)
  })

  test("distinct groups with identical haystacks receive distinct containers", () => {
    const questions = [question("q1"), question("q2")]
    const benchmark = testBenchmark({
      questions,
      sessionsByQuestion: { q1: sessions(), q2: sessions() },
    })
    benchmark.getIngestionGroupId = (questionId) => questionId

    const plans = preparePlans(benchmark, questions)
    expect(plans).toHaveLength(2)
    expect(plans[0].buildId).not.toBe(plans[1].buildId)
    expect(plans[0].containerTag).not.toBe(plans[1].containerTag)
  })

  test("validates declared IDs against raw sessions before protocol planning", () => {
    const value = question("q1")
    const base = testProtocol()
    const droppingProtocol: BenchmarkProtocol = {
      ...base,
      createIngestionPlan(input) {
        return base.createIngestionPlan(input).slice(0, -1)
      },
    }
    const benchmark = testBenchmark({
      questions: [value],
      sessionsByQuestion: { q1: sessions() },
      protocol: droppingProtocol,
    })
    expect(() => preparePlans(benchmark, [value])).toThrow("ordered ingestion plan")

    const undeclared = question("undeclared", ["s1", "s2"])
    expect(() =>
      preparePlans(
        testBenchmark({
          questions: [undeclared],
          sessionsByQuestion: { undeclared: sessions() },
        }),
        [undeclared]
      )
    ).toThrow("ordered sessions returned by getHaystackSessions()")
  })

  const mismatches: Array<{
    name: string
    mutate: (value: UnifiedSession[]) => UnifiedSession[]
  }> = [
    {
      name: "content",
      mutate(value) {
        value[0].messages[0].content = "changed content"
        return value
      },
    },
    {
      name: "role",
      mutate(value) {
        value[0].messages[0].role = "assistant"
        return value
      },
    },
    {
      name: "date",
      mutate(value) {
        value[0].metadata = { documentDate: "2025-01-01" }
        return value
      },
    },
    {
      name: "message order",
      mutate(value) {
        value[0].messages.reverse()
        return value
      },
    },
    {
      name: "message speaker",
      mutate(value) {
        value[0].messages[0]!.speaker = "Different speaker"
        return value
      },
    },
    {
      name: "message timestamp",
      mutate(value) {
        value[0].messages[0]!.timestamp = "2025-01-01T12:34:56Z"
        return value
      },
    },
  ]

  for (const mismatch of mismatches) {
    test(`rejects grouped questions with a ${mismatch.name} mismatch`, () => {
      const questions = [question("q1"), question("q2")]
      const benchmark = testBenchmark({
        questions,
        sessionsByQuestion: { q1: sessions(), q2: mismatch.mutate(sessions()) },
      })
      expect(() => preparePlans(benchmark, questions)).toThrow("different haystacks")
    })
  }

  test("fingerprints structured messages even when their rendered transcripts collide", () => {
    const questions = [question("q1"), question("q2")]
    const first = sessions()
    const second = sessions()
    first[0].messages = [{ role: "user", content: "First\n\n[ASSISTANT]\nSecond" }]
    second[0].messages = [
      { role: "user", content: "First" },
      { role: "assistant", content: "Second" },
    ]

    const benchmark = testBenchmark({
      questions,
      sessionsByQuestion: { q1: first, q2: second },
    })
    expect(() => preparePlans(benchmark, questions)).toThrow("different haystacks")
  })

  test("rejects grouped questions with session order or session identity drift", () => {
    const reorderedQuestions = [question("q1"), question("q2", ["s2", "s1", "s3"])]
    const reordered = sessions()
    reordered.splice(0, 2, reordered[1], reordered[0])
    expect(() =>
      preparePlans(
        testBenchmark({
          questions: reorderedQuestions,
          sessionsByQuestion: { q1: sessions(), q2: reordered },
        }),
        reorderedQuestions
      )
    ).toThrow("different haystacks")

    const changedId = sessions()
    changedId[1].sessionId = "different-session"
    const changedIdQuestions = [question("q1"), question("q2", ["s1", "different-session", "s3"])]
    expect(() =>
      preparePlans(
        testBenchmark({
          questions: changedIdQuestions,
          sessionsByQuestion: { q1: sessions(), q2: changedId },
        }),
        changedIdQuestions
      )
    ).toThrow("different haystacks")
  })

  test("rejects duplicate and reordered declared haystack IDs", () => {
    const duplicate = question("duplicate", ["s1", "s1", "s3"])
    expect(() =>
      preparePlans(
        testBenchmark({ questions: [duplicate], sessionsByQuestion: { duplicate: sessions() } }),
        [duplicate]
      )
    ).toThrow("duplicate haystackSessionIds")

    const reordered = question("reordered", ["s2", "s1", "s3"])
    expect(() =>
      preparePlans(
        testBenchmark({ questions: [reordered], sessionsByQuestion: { reordered: sessions() } }),
        [reordered]
      )
    ).toThrow("do not exactly match")
  })

  test("accepts only an ordered completed-session prefix", () => {
    const value = question("q1")
    const benchmark = testBenchmark({ questions: [value], sessionsByQuestion: { q1: sessions() } })
    const build = createBuildCheckpoint(preparePlans(benchmark, [value])[0])

    for (const valid of [[], ["s1"], ["s1", "s2"], ["s1", "s2", "s3"]]) {
      build.ingest.completedSessionIds = valid
      expect(() => assertCompletedSessionsAreOrderedPrefix(build)).not.toThrow()
    }
    for (const invalid of [
      ["s2"],
      ["s1", "s1"],
      ["s1", "s3"],
      ["s2", "s1"],
      ["s1", "s2", "unknown"],
    ]) {
      build.ingest.completedSessionIds = invalid
      expect(() => assertCompletedSessionsAreOrderedPrefix(build)).toThrow()
    }
  })

  test("rejects nested haystack schema and algorithm drift", () => {
    const value = question("q1")
    const benchmark = testBenchmark({ questions: [value], sessionsByQuestion: { q1: sessions() } })
    const build = createBuildCheckpoint(preparePlans(benchmark, [value])[0])

    const schemaDrift = structuredClone(build)
    ;(schemaDrift.haystack as { schemaVersion: number }).schemaVersion = 1
    expect(() => assertBuildCheckpointConsistency(schemaDrift)).toThrow(
      "unsupported haystack schema"
    )

    const algorithmDrift = structuredClone(build)
    ;(algorithmDrift.haystack as { algorithm: string }).algorithm = "md5"
    expect(() => assertBuildCheckpointConsistency(algorithmDrift)).toThrow(
      "unsupported haystack algorithm"
    )
  })

  test("provider ingestion configuration changes the build but not the haystack", () => {
    const value = question("q1")
    const benchmark = testBenchmark({ questions: [value], sessionsByQuestion: { q1: sessions() } })
    const makePlan = (providerIngestionConfigFingerprint: string) =>
      prepareValidatedBuildPlans({
        benchmark,
        questions: [value],
        provider: "fake",
        providerAdapterVersion: "1",
        providerPromptFingerprint: "fake-prompts",
        providerIngestionConfigFingerprint,
        dataSourceRunId: "source-run",
      })[0]

    const first = makePlan("config-a")
    const second = makePlan("config-b")
    expect(second.haystack.fingerprint).toBe(first.haystack.fingerprint)
    expect(second.buildFingerprint).not.toBe(first.buildFingerprint)
    expect(second.buildId).not.toBe(first.buildId)
  })

  test("non-ingested question fields do not change the haystack identity", () => {
    const firstQuestion = question("q1")
    firstQuestion.metadata = { rubric: ["first rubric"], difficulty: "easy" }
    const secondQuestion = {
      ...firstQuestion,
      question: "Completely different probe",
      groundTruth: "Different answer",
      metadata: { rubric: ["different rubric"], difficulty: "hard" },
    }
    const first = preparePlans(
      testBenchmark({ questions: [firstQuestion], sessionsByQuestion: { q1: sessions() } }),
      [firstQuestion]
    )[0]
    const second = preparePlans(
      testBenchmark({ questions: [secondQuestion], sessionsByQuestion: { q1: sessions() } }),
      [secondQuestion]
    )[0]

    expect(second.haystack.fingerprint).toBe(first.haystack.fingerprint)
  })

  test("rejects tampered persisted haystack identity and question references on resume", async () => {
    const root = await createTempRoot()
    const manager = new CheckpointManager(root)
    const questions = [question("q1"), question("q2")]
    const benchmark = testBenchmark({
      questions,
      sessionsByQuestion: { q1: sessions(), q2: sessions() },
    })
    const plans = preparePlans(benchmark, questions)
    const checkpoint = await initializeCheckpoint({ manager, plans, questions })
    expect(() => assertResumeBuilds(checkpoint, plans)).not.toThrow()

    const tamperedHaystack = structuredClone(checkpoint)
    Object.values(tamperedHaystack.builds)[0].haystack.orderedSessionIds[0] = "tampered"
    expect(() => assertResumeBuilds(tamperedHaystack, plans)).toThrow(
      "tampered haystack fingerprint"
    )

    const rewiredQuestion = structuredClone(checkpoint)
    rewiredQuestion.questions.q1.buildId = "missing-build"
    expect(() => assertResumeBuilds(rewiredQuestion, plans)).toThrow(
      "invalid member question reference"
    )

    const ghostMember = structuredClone(checkpoint)
    Object.values(ghostMember.builds)[0].memberQuestionIds.push("ghost-question")
    expect(() => assertResumeBuilds(ghostMember, plans)).toThrow(
      "invalid member question reference"
    )

    const wrongTargets = structuredClone(checkpoint)
    wrongTargets.targetQuestionIds = ["q1"]
    expect(() => assertResumeBuilds(wrongTargets, plans)).toThrow("targetQuestionIds do not match")

    const missingQuestion = structuredClone(checkpoint)
    delete missingQuestion.questions.q2
    expect(() => assertResumeBuilds(missingQuestion, plans)).toThrow(
      "invalid member question reference"
    )
  })

  test("rejects checkpoint phases marked complete before their underlying work", async () => {
    const root = await createTempRoot()
    const manager = new CheckpointManager(root)
    const value = question("q1")
    const benchmark = testBenchmark({ questions: [value], sessionsByQuestion: { q1: sessions() } })
    const plans = preparePlans(benchmark, [value])
    const checkpoint = await initializeCheckpoint({ manager, plans, questions: [value] })
    const build = Object.values(checkpoint.builds)[0]
    build.ingest.status = "completed"
    build.ingest.completedSessionIds = ["s1"]
    expect(() => assertResumeBuilds(checkpoint, plans)).toThrow(
      "marked ingested before every session completed"
    )

    markBuildIndexed(build)
    checkpoint.questions.q1.phases.search.status = "completed"
    expect(() => assertResumeBuilds(checkpoint, plans)).toThrow("incomplete completed-search state")
  })

  test("rejects a causal build that claims ingestion completed without readiness", async () => {
    const root = await createTempRoot()
    const manager = new CheckpointManager(root)
    const value = question("q1")
    const benchmark = testBenchmark({
      questions: [value],
      sessionsByQuestion: { q1: sessions() },
      protocol: testProtocol({
        readinessBarrier: "after-each-document",
        processingMode: "instant",
      }),
    })
    const plans = preparePlans(benchmark, [value])
    const checkpoint = await initializeCheckpoint({ manager, plans, questions: [value] })
    const build = Object.values(checkpoint.builds)[0]
    markBuildIngested(build)

    expect(() => assertResumeBuilds(checkpoint, plans)).toThrow(
      "completed causal ingestion without completing its per-document indexing barriers"
    )
  })
})

describe("shared-build lifecycle", () => {
  test("clones only completed ingest/index builds for a clean query-time run", async () => {
    const root = await createTempRoot()
    const manager = new CheckpointManager(root)
    const value = question("q1")
    const benchmark = testBenchmark({ questions: [value], sessionsByQuestion: { q1: sessions() } })
    const plans = preparePlans(benchmark, [value])
    const source = await initializeCheckpoint({ manager, plans, questions: [value] })
    markBuildIndexed(Object.values(source.builds)[0])

    const [reused] = cloneCompletedBuildsForReuse(source, plans)

    expect(reused.sourceRunId).toBe(source.runId)
    expect(reused.reused).toBe(true)
    expect(reused.reusedPhases).toEqual({ ingest: true, indexing: true })
    expect(reused.containerTag).toBe(Object.values(source.builds)[0].containerTag)
    expect(reused).not.toBe(Object.values(source.builds)[0])
  })

  test("refuses source-build reuse before indexing completes", async () => {
    const root = await createTempRoot()
    const manager = new CheckpointManager(root)
    const value = question("q1")
    const benchmark = testBenchmark({ questions: [value], sessionsByQuestion: { q1: sessions() } })
    const plans = preparePlans(benchmark, [value])
    const source = await initializeCheckpoint({ manager, plans, questions: [value] })

    expect(() => cloneCompletedBuildsForReuse(source, plans)).toThrow("ingestion is incomplete")
  })

  test("stores build state once and questions own only query phases", async () => {
    const root = await createTempRoot()
    const manager = new CheckpointManager(root)
    const questions = [question("q1"), question("q2")]
    const benchmark = testBenchmark({
      questions,
      sessionsByQuestion: { q1: sessions(), q2: sessions() },
    })
    const plans = preparePlans(benchmark, questions)
    const checkpoint = await initializeCheckpoint({ manager, plans, questions })

    expect(Object.keys(checkpoint.builds)).toHaveLength(1)
    for (const value of Object.values(checkpoint.questions)) {
      expect(Object.keys(value.phases).sort()).toEqual(["answer", "evaluate", "search"])
      expect("ingest" in value.phases).toBe(false)
      expect("indexing" in value.phases).toBe(false)
      expect("sessions" in value).toBe(false)
      expect("containerTag" in value).toBe(false)
    }
  })

  test("copied runs distinguish fully reused builds from reused ingestion", async () => {
    const root = await createTempRoot()
    const manager = new CheckpointManager(root)
    const value = question("q1")
    const benchmark = testBenchmark({
      questions: [value],
      sessionsByQuestion: { q1: sessions() },
    })
    const plans = preparePlans(benchmark, [value])
    const source = await initializeCheckpoint({ manager, plans, questions: [value] })
    const sourceBuild = Object.values(source.builds)[0]
    markBuildIndexed(sourceBuild)
    manager.save(source)
    await manager.flush(source.runId)

    const indexingCopy = manager.copyCheckpoint(source.runId, "copy-indexing", "indexing")
    const indexingBuild = Object.values(indexingCopy.builds)[0]
    expect(indexingBuild.reused).toBe(false)
    expect(indexingBuild.reusedPhases).toEqual({ ingest: true, indexing: false })
    expect(indexingBuild.ingest.status).toBe("completed")
    expect(indexingBuild.indexing.status).toBe("pending")

    const searchCopy = manager.copyCheckpoint(source.runId, "copy-search", "search")
    const searchBuild = Object.values(searchCopy.builds)[0]
    expect(searchBuild.reused).toBe(true)
    expect(searchBuild.reusedPhases).toEqual({ ingest: true, indexing: true })
    expect(searchBuild.indexing.status).toBe("completed")
  })

  test("copied runs own their reused search artifact after the source is deleted", async () => {
    const root = await createTempRoot()
    const manager = new CheckpointManager(root)
    const value = question("q1")
    const benchmark = testBenchmark({ questions: [value], sessionsByQuestion: { q1: sessions() } })
    const plans = preparePlans(benchmark, [value])
    const source = await initializeCheckpoint({ manager, plans, questions: [value] })
    markBuildIndexed(Object.values(source.builds)[0])
    const sourceResultPath = manager.getQuestionResultsPath(source.runId, value.questionId)
    await writeFile(sourceResultPath, JSON.stringify({ questionId: value.questionId }))
    source.questions.q1.phases.search = {
      status: "completed",
      retrievalPlan: {
        query: value.question,
        requestedTopK: 5,
        answerCutoff: 5,
        threshold: 0.2,
        searchMode: "hybrid",
      },
      resultFile: sourceResultPath,
      results: [],
      requestedCount: 5,
      rawReturnedCount: 0,
      returnedCount: 0,
      normalizedCount: 0,
      droppedCount: 0,
      droppedResults: [],
      providerRequests: [{ operation: "search", limit: 5 }],
      answerCutoff: 5,
    }
    manager.save(source)
    await manager.flush(source.runId)

    const copy = manager.copyCheckpoint(source.runId, "answer-copy-with-results", "answer")
    await manager.flush(copy.runId)
    const copiedResultPath = manager.getQuestionResultsPath(copy.runId, value.questionId)
    expect(copy.questions.q1.phases.search.resultFile).toBe(copiedResultPath)
    manager.delete(source.runId)
    expect(JSON.parse(await readFile(copiedResultPath, "utf8"))).toEqual({ questionId: "q1" })
  })

  test("copy overrides require rerunning the phase that owns the changed model", async () => {
    const root = await createTempRoot()
    const manager = new CheckpointManager(root)
    const value = question("q1")
    const benchmark = testBenchmark({ questions: [value], sessionsByQuestion: { q1: sessions() } })
    const plans = preparePlans(benchmark, [value])
    const source = await initializeCheckpoint({ manager, plans, questions: [value] })
    markBuildIndexed(Object.values(source.builds)[0])
    source.answeringRuntimeIdentity = {
      ...source.answeringRuntimeIdentity!,
      modelId: "answer-runtime-used-by-source",
    }
    manager.save(source)
    await manager.flush(source.runId)

    expect(() =>
      manager.copyCheckpoint(source.runId, "bad-report-judge", "report", {
        judge: "different-judge",
      })
    ).toThrow("rerun evaluate or an earlier phase")
    expect(() =>
      manager.copyCheckpoint(source.runId, "bad-evaluate-answer", "evaluate", {
        answeringModel: "different-answer-model",
      })
    ).toThrow("rerun answer or an earlier phase")

    const evaluateCopy = manager.copyCheckpoint(source.runId, "evaluate-copy", "evaluate", {
      judge: "different-judge",
    })
    expect(evaluateCopy.judge).toBe("different-judge")
    expect(evaluateCopy.answeringRuntimeIdentity).toEqual(source.answeringRuntimeIdentity)
    expect(evaluateCopy.questions.q1.phases.evaluate.status).toBe("pending")

    const answerCopy = manager.copyCheckpoint(source.runId, "answer-copy", "answer", {
      judge: "different-judge",
      answeringModel: "different-answer-model",
    })
    expect(answerCopy.judge).toBe("different-judge")
    expect(answerCopy.answeringModel).toBe("different-answer-model")
    expect(answerCopy.answeringRuntimeIdentity?.modelAlias).toBe("different-answer-model")
    expect(answerCopy.answeringRuntimeIdentity).not.toEqual(source.answeringRuntimeIdentity)
    expect(answerCopy.questions.q1.phases.answer.status).toBe("pending")
  })

  test("a chained copy records its immediate source while retaining data-source identity", async () => {
    const root = await createTempRoot()
    const manager = new CheckpointManager(root)
    const value = question("q1")
    const benchmark = testBenchmark({ questions: [value], sessionsByQuestion: { q1: sessions() } })
    const plans = preparePlans(benchmark, [value])
    const source = await initializeCheckpoint({ manager, plans, questions: [value] })
    markBuildIndexed(Object.values(source.builds)[0])
    manager.save(source)
    await manager.flush(source.runId)

    const firstCopy = manager.copyCheckpoint(source.runId, "first-copy", "search")
    await manager.flush(firstCopy.runId)
    const secondCopy = manager.copyCheckpoint(firstCopy.runId, "second-copy", "search")
    const build = Object.values(secondCopy.builds)[0]
    expect(build.sourceRunId).toBe("first-copy")
    expect(secondCopy.dataSourceRunId).toBe(source.dataSourceRunId)
  })

  test("refuses to reuse incomplete ingestion or indexing", async () => {
    const root = await createTempRoot()
    const manager = new CheckpointManager(root)
    const value = question("q1")
    const benchmark = testBenchmark({ questions: [value], sessionsByQuestion: { q1: sessions() } })
    const plans = preparePlans(benchmark, [value])
    const source = await initializeCheckpoint({ manager, plans, questions: [value] })
    const build = Object.values(source.builds)[0]

    expect(() => manager.copyCheckpoint(source.runId, "bad-index-copy", "indexing")).toThrow(
      "incomplete ingestion"
    )

    markBuildIngested(build)
    manager.save(source)
    await manager.flush(source.runId)
    expect(() => manager.copyCheckpoint(source.runId, "bad-search-copy", "search")).toThrow(
      "not fully indexed"
    )
  })

  test("continues after a failed session and retries it at the end of the build", async () => {
    const root = await createTempRoot()
    const manager = new CheckpointManager(root)
    const questions = [question("q1"), question("q2")]
    const benchmark = testBenchmark({
      questions,
      sessionsByQuestion: { q1: sessions(), q2: sessions() },
    })
    const plans = preparePlans(benchmark, questions)
    const checkpoint = await initializeCheckpoint({ manager, plans, questions })
    const provider = new FakeProvider()
    provider.failOnceForSession = "s2"

    await runIngestPhase(provider, checkpoint, manager, plans)
    await manager.flush(checkpoint.runId)
    expect(provider.ingestAttempts).toEqual(["s1", "s2", "s3", "s2"])
    expect(provider.successfulIngests).toEqual(["s1", "s3", "s2"])
    expect(provider.ingestAttempts.filter((sessionId) => sessionId === "s1")).toHaveLength(1)
    const build = Object.values(checkpoint.builds)[0]
    expect(build.ingest.completedSessionIds).toEqual(["s1", "s2", "s3"])
    expect(build.ingest.deferredSessions).toEqual([])

    await runIndexingPhase(provider, checkpoint, manager)
    await runIndexingPhase(provider, checkpoint, manager)
    expect(provider.indexingCalls).toBe(1)
    expect(build.indexing.status).toBe("completed")
  })

  test("persists an unresolved session, finishes the first pass, and resumes only its retry", async () => {
    const root = await createTempRoot()
    const manager = new CheckpointManager(root)
    const value = question("q1")
    const benchmark = testBenchmark({ questions: [value], sessionsByQuestion: { q1: sessions() } })
    const plans = preparePlans(benchmark, [value])
    const checkpoint = await initializeCheckpoint({ manager, plans, questions: [value] })
    const provider = new FakeProvider()
    provider.failAlwaysForSession = "s2"

    await expect(runIngestPhase(provider, checkpoint, manager, plans)).rejects.toThrow(
      "sessions across 1 builds still need retry"
    )
    await manager.flush(checkpoint.runId)
    const persisted = manager.load(checkpoint.runId)!
    const failedBuild = Object.values(persisted.builds)[0]
    expect(provider.ingestAttempts).toEqual(["s1", "s2", "s3", "s2"])
    expect(failedBuild.ingest.completedSessionIds).toEqual(["s1", "s2", "s3"])
    expect(failedBuild.ingest.deferredSessions).toEqual([
      expect.objectContaining({
        sequence: 1,
        sessionId: "s2",
        customId: "s2",
        stage: "submission",
        attempts: 2,
        lastError: "injected failure for s2",
      }),
    ])
    expect(failedBuild.containerTag).toBe(plans[0]!.containerTag)

    provider.failAlwaysForSession = undefined
    await runIngestPhase(provider, persisted, manager, plans)
    expect(provider.ingestAttempts).toEqual(["s1", "s2", "s3", "s2", "s2"])
    expect(failedBuild.ingest.status).toBe("completed")
    expect(failedBuild.ingest.deferredSessions).toEqual([])
  })

  test("causal builds add, await readiness, and checkpoint every session in order", async () => {
    const root = await createTempRoot()
    const events: string[] = []
    const manager = new EventCheckpointManager(root, events)
    const value = question("q1")
    const benchmark = testBenchmark({
      questions: [value],
      sessionsByQuestion: { q1: sessions() },
      protocol: testProtocol({
        readinessBarrier: "after-each-document",
        processingMode: "instant",
      }),
    })
    const plans = preparePlans(benchmark, [value])
    const checkpoint = await initializeCheckpoint({ manager, plans, questions: [value] })
    const provider = new CausalProvider()
    provider.events = events

    await runIngestPhase(provider, checkpoint, manager, plans)
    await runIndexingPhase(provider, checkpoint, manager)

    expect(events).toEqual([
      "add:s1",
      "wait:s1",
      "ready:s1",
      "checkpoint:s1",
      "add:s2",
      "wait:s2",
      "ready:s2",
      "checkpoint:s2",
      "add:s3",
      "wait:s3",
      "ready:s3",
      "checkpoint:s3",
    ])
    expect(provider.processingModes).toEqual(["instant", "instant", "instant"])
    expect(provider.readinessTimeouts).toEqual([300_000, 300_000, 300_000])
    expect(provider.indexingCalls).toBe(3)
    const build = Object.values(checkpoint.builds)[0]
    expect(build.ingest.status).toBe("completed")
    expect(build.indexing.status).toBe("completed")
    expect(build.indexing.completedIds).toEqual(["doc-s1", "doc-s2", "doc-s3"])
  })

  test("causal builds submit ordered session batches and wait between batches", async () => {
    const root = await createTempRoot()
    const events: string[] = []
    const manager = new EventCheckpointManager(root, events)
    const value = question("q1")
    const benchmark = testBenchmark({
      questions: [value],
      sessionsByQuestion: { q1: sessions() },
      protocol: testProtocol({
        readinessBarrier: "after-each-document",
        processingMode: "instant",
      }),
    })
    const plans = preparePlans(benchmark, [value], 2)
    const checkpoint = await initializeCheckpoint({ manager, plans, questions: [value] })
    const provider = new CausalProvider()
    provider.events = events

    await runIngestPhase(provider, checkpoint, manager, plans)

    expect(events).toEqual([
      "add:s1,s2",
      "wait:s1,s2",
      "ready:s1,s2",
      "checkpoint:s1",
      "checkpoint:s2",
      "add:s3",
      "wait:s3",
      "ready:s3",
      "checkpoint:s3",
    ])
    expect(provider.processingModes).toEqual(["instant", "instant"])
    expect(provider.indexingCalls).toBe(2)
    const build = Object.values(checkpoint.builds)[0]
    expect(build.ingest.completedSessionIds).toEqual(["s1", "s2", "s3"])
    expect(build.indexing.completedIds).toEqual(["doc-s1", "doc-s2", "doc-s3"])
  })

  test("a partial provider batch keeps successful IDs and retries only the failed session", async () => {
    const root = await createTempRoot()
    const events: string[] = []
    const manager = new EventCheckpointManager(root, events)
    const value = question("q1")
    const benchmark = testBenchmark({
      questions: [value],
      sessionsByQuestion: { q1: sessions() },
      protocol: testProtocol({
        readinessBarrier: "after-each-document",
        processingMode: "instant",
      }),
    })
    const plans = preparePlans(benchmark, [value], 3)
    const checkpoint = await initializeCheckpoint({ manager, plans, questions: [value] })
    const provider = new PartialBatchCausalProvider()
    provider.events = events

    await runIngestPhase(provider, checkpoint, manager, plans)

    expect(events).toEqual([
      "add:s1,s2,s3",
      "wait:s1,s3",
      "ready:s1,s3",
      "checkpoint:s1",
      "checkpoint:s2",
      "checkpoint:s3",
      "add:s2",
      "wait:s2",
      "ready:s2",
    ])
    expect(provider.ingestAttempts).toEqual(["s1", "s2", "s3", "s2"])
    const build = Object.values(checkpoint.builds)[0]
    expect(build.ingest.deferredSessions).toEqual([])
    expect(new Set(build.indexing.completedIds)).toEqual(new Set(["doc-s1", "doc-s2", "doc-s3"]))
  })

  test("ingest batch size changes build and container identity", () => {
    const value = question("q1")
    const benchmark = testBenchmark({
      questions: [value],
      sessionsByQuestion: { q1: sessions() },
    })
    const single = preparePlans(benchmark, [value], 1)[0]!
    const batched = preparePlans(benchmark, [value], 5)[0]!

    expect(single.buildFingerprint).not.toBe(batched.buildFingerprint)
    expect(single.containerTag).not.toBe(batched.containerTag)
    expect(batched.ingestBatchSize).toBe(5)
  })

  test("causal ingest defers failed readiness, continues, and retries it at build end", async () => {
    const root = await createTempRoot()
    const manager = new CheckpointManager(root)
    const value = question("q1")
    const benchmark = testBenchmark({
      questions: [value],
      sessionsByQuestion: { q1: sessions() },
      protocol: testProtocol({
        readinessBarrier: "after-each-document",
        processingMode: "instant",
      }),
    })
    const plans = preparePlans(benchmark, [value])
    const checkpoint = await initializeCheckpoint({ manager, plans, questions: [value] })
    const provider = new CausalProvider()
    provider.omitReadinessOnceForSession = "s2"

    await runIngestPhase(provider, checkpoint, manager, plans)

    expect(provider.ingestAttempts).toEqual(["s1", "s2", "s3", "s2"])
    expect(Object.values(checkpoint.builds)[0].ingest.completedSessionIds).toEqual([
      "s1",
      "s2",
      "s3",
    ])
    expect(Object.values(checkpoint.builds)[0].ingest.deferredSessions).toEqual([])
    expect(Object.values(checkpoint.builds)[0].indexing.status).toBe("completed")
  })

  test("independent causal conversation builds run concurrently", async () => {
    const root = await createTempRoot()
    const manager = new CheckpointManager(root)
    const questions = [question("q1"), question("q2")]
    const benchmark = testBenchmark({
      questions,
      sessionsByQuestion: { q1: sessions(), q2: sessions() },
      protocol: testProtocol({
        readinessBarrier: "after-each-document",
        processingMode: "instant",
      }),
    })
    benchmark.getIngestionGroupId = (questionId) => questionId
    const plans = preparePlans(benchmark, questions)
    const checkpoint = await initializeCheckpoint({ manager, plans, questions })
    checkpoint.concurrency = { default: 2 }
    const provider = new ConcurrentCausalProvider()

    await runIngestPhase(provider, checkpoint, manager, plans)

    expect(provider.firstSessionContainers.size).toBe(2)
    expect(
      Object.values(checkpoint.builds).every((build) => build.indexing.status === "completed")
    ).toBe(true)
  })

  test("flush surfaces a completed checkpoint write failure and a later full save can recover", async () => {
    const root = await createTempRoot()
    const manager = new CheckpointManager(root)
    const value = question("q1")
    const benchmark = testBenchmark({ questions: [value], sessionsByQuestion: { q1: sessions() } })
    const plans = preparePlans(benchmark, [value])
    const checkpoint = await initializeCheckpoint({ manager, plans, questions: [value] })
    const temporaryCheckpointPath = join(root, checkpoint.runId, "checkpoint.json.tmp")

    // A directory at the atomic-write temporary path deterministically makes
    // writeFile fail after save() has returned.
    await mkdir(temporaryCheckpointPath)
    manager.updateStatus(checkpoint, "running")
    await Promise.resolve()
    await expect(manager.flush(checkpoint.runId)).rejects.toThrow()

    await rm(temporaryCheckpointPath, { recursive: true, force: true })
    manager.updateStatus(checkpoint, "completed")
    await manager.flush(checkpoint.runId)
    expect(manager.load(checkpoint.runId)?.status).toBe("completed")
  })

  test("uses portable hashed result filenames for colon-bearing BEAM question IDs", async () => {
    const manager = new CheckpointManager(await createTempRoot())
    const resultPath = manager.getQuestionResultsPath("run-id", "beam:1M:10:event_ordering:abcdef")
    expect(basename(resultPath)).toMatch(/^[a-f0-9]{64}\.json$/)
    expect(basename(resultPath)).not.toContain(":")
  })

  test("remote-success/local-crash reconciliation does not create a duplicate document", async () => {
    const root = await createTempRoot()
    const manager = new CheckpointManager(root)
    const value = question("q1")
    const benchmark = testBenchmark({ questions: [value], sessionsByQuestion: { q1: sessions() } })
    const plans = preparePlans(benchmark, [value])
    const checkpoint = await initializeCheckpoint({ manager, plans, questions: [value] })
    const provider = new CrashWindowProvider()

    await runIngestPhase(provider, checkpoint, manager, plans)
    expect(provider.ingestAttempts).toEqual(["s1", "s2", "s3", "s1"])
    expect(provider.remoteCreates).toBe(3)
    expect(provider.remoteDocuments.size).toBe(3)
    expect(new Set(Object.values(checkpoint.builds)[0].ingest.documentIds)).toEqual(
      new Set(["doc-s1", "doc-s2", "doc-s3"])
    )
  })

  test("one shared build persists one progress update per session, not per question", async () => {
    const root = await createTempRoot()
    const manager = new CountingCheckpointManager(root)
    const questions = Array.from({ length: 20 }, (_, index) => question(`q${index + 1}`))
    const benchmark = testBenchmark({
      questions,
      sessionsByQuestion: Object.fromEntries(
        questions.map((value) => [value.questionId, sessions()])
      ),
    })
    const plans = preparePlans(benchmark, questions)
    const checkpoint = await initializeCheckpoint({ manager, plans, questions })
    manager.saveCalls = 0

    await runIngestPhase(new FakeProvider(), checkpoint, manager, plans)
    // The large checkpoint is saved only at attempt start and completion.
    // Per-session remote success is durably recorded in the small append-only journal.
    expect(manager.saveCalls).toBe(2)
    expect(Object.values(checkpoint.builds)[0].ingest.completedSessionIds).toHaveLength(3)
    await expect(
      readFile(
        manager.getIngestProgressJournalPath(
          checkpoint.runId,
          Object.values(checkpoint.builds)[0].buildId
        ),
        "utf8"
      )
    ).rejects.toThrow()
  })

  test("replays fsynced per-session ingest progress without a full checkpoint rewrite", async () => {
    const root = await createTempRoot()
    const manager = new CheckpointManager(root)
    const value = question("q1")
    const benchmark = testBenchmark({ questions: [value], sessionsByQuestion: { q1: sessions() } })
    const plans = preparePlans(benchmark, [value])
    const checkpoint = await initializeCheckpoint({ manager, plans, questions: [value] })
    const build = Object.values(checkpoint.builds)[0]

    manager.recordIngestProgress(checkpoint, build.buildId, {
      sequence: 0,
      sessionId: "s1",
      documentIds: ["doc-s1"],
      taskIds: ["task-s1"],
      readyForNextSession: false,
    })

    const rawSnapshot = JSON.parse(
      await readFile(manager.getCheckpointPath(checkpoint.runId), "utf8")
    ) as RunCheckpoint
    expect(Object.values(rawSnapshot.builds)[0].ingest.completedSessionIds).toEqual([])

    const resumed = new CheckpointManager(root).load(checkpoint.runId)!
    expect(Object.values(resumed.builds)[0].ingest.completedSessionIds).toEqual(["s1"])
    expect(Object.values(resumed.builds)[0].ingest.documentIds).toEqual(["doc-s1"])
    expect(Object.values(resumed.builds)[0].ingest.taskIds).toEqual(["task-s1"])
  })

  test("does not mark indexing complete when the provider omits final completion", async () => {
    const root = await createTempRoot()
    const manager = new CheckpointManager(root)
    const value = question("q1")
    const benchmark = testBenchmark({ questions: [value], sessionsByQuestion: { q1: sessions() } })
    const plans = preparePlans(benchmark, [value])
    const checkpoint = await initializeCheckpoint({ manager, plans, questions: [value] })
    markBuildIngested(Object.values(checkpoint.builds)[0])
    const provider = new FakeProvider()
    provider.omitIndexingProgress = true

    await expect(runIndexingPhase(provider, checkpoint, manager)).rejects.toThrow(
      "returned before 3 IDs completed"
    )
    expect(Object.values(checkpoint.builds)[0].indexing.status).toBe("failed")
  })

  test("search fails closed for missing, failed, or incomplete builds", async () => {
    const root = await createTempRoot()
    const manager = new CheckpointManager(root)
    const value = question("q1")
    const benchmark = testBenchmark({ questions: [value], sessionsByQuestion: { q1: sessions() } })
    const plans = preparePlans(benchmark, [value])
    const checkpoint = await initializeCheckpoint({ manager, plans, questions: [value] })
    const provider = new FakeProvider()
    const build = Object.values(checkpoint.builds)[0]

    await expect(
      runSearchPhase(provider, benchmark, checkpoint, manager, [value.questionId])
    ).rejects.toThrow("ingestion is pending")

    markBuildIngested(build)
    build.indexing.status = "failed"
    await expect(
      runSearchPhase(provider, benchmark, checkpoint, manager, [value.questionId])
    ).rejects.toThrow("indexing is failed")

    delete checkpoint.builds[build.buildId]
    await expect(
      runSearchPhase(provider, benchmark, checkpoint, manager, [value.questionId])
    ).rejects.toThrow("references missing build")
    expect(provider.searchCalls).toHaveLength(0)
  })

  test("passes benchmark Top-K unchanged and records requested/returned counts", async () => {
    const root = await createTempRoot()
    const manager = new CheckpointManager(root)
    const value = question("q1")
    const protocol = testProtocol({ requestedTopK: 5, answerCutoff: 5 })
    const benchmark = testBenchmark({
      questions: [value],
      sessionsByQuestion: { q1: sessions() },
      protocol,
    })
    const plans = preparePlans(benchmark, [value])
    const checkpoint = await initializeCheckpoint({ manager, plans, questions: [value] })
    checkpoint.datasetIdentity = {
      datasetFingerprint: "dataset-fixture",
    } as RunCheckpoint["datasetIdentity"]
    checkpoint.benchmarkInputFingerprint = "benchmark-input-fixture"
    const build = Object.values(checkpoint.builds)[0]
    build.ingest.status = "completed"
    build.indexing.status = "completed"
    const provider = new FakeProvider()
    provider.searchResults = [1, 2, 3].map((rank) => ({
      id: `result-${rank}`,
      rank,
      text: `Result ${rank}`,
      provider: "fake",
      resultType: "memory",
    }))
    provider.searchRawReturnedCount = 4

    await runSearchPhase(provider, benchmark, checkpoint, manager, [value.questionId])
    expect(provider.searchCalls).toHaveLength(1)
    expect(provider.searchCalls[0]).toMatchObject({
      containerTag: build.containerTag,
      limit: 5,
      threshold: 0.2,
      searchMode: "hybrid",
    })
    expect(checkpoint.questions.q1.phases.search.requestedCount).toBe(5)
    expect(checkpoint.questions.q1.phases.search.rawReturnedCount).toBe(4)
    expect(checkpoint.questions.q1.phases.search.returnedCount).toBe(3)
    expect(checkpoint.questions.q1.phases.search.normalizedCount).toBe(3)
    expect(checkpoint.questions.q1.phases.search.droppedCount).toBe(1)
    expect(checkpoint.questions.q1.phases.search.answerCutoff).toBe(5)
    const resultFile = checkpoint.questions.q1.phases.search.resultFile!
    const artifact = JSON.parse(await readFile(resultFile, "utf8"))
    expect(artifact).toMatchObject({
      benchmark: "test-benchmark",
      benchmarkScope: { displayName: "Test", includedTiers: ["test"], coverage: "full" },
      datasetIdentity: { datasetFingerprint: "dataset-fixture" },
      benchmarkInputFingerprint: "benchmark-input-fixture",
      selectedQuestionIdsDigest: "selected",
      protocolIdentity,
    })

    checkpoint.questions.q1.phases.search = { status: "pending" }
    provider.searchRawReturnedCount = undefined
    provider.searchResults = Array.from({ length: 6 }, (_, index) => ({
      id: `too-many-${index + 1}`,
      rank: index + 1,
      text: `Too many ${index + 1}`,
      provider: "fake",
      resultType: "memory",
    }))
    await expect(
      runSearchPhase(provider, benchmark, checkpoint, manager, [value.questionId])
    ).rejects.toThrow("inconsistent retrieval diagnostics")
  })
})
