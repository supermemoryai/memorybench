import type { Benchmark } from "../types/benchmark"
import type { BuildCheckpoint, HaystackIdentity, RunCheckpoint } from "../types/checkpoint"
import type { IngestionExecutionPolicy } from "../types/protocol"
import type { CanonicalIngestionDocument, UnifiedQuestion } from "../types/unified"
import { stableSha256 } from "../utils/stable"

const HAYSTACK_SCHEMA_VERSION = 2 as const
const BUILD_SCHEMA_VERSION = 4
const CONTAINER_TAG_PATTERN = /^[a-zA-Z0-9_:-]+$/

export interface ValidatedBuildPlan {
  buildId: string
  ingestionGroupId: string
  memberQuestionIds: string[]
  containerTag: string
  haystack: HaystackIdentity
  buildFingerprint: string
  providerIngestionConfigFingerprint: string
  ingestionExecutionPolicy: IngestionExecutionPolicy
  ingestBatchSize: number
  documents: CanonicalIngestionDocument[]
  questions: Array<{
    questionId: string
    question: string
    groundTruth: string
    questionType: string
    questionDate?: string
  }>
}

interface QuestionPlan {
  question: UnifiedQuestion
  ingestionGroupId: string
  documents: CanonicalIngestionDocument[]
  haystack: HaystackIdentity
}

function calculateHaystackFingerprint(
  orderedSessionIds: readonly string[],
  sessionFingerprints: readonly string[]
): string {
  return stableSha256({
    schemaVersion: HAYSTACK_SCHEMA_VERSION,
    orderedSessions: orderedSessionIds.map((sessionId, index) => ({
      index,
      sessionId,
      sessionFingerprint: sessionFingerprints[index],
    })),
  })
}

function createHaystackIdentity(documents: CanonicalIngestionDocument[]): HaystackIdentity {
  const sessionFingerprints = documents.map((document) =>
    stableSha256({
      schemaVersion: HAYSTACK_SCHEMA_VERSION,
      customId: document.customId,
      content: document.content,
      metadata: document.metadata,
      // Hash the complete canonical message objects. Chat-oriented adapters
      // consume role/content, while extraction-based adapters also render
      // speaker/timestamp. Omitting either would let provider-visible ingestion
      // requests drift inside one supposedly shared build.
      messages: document.messages,
    })
  )
  const orderedSessionIds = documents.map((document) => document.metadata.sessionId)

  return {
    schemaVersion: HAYSTACK_SCHEMA_VERSION,
    algorithm: "sha256",
    fingerprint: calculateHaystackFingerprint(orderedSessionIds, sessionFingerprints),
    orderedSessionIds,
    sessionFingerprints,
  }
}

function assertOrderedSessionIds(
  question: UnifiedQuestion,
  sessionIds: readonly string[],
  source: string
): void {
  if (new Set(sessionIds).size !== sessionIds.length) {
    throw new Error(`Question ${question.questionId} has duplicate session IDs in ${source}`)
  }
  if (new Set(question.haystackSessionIds).size !== question.haystackSessionIds.length) {
    throw new Error(`Question ${question.questionId} has duplicate haystackSessionIds`)
  }
  if (
    sessionIds.length !== question.haystackSessionIds.length ||
    sessionIds.some((sessionId, index) => sessionId !== question.haystackSessionIds[index])
  ) {
    throw new Error(
      `Question ${question.questionId} haystackSessionIds do not exactly match ${source}`
    )
  }
}

function assertQuestionPlan(
  question: UnifiedQuestion,
  sourceSessions: readonly string[],
  documents: CanonicalIngestionDocument[]
): void {
  const plannedIds = documents.map((document) => document.metadata.sessionId)
  assertOrderedSessionIds(question, plannedIds, "the ordered ingestion plan")
  if (
    plannedIds.length !== sourceSessions.length ||
    plannedIds.some((sessionId, index) => sessionId !== sourceSessions[index])
  ) {
    throw new Error(
      `Question ${question.questionId} ingestion plan does not preserve every ordered session returned by getHaystackSessions()`
    )
  }

  for (const [index, document] of documents.entries()) {
    if (!document.customId || !document.content || !document.metadata.sessionId) {
      throw new Error(
        `Question ${question.questionId} has malformed ingestion document at index ${index}`
      )
    }
    if (document.customId !== document.metadata.sessionId) {
      throw new Error(
        `Question ${question.questionId} document ${index} must use customId=sessionId`
      )
    }
  }
}

