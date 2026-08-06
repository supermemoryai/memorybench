import type { Benchmark, DatasetIdentity } from "../types/benchmark"
import type { UnifiedQuestion } from "../types/unified"
import { stableSha256 } from "../utils/stable"

/** Persist the enclosing immutable snapshot revision used for path lookup and resume. */
export function resolveEffectiveDatasetRevision(
  configuredRevision: string | undefined,
  datasetIdentity: DatasetIdentity | undefined
): string | undefined {
  return (
    datasetIdentity?.snapshotFingerprint ??
    datasetIdentity?.datasetFingerprint ??
    configuredRevision
  )
}

/** Resolve a selected ID set into the benchmark's canonical question order. */
export function canonicalizeSelectedQuestionIds(
  allQuestions: readonly Pick<UnifiedQuestion, "questionId">[],
  requestedQuestionIds: readonly string[]
): string[] {
  const allIds = allQuestions.map((question) => question.questionId)
  if (new Set(allIds).size !== allIds.length) {
    throw new Error("Benchmark contains duplicate question IDs")
  }
  if (new Set(requestedQuestionIds).size !== requestedQuestionIds.length) {
    throw new Error("Selected question IDs contain duplicates")
  }

  const knownIds = new Set(allIds)
  const unknownIds = requestedQuestionIds.filter((questionId) => !knownIds.has(questionId))
  if (unknownIds.length > 0) {
    throw new Error(`Unknown question IDs: ${unknownIds.join(", ")}`)
  }

  const selectedIds = new Set(requestedQuestionIds)
  return allIds.filter((questionId) => selectedIds.has(questionId))
}

/**
 * Provider-independent identity for the exact selected benchmark questions and
 * their raw ordered haystacks. Official dataset identity remains authoritative
 * when a benchmark (such as BEAM) supplies one.
 */
export function fingerprintSelectedBenchmarkInput(
  benchmark: Benchmark,
  selectedQuestions: readonly UnifiedQuestion[]
): string {
  const allQuestions = benchmark.getQuestions()
  const canonicalQuestionIds = canonicalizeSelectedQuestionIds(
    allQuestions,
    selectedQuestions.map((question) => question.questionId)
  )
  const questionById = new Map(allQuestions.map((question) => [question.questionId, question]))
  const canonicalQuestions = canonicalQuestionIds.map((questionId) => questionById.get(questionId)!)
  const digestBySessionArray = new WeakMap<object, string>()
  const haystacksByDigest = new Map<
    string,
    { orderedSessionIds: string[]; sessions: ReturnType<Benchmark["getHaystackSessions"]> }
  >()
  const digestByDeclaredGroup = new Map<string, string>()

  const questions = canonicalQuestions.map((question) => {
    const sessions = benchmark.getHaystackSessions(question.questionId)
    const orderedSessionIds = sessions.map((session) => session.sessionId)
    if (
      orderedSessionIds.length !== question.haystackSessionIds.length ||
      orderedSessionIds.some((sessionId, index) => sessionId !== question.haystackSessionIds[index])
    ) {
      throw new Error(
        `Question ${question.questionId} haystack IDs do not match its ordered benchmark sessions`
      )
    }

    let haystackFingerprint = digestBySessionArray.get(sessions)
    if (!haystackFingerprint) {
      haystackFingerprint = stableSha256({
        schemaVersion: 1,
        orderedSessionIds,
        sessions,
      })
      digestBySessionArray.set(sessions, haystackFingerprint)
    }
    if (!haystacksByDigest.has(haystackFingerprint)) {
      haystacksByDigest.set(haystackFingerprint, { orderedSessionIds, sessions })
    }

    const declaredGroupId = benchmark.getIngestionGroupId?.(question.questionId)
    if (declaredGroupId) {
      const existingGroupDigest = digestByDeclaredGroup.get(declaredGroupId)
      if (existingGroupDigest && existingGroupDigest !== haystackFingerprint) {
        throw new Error(
          `Ingestion group ${declaredGroupId} resolves to different raw benchmark haystacks`
        )
      }
      digestByDeclaredGroup.set(declaredGroupId, haystackFingerprint)
    }

    return {
      questionId: question.questionId,
      question: question.question,
      questionType: question.questionType,
      groundTruth: question.groundTruth,
      haystackSessionIds: question.haystackSessionIds,
      metadata: question.metadata,
      ingestionGroupId: declaredGroupId ?? question.questionId,
      haystackFingerprint,
    }
  })

  return stableSha256({
    schemaVersion: 1,
    kind: "selected-benchmark-questions-and-haystacks",
    benchmark: benchmark.name,
    benchmarkScope: benchmark.scope,
    questions,
    haystacks: [...haystacksByDigest.entries()]
      .map(([haystackFingerprint, haystack]) => ({ haystackFingerprint, ...haystack }))
      .sort((left, right) => left.haystackFingerprint.localeCompare(right.haystackFingerprint)),
  })
}
