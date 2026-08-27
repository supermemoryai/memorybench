import type {
  BuildAwareRunDetail,
  LongMemEvalV2Domain,
  LongMemEvalV2ProviderName,
  LongMemEvalV2ReasoningEffort,
  LongMemEvalV2RunThrough,
  LongMemEvalV2Tier,
  StartLongMemEvalV2RunParams,
} from "./api"

export type LongMemEvalV2ResumeTarget = BuildAwareRunDetail["currentStage"] | "run"

export function requiresFullScopeResumeConfirmation(
  config: Pick<
    BuildAwareRunDetail["config"],
    "questionIds" | "limit" | "perCategory" | "haystackLimit"
  >,
  target: LongMemEvalV2ResumeTarget | null
): boolean {
  const fullScope =
    config.questionIds === undefined &&
    config.limit === undefined &&
    config.perCategory === undefined &&
    config.haystackLimit === undefined
  return fullScope && target !== null && target !== "plan"
}

export interface LongMemEvalV2LaunchValues {
  runId: string
  provider: LongMemEvalV2ProviderName
  datasetPath: string
  tier: LongMemEvalV2Tier
  allowMedium: boolean
  domain: LongMemEvalV2Domain
  selectionMode: "all-haystacks" | "haystack-limit" | "questions"
  haystackLimit: number
  questionIds: string
  canary: boolean
  topK: number
  evidenceTopK: number
  readerModel: string
  evaluatorModel: string
  reasoningEffort: LongMemEvalV2ReasoningEffort
  evaluatorReasoningEffort: LongMemEvalV2ReasoningEffort
  buildConcurrency: number
  questionConcurrency: number
  trajectoryConcurrency: number
  maxInFlightRequests: number
  indexingTimeoutMinutes: number
  maxTrajectoryAttempts: number
  strictIngestion: boolean
  runThrough: LongMemEvalV2RunThrough
  allowFullRun: boolean
  forceBuild: boolean
  freshQuery: boolean
}

export function parseLongMemEvalV2QuestionIds(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[\s,]+/)
        .map((value) => value.trim())
        .filter(Boolean)
    ),
  ]
}

export function validateLongMemEvalV2Launch(values: LongMemEvalV2LaunchValues): string | null {
  if (!values.runId.trim()) return "Run ID is required"
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(values.runId.trim())) {
    return "Run ID must be 1–100 characters using only letters, numbers, underscores, and hyphens"
  }
  if (!values.datasetPath.trim()) return "Prepared dataset path is required"
  if (!values.readerModel.trim()) return "Reader model is required"
  if (!values.evaluatorModel.trim()) return "Evaluator model is required"
  if (values.tier === "medium" && values.runThrough !== "plan" && !values.allowMedium) {
    return "Confirm the high-cost medium tier before starting"
  }

  const positiveIntegerFields: Array<[string, number]> = [
    ["Top K", values.topK],
    ["Evidence Top K", values.evidenceTopK],
    ["Build concurrency", values.buildConcurrency],
    ["Question concurrency", values.questionConcurrency],
    ["Trajectory concurrency", values.trajectoryConcurrency],
    ["Maximum in-flight requests", values.maxInFlightRequests],
    ["Indexing timeout", values.indexingTimeoutMinutes],
    ["Maximum trajectory attempts", values.maxTrajectoryAttempts],
  ]
  if (values.selectionMode === "haystack-limit") {
    positiveIntegerFields.push(["Haystack limit", values.haystackLimit])
  }
  for (const [label, value] of positiveIntegerFields) {
    if (!Number.isInteger(value) || value < 1) return `${label} must be an integer of at least 1`
  }
  if (values.evidenceTopK > values.topK) return "Evidence Top K cannot be greater than Top K"

  const questionIds =
    values.selectionMode === "questions" ? parseLongMemEvalV2QuestionIds(values.questionIds) : []
  if (values.selectionMode === "questions" && questionIds.length === 0) {
    return "Enter at least one question ID or choose a haystack selection"
  }
  if (values.canary && questionIds.length !== 1) {
    return "A canary requires exactly one question ID"
  }
  if (values.canary && values.runThrough !== "query") {
    return "A canary can only run through retrieval"
  }
  if (
    values.selectionMode === "all-haystacks" &&
    values.runThrough !== "plan" &&
    !values.allowFullRun
  ) {
    return "Confirm the full-tier run before starting a non-Plan stage without question IDs"
  }
  return null
}

export function toStartLongMemEvalV2RunParams(
  values: LongMemEvalV2LaunchValues
): StartLongMemEvalV2RunParams {
  const validationError = validateLongMemEvalV2Launch(values)
  if (validationError) throw new Error(validationError)

  const questionIds =
    values.selectionMode === "questions" ? parseLongMemEvalV2QuestionIds(values.questionIds) : []
  return {
    runId: values.runId.trim(),
    provider: values.provider,
    datasetPath: values.datasetPath.trim(),
    tier: values.tier,
    allowMedium: values.allowMedium,
    domain: values.domain,
    ...(questionIds.length > 0 ? { questionIds } : {}),
    ...(values.selectionMode === "haystack-limit" ? { haystackLimit: values.haystackLimit } : {}),
    mode: values.canary ? "one-trajectory-canary" : "benchmark",
    topK: values.topK,
    evidenceTopK: values.evidenceTopK,
    readerModel: values.readerModel,
    evaluatorModel: values.evaluatorModel,
    reasoningEffort: values.reasoningEffort,
    evaluatorReasoningEffort: values.evaluatorReasoningEffort,
    buildConcurrency: values.buildConcurrency,
    questionConcurrency: values.questionConcurrency,
    trajectoryConcurrency: values.trajectoryConcurrency,
    maxInFlightRequests: values.maxInFlightRequests,
    indexingTimeoutMs: values.indexingTimeoutMinutes * 60_000,
    maxTrajectoryAttempts: values.maxTrajectoryAttempts,
    strictIngestion: values.strictIngestion,
    runThrough: values.canary ? "query" : values.runThrough,
    allowFullRun:
      values.selectionMode === "all-haystacks" &&
      values.runThrough !== "plan" &&
      values.allowFullRun,
    forceBuild: values.forceBuild,
    freshQuery: values.freshQuery,
  }
}