function firstHaystackDifference(left: QuestionPlan, right: QuestionPlan): string {
  const max = Math.max(
    left.haystack.orderedSessionIds.length,
    right.haystack.orderedSessionIds.length
  )
  for (let index = 0; index < max; index++) {
    const leftId = left.haystack.orderedSessionIds[index]
    const rightId = right.haystack.orderedSessionIds[index]
    const leftFingerprint = left.haystack.sessionFingerprints[index]
    const rightFingerprint = right.haystack.sessionFingerprints[index]
    if (leftId !== rightId || leftFingerprint !== rightFingerprint) {
      return `index ${index}: ${leftId ?? "<missing>"}/${leftFingerprint ?? "<missing>"} != ${rightId ?? "<missing>"}/${rightFingerprint ?? "<missing>"}`
    }
  }
  return "final fingerprint differs"
}

function createContainerTag(buildId: string): string {
  const tag = `mb:${stableSha256({ schemaVersion: 1, buildId }).slice(0, 48)}`
  if (tag.length > 100 || !CONTAINER_TAG_PATTERN.test(tag)) {
    throw new Error(`Generated invalid containerTag: ${tag}`)
  }
  return tag
}

export function prepareValidatedBuildPlans(input: {
  benchmark: Benchmark
  questions: UnifiedQuestion[]
  provider: string
  providerAdapterVersion: string
  providerPromptFingerprint: string
  providerIngestionConfigFingerprint: string
  dataSourceRunId: string
  ingestBatchSize?: number
}): ValidatedBuildPlan[] {
  const {
    benchmark,
    questions,
    provider,
    providerAdapterVersion,
    providerIngestionConfigFingerprint,
    dataSourceRunId,
  } = input
  const ingestBatchSize = input.ingestBatchSize ?? 1
  if (!Number.isInteger(ingestBatchSize) || ingestBatchSize < 1 || ingestBatchSize > 600) {
    throw new Error(
      `Ingest batch size must be an integer between 1 and 600; received ${ingestBatchSize}`
    )
  }
  const independentlyPlanned = questions.map((question): QuestionPlan => {
    benchmark.protocol.validateQuestion(question)
    const sessions = benchmark.getHaystackSessions(question.questionId)
    const sourceSessionIds = sessions.map((session) => session.sessionId)
    assertOrderedSessionIds(
      question,
      sourceSessionIds,
      "the ordered sessions returned by getHaystackSessions()"
    )
    const documents = benchmark.protocol.createIngestionPlan({ question, sessions })
    assertQuestionPlan(question, sourceSessionIds, documents)
    return {
      question,
      ingestionGroupId: benchmark.getIngestionGroupId?.(question.questionId) || question.questionId,
      documents,
      haystack: createHaystackIdentity(documents),
    }
  })

  const grouped = new Map<string, QuestionPlan[]>()
  for (const plan of independentlyPlanned) {
    const members = grouped.get(plan.ingestionGroupId) || []
    members.push(plan)
    grouped.set(plan.ingestionGroupId, members)
  }

  return [...grouped.entries()].map(([ingestionGroupId, members]) => {
    const reference = members[0]
    for (const member of members.slice(1)) {
      if (member.haystack.fingerprint !== reference.haystack.fingerprint) {
        throw new Error(
          `Ingestion group ${ingestionGroupId} has different haystacks for ${reference.question.questionId} (${reference.haystack.fingerprint}) and ${member.question.questionId} (${member.haystack.fingerprint}); ${firstHaystackDifference(reference, member)}`
        )
      }
    }

    const buildFingerprint = stableSha256({
      schemaVersion: BUILD_SCHEMA_VERSION,
      haystackFingerprint: reference.haystack.fingerprint,
      datasetFingerprint: benchmark.getDatasetIdentity?.()?.datasetFingerprint ?? null,
      provider,
      providerAdapterVersion,
      providerIngestionConfigFingerprint,
      protocolIngestionPolicyHash: benchmark.protocol.identity.ingestionPolicyHash,
      ingestionExecutionPolicy: benchmark.protocol.ingestionExecutionPolicy,
      ...(ingestBatchSize === 1 ? {} : { ingestBatchSize }),
    })
    const buildId = `build:${stableSha256({ ingestionGroupId, buildFingerprint, dataSourceRunId }).slice(0, 48)}`

    return {
      buildId,
      ingestionGroupId,
      memberQuestionIds: members.map((member) => member.question.questionId).sort(),
      containerTag: createContainerTag(buildId),
      haystack: reference.haystack,
      buildFingerprint,
      providerIngestionConfigFingerprint,
      ingestionExecutionPolicy: benchmark.protocol.ingestionExecutionPolicy,
      ingestBatchSize,
      documents: reference.documents,
      questions: members
        .map(({ question }) => ({
          questionId: question.questionId,
          question: question.question,
          groundTruth: question.groundTruth,
          questionType: question.questionType,
          ...(typeof question.metadata?.questionDate === "string"
            ? { questionDate: question.metadata.questionDate }
            : {}),
        }))
        .sort((left, right) => left.questionId.localeCompare(right.questionId)),
    }
  })
}

export function createBuildCheckpoint(plan: ValidatedBuildPlan): BuildCheckpoint {
  return {
    buildId: plan.buildId,
    ingestionGroupId: plan.ingestionGroupId,
    memberQuestionIds: [...plan.memberQuestionIds],
    containerTag: plan.containerTag,
    haystack: plan.haystack,
    buildFingerprint: plan.buildFingerprint,
    providerIngestionConfigFingerprint: plan.providerIngestionConfigFingerprint,
    ingestionExecutionPolicy: plan.ingestionExecutionPolicy,
    ingestBatchSize: plan.ingestBatchSize,
    sessions: plan.documents.map((document) => ({
      sessionId: document.metadata.sessionId,
      documentDate: document.metadata.documentDate,
      messageCount: document.messages?.length ?? 0,
    })),
    missingDocumentDateCount: plan.documents.filter((document) => !document.metadata.documentDate)
      .length,
    reused: false,
    ingest: {
      status: "pending",
      completedSessionIds: [],
      documentIds: [],
      taskIds: [],
      deferredSessions: [],
      attempts: [],
    },
    indexing: {
      status: "pending",
      completedIds: [],
      failedIds: [],
      attempts: [],
    },
  }
}

export function assertCompletedSessionsAreOrderedPrefix(build: BuildCheckpoint): void {
  const completed = build.ingest.completedSessionIds
  if (new Set(completed).size !== completed.length) {
    throw new Error(`Build ${build.buildId} has duplicate completedSessionIds`)
  }
  if (completed.some((sessionId, index) => sessionId !== build.haystack.orderedSessionIds[index])) {
    throw new Error(
      `Build ${build.buildId} completedSessionIds must be an ordered prefix of its haystack`
    )
  }
}

function assertUniqueIds(buildId: string, name: string, ids: readonly string[]): void {
  if (ids.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new Error(`Build ${buildId} has an empty or invalid ${name} entry`)
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error(`Build ${buildId} has duplicate ${name}`)
  }
}

export function assertBuildCheckpointConsistency(build: BuildCheckpoint): void {
  if (!build.providerIngestionConfigFingerprint?.trim()) {
    throw new Error(`Build ${build.buildId} has no provider ingestion configuration fingerprint`)
  }
  if (
    !["after-build", "after-each-document"].includes(
      build.ingestionExecutionPolicy?.readinessBarrier
    ) ||
    !["provider-default", "instant"].includes(build.ingestionExecutionPolicy?.processingMode)
  ) {
    throw new Error(`Build ${build.buildId} has an invalid ingestion execution policy`)
  }
  const ingestBatchSize = build.ingestBatchSize ?? 1
  if (!Number.isInteger(ingestBatchSize) || ingestBatchSize < 1 || ingestBatchSize > 600) {
    throw new Error(`Build ${build.buildId} has an invalid ingest batch size`)
  }
  if (build.haystack.schemaVersion !== HAYSTACK_SCHEMA_VERSION) {
    throw new Error(
      `Build ${build.buildId} uses unsupported haystack schema ${String(build.haystack.schemaVersion)}`
    )
  }
  if (build.haystack.algorithm !== "sha256") {
    throw new Error(
      `Build ${build.buildId} uses unsupported haystack algorithm ${String(build.haystack.algorithm)}`
    )
  }
  assertCompletedSessionsAreOrderedPrefix(build)
  const deferredSessions = build.ingest.deferredSessions ?? []
  const deferredSequences = new Set<number>()
  for (const deferred of deferredSessions) {
    if (
      !Number.isInteger(deferred.sequence) ||
      deferred.sequence < 0 ||
      deferred.sequence >= build.haystack.orderedSessionIds.length ||
      deferredSequences.has(deferred.sequence) ||
      build.haystack.orderedSessionIds[deferred.sequence] !== deferred.sessionId ||
      !deferred.customId?.trim() ||
      (deferred.stage !== "submission" && deferred.stage !== "readiness") ||
      !Number.isInteger(deferred.attempts) ||
      deferred.attempts < 1 ||
      !deferred.firstFailedAt?.trim() ||
      !deferred.lastFailedAt?.trim() ||
      !deferred.lastError?.trim()
    ) {
      throw new Error(`Build ${build.buildId} has invalid deferred ingest state`)
    }
    deferredSequences.add(deferred.sequence)
    assertUniqueIds(build.buildId, "deferred document IDs", deferred.documentIds)
    assertUniqueIds(build.buildId, "deferred task IDs", deferred.taskIds)
  }
  assertUniqueIds(build.buildId, "haystack session IDs", build.haystack.orderedSessionIds)
  if (build.haystack.sessionFingerprints.length !== build.haystack.orderedSessionIds.length) {
    throw new Error(`Build ${build.buildId} has mismatched haystack fingerprint arrays`)
  }
  if (
    calculateHaystackFingerprint(
      build.haystack.orderedSessionIds,
      build.haystack.sessionFingerprints
    ) !== build.haystack.fingerprint
  ) {
    throw new Error(`Build ${build.buildId} has a tampered haystack fingerprint`)
  }
  if (
    build.ingest.status === "completed" &&
    build.ingest.completedSessionIds.length !== build.haystack.orderedSessionIds.length
  ) {
    throw new Error(`Build ${build.buildId} is marked ingested before every session completed`)
  }
  if (build.ingest.status === "completed" && deferredSessions.length > 0) {
    throw new Error(`Build ${build.buildId} is marked ingested with deferred sessions remaining`)
  }
  if (
    build.ingestionExecutionPolicy.readinessBarrier === "after-build" &&
    build.ingest.status !== "completed" &&
    build.indexing.status !== "pending"
  ) {
    throw new Error(`Build ${build.buildId} started indexing before ingestion completed`)
  }
  if (build.indexing.status === "completed" && build.ingest.status !== "completed") {
    throw new Error(`Build ${build.buildId} completed indexing before ingestion completed`)
  }
  if (
    build.ingestionExecutionPolicy.readinessBarrier === "after-each-document" &&
    build.ingest.status === "completed" &&
    build.indexing.status !== "completed"
  ) {
    throw new Error(
      `Build ${build.buildId} completed causal ingestion without completing its per-document indexing barriers`
    )
  }

  assertUniqueIds(build.buildId, "document IDs", build.ingest.documentIds)
  assertUniqueIds(build.buildId, "task IDs", build.ingest.taskIds)
  const duplicatePhysicalId = build.ingest.documentIds.find((id) =>
    build.ingest.taskIds.includes(id)
  )
  if (duplicatePhysicalId) {
    throw new Error(
      `Build ${build.buildId} uses ${duplicatePhysicalId} as both a document ID and task ID`
    )
  }
  assertUniqueIds(build.buildId, "completed indexing IDs", build.indexing.completedIds)
  assertUniqueIds(build.buildId, "failed indexing IDs", build.indexing.failedIds)
  const expectedIds = new Set([...build.ingest.documentIds, ...build.ingest.taskIds])
  for (const deferred of deferredSessions) {
    for (const id of [...deferred.documentIds, ...deferred.taskIds]) {
      if (!expectedIds.has(id)) {
        throw new Error(`Build ${build.buildId} deferred unknown physical ID ${id}`)
      }
    }
  }
  const completedIds = new Set(build.indexing.completedIds)
  const failedIds = new Set(build.indexing.failedIds)
  for (const id of [...completedIds, ...failedIds]) {
    if (!expectedIds.has(id)) {
      throw new Error(`Build ${build.buildId} has indexing progress for unknown ID ${id}`)
    }
  }
  for (const id of completedIds) {
    if (failedIds.has(id)) {
      throw new Error(`Build ${build.buildId} indexed ID ${id} is both completed and failed`)
    }
  }
  if (build.indexing.status === "completed") {
    if (failedIds.size > 0) {
      throw new Error(`Build ${build.buildId} is marked indexed with failed IDs`)
    }
    if (
      completedIds.size !== expectedIds.size ||
      [...expectedIds].some((id) => !completedIds.has(id))
    ) {
      throw new Error(`Build ${build.buildId} is marked indexed before every ID completed`)
    }
  }
}

function assertCompletedQuestionPayload(question: RunCheckpoint["questions"][string]): void {
  const { search, answer, evaluate } = question.phases
  if (search.status === "completed") {
    if (!search.retrievalPlan || !Array.isArray(search.results)) {
      throw new Error(`Question ${question.questionId} has incomplete completed-search state`)
    }
    const requestedTopK = search.retrievalPlan.requestedTopK
    const counts = [
      search.requestedCount,
      search.rawReturnedCount,
      search.returnedCount,
      search.normalizedCount,
      search.droppedCount,
      search.answerCutoff,
    ]
    if (counts.some((value) => !Number.isInteger(value) || value! < 0)) {
      throw new Error(`Question ${question.questionId} has invalid completed-search counts`)
    }
    if (
      search.requestedCount !== requestedTopK ||
      search.answerCutoff !== search.retrievalPlan.answerCutoff ||
      search.returnedCount !== search.results.length ||
      search.normalizedCount !== search.results.length ||
      search.rawReturnedCount! - search.normalizedCount! !== search.droppedCount ||
      search.rawReturnedCount! > requestedTopK ||
      !Array.isArray(search.providerRequests) ||
      search.providerRequests.reduce((sum, request) => sum + request.limit, 0) !== requestedTopK ||
      !search.resultFile?.trim()
    ) {
      throw new Error(`Question ${question.questionId} has inconsistent completed-search state`)
    }
    const ranks = new Set<number>()
    for (const result of search.results) {
      if (
        !result.text?.trim() ||
        !Number.isInteger(result.rank) ||
        result.rank < 1 ||
        ranks.has(result.rank)
      ) {
        throw new Error(`Question ${question.questionId} has malformed persisted search evidence`)
      }
      ranks.add(result.rank)
    }
  }

  if (search.answerEvidenceCount !== undefined) {
    if (
      !Number.isInteger(search.answerEvidenceCount) ||
      search.answerEvidenceCount < 0 ||
      search.answerEvidenceCount > (search.answerCutoff ?? -1)
    ) {
      throw new Error(`Question ${question.questionId} has invalid answer evidence count`)
    }
  }

  if (answer.status === "completed") {
    const hasOrdinaryHypothesis =
      typeof answer.hypothesis === "string" && answer.hypothesis.trim().length > 0
    const hasAcceptedTerminalEmpty =
      answer.hypothesis === "" && answer.terminalEmptyAccepted === true
    if (!hasOrdinaryHypothesis && !hasAcceptedTerminalEmpty) {
      throw new Error(`Question ${question.questionId} has no completed answer hypothesis`)
    }
    if (hasOrdinaryHypothesis && answer.terminalEmptyAccepted === true) {
      throw new Error(
        `Question ${question.questionId} marks a non-empty hypothesis as terminal-empty`
      )
    }
    for (const [name, value] of Object.entries({
      promptTokens: answer.promptTokens,
      basePromptTokens: answer.basePromptTokens,
      contextTokens: answer.contextTokens,
      evidenceCount: answer.evidenceCount,
    })) {
      if (!Number.isInteger(value) || value! < 0) {
        throw new Error(`Question ${question.questionId} has invalid completed-answer ${name}`)
      }
    }
    if (
      answer.evidenceCount !== search.answerEvidenceCount ||
      answer.evidenceCount! > (search.answerCutoff ?? -1)
    ) {
      throw new Error(`Question ${question.questionId} has inconsistent completed-answer evidence`)
    }
  }

  if (evaluate.status === "completed") {
    const evaluation = evaluate.evaluation
    if (
      !evaluation ||
      evaluation.questionId !== question.questionId ||
      evaluation.questionType !== question.questionType ||
      !Number.isFinite(evaluation.primaryScore) ||
      evaluation.primaryScore < 0 ||
      evaluation.primaryScore > 1 ||
      typeof evaluation.passed !== "boolean" ||
      evaluate.score !== evaluation.primaryScore
    ) {
      throw new Error(`Question ${question.questionId} has incomplete completed-evaluation state`)
    }
    if (evaluate.label !== (evaluation.passed ? "correct" : "incorrect")) {
      throw new Error(`Question ${question.questionId} has inconsistent completed-evaluation label`)
    }
  }
}

export function assertCheckpointReferences(checkpoint: RunCheckpoint): void {
  const questionIds = Object.keys(checkpoint.questions)
  const knownQuestionIds = new Set(questionIds)
  if (checkpoint.targetQuestionIds) {
    if (
      new Set(checkpoint.targetQuestionIds).size !== checkpoint.targetQuestionIds.length ||
      stableSha256([...checkpoint.targetQuestionIds].sort()) !==
        stableSha256([...questionIds].sort())
    ) {
      throw new Error("Checkpoint targetQuestionIds do not match its question records")
    }
  }
  for (const [buildKey, build] of Object.entries(checkpoint.builds)) {
    if (buildKey !== build.buildId) {
      throw new Error(`Checkpoint build key ${buildKey} does not match ${build.buildId}`)
    }
    assertUniqueIds(build.buildId, "member question IDs", build.memberQuestionIds)
    for (const memberQuestionId of build.memberQuestionIds) {
      const member = checkpoint.questions[memberQuestionId]
      if (!knownQuestionIds.has(memberQuestionId) || member?.buildId !== build.buildId) {
        throw new Error(
          `Build ${build.buildId} has invalid member question reference ${memberQuestionId}`
        )
      }
    }
    assertBuildCheckpointConsistency(build)
  }

  for (const [questionKey, question] of Object.entries(checkpoint.questions)) {
    if (questionKey !== question.questionId) {
      throw new Error(
        `Checkpoint question key ${questionKey} does not match ${question.questionId}`
      )
    }
    const build = checkpoint.builds[question.buildId]
    if (!build || !build.memberQuestionIds.includes(question.questionId)) {
      throw new Error(
        `Checkpoint question ${question.questionId} has an invalid build reference ${question.buildId}`
      )
    }
    assertCompletedQuestionPayload(question)
    if (question.phases.search.status !== "pending" && build.indexing.status !== "completed") {
      throw new Error(`Question ${question.questionId} searched before its build was fully indexed`)
    }
    if (
      question.phases.answer.status !== "pending" &&
      question.phases.search.status !== "completed"
    ) {
      throw new Error(`Question ${question.questionId} answered before search completed`)
    }
    if (
      question.phases.evaluate.status !== "pending" &&
      question.phases.answer.status !== "completed"
    ) {
      throw new Error(`Question ${question.questionId} evaluated before answering completed`)
    }
  }
}

export function assertResumeBuilds(checkpoint: RunCheckpoint, plans: ValidatedBuildPlan[]): void {
  assertCheckpointReferences(checkpoint)
  const plannedById = new Map(plans.map((plan) => [plan.buildId, plan]))
  const checkpointIds = Object.keys(checkpoint.builds).sort()
  const planIds = [...plannedById.keys()].sort()
  if (stableSha256(checkpointIds) !== stableSha256(planIds)) {
    throw new Error(
      "Checkpoint build identities do not match the selected dataset and configuration"
    )
  }

  const expectedQuestionToBuild = new Map<string, string>()
  for (const plan of plans) {
    for (const questionId of plan.memberQuestionIds) {
      if (expectedQuestionToBuild.has(questionId)) {
        throw new Error(`Question ${questionId} belongs to more than one validated build`)
      }
      expectedQuestionToBuild.set(questionId, plan.buildId)
    }
  }
  const checkpointQuestionIds = Object.keys(checkpoint.questions).sort()
  const expectedQuestionIds = [...expectedQuestionToBuild.keys()].sort()
  if (stableSha256(checkpointQuestionIds) !== stableSha256(expectedQuestionIds)) {
    throw new Error("Checkpoint questions do not match the selected dataset and configuration")
  }
  if (checkpoint.targetQuestionIds) {
    if (new Set(checkpoint.targetQuestionIds).size !== checkpoint.targetQuestionIds.length) {
      throw new Error("Checkpoint targetQuestionIds contains duplicates")
    }
    if (
      stableSha256([...checkpoint.targetQuestionIds].sort()) !== stableSha256(expectedQuestionIds)
    ) {
      throw new Error("Checkpoint targetQuestionIds do not match its question records")
    }
  }

  for (const [buildKey, build] of Object.entries(checkpoint.builds)) {
    const plan = plannedById.get(build.buildId)
    if (
      buildKey !== build.buildId ||
      !plan ||
      plan.ingestionGroupId !== build.ingestionGroupId ||
      plan.buildFingerprint !== build.buildFingerprint ||
      plan.providerIngestionConfigFingerprint !== build.providerIngestionConfigFingerprint ||
      stableSha256(plan.ingestionExecutionPolicy) !==
        stableSha256(build.ingestionExecutionPolicy) ||
      plan.ingestBatchSize !== (build.ingestBatchSize ?? 1) ||
      plan.containerTag !== build.containerTag ||
      plan.haystack.fingerprint !== build.haystack.fingerprint ||
      stableSha256(plan.haystack.orderedSessionIds) !==
        stableSha256(build.haystack.orderedSessionIds) ||
      stableSha256(plan.haystack.sessionFingerprints) !==
        stableSha256(build.haystack.sessionFingerprints) ||
      stableSha256(plan.memberQuestionIds) !== stableSha256(build.memberQuestionIds)
    ) {
      throw new Error(
        `Checkpoint build ${build.buildId} no longer matches the validated build plan`
      )
    }
    const expectedSessions = plan.documents.map((document) => ({
      sessionId: document.metadata.sessionId,
      documentDate: document.metadata.documentDate,
      messageCount: document.messages?.length ?? 0,
    }))
    if (
      stableSha256(expectedSessions) !== stableSha256(build.sessions) ||
      build.missingDocumentDateCount !==
        plan.documents.filter((document) => !document.metadata.documentDate).length
    ) {
      throw new Error(`Checkpoint build ${build.buildId} has inconsistent session metadata`)
    }
    assertBuildCheckpointConsistency(build)

    for (const expectedQuestion of plan.questions) {
      const question = checkpoint.questions[expectedQuestion.questionId]
      if (
        !question ||
        question.buildId !== plan.buildId ||
        question.question !== expectedQuestion.question ||
        question.groundTruth !== expectedQuestion.groundTruth ||
        question.questionType !== expectedQuestion.questionType ||
        question.questionDate !== expectedQuestion.questionDate
      ) {
        throw new Error(
          `Checkpoint question ${expectedQuestion.questionId} no longer matches its validated build plan`
        )
      }
    }
  }
}

/**
 * Reuse only completed provider builds. Query-time state is intentionally not
 * copied, allowing a new retrieval/answer/evaluation protocol to start cleanly
 * while retaining the exact validated ingestion containers.
 */
export function cloneCompletedBuildsForReuse(
  source: RunCheckpoint,
  plans: ValidatedBuildPlan[]
): BuildCheckpoint[] {
  assertResumeBuilds(source, plans)
  return plans.map((plan) => {
    const sourceBuild = source.builds[plan.buildId]
    if (!sourceBuild) throw new Error(`Source run is missing build ${plan.buildId}`)
    if (sourceBuild.ingest.status !== "completed") {
      throw new Error(`Cannot reuse build ${plan.buildId}; ingestion is incomplete`)
    }
    if (sourceBuild.indexing.status !== "completed" || sourceBuild.indexing.failedIds.length > 0) {
      throw new Error(`Cannot reuse build ${plan.buildId}; indexing is incomplete or failed`)
    }
    const build = structuredClone(sourceBuild)
    build.sourceRunId = source.runId
    build.reused = true
    build.reusedPhases = { ingest: true, indexing: true }
    return build
  })
}
