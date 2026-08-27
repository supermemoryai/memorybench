import { parseEvaluationSpec } from "./specs"

export const LONGMEMEVAL_V2_CATEGORY_MAP = {
  "static-environment": "static",
  "static-environment-abs": "static-abs",
  "dynamic-environment": "dynamic",
  "dynamic-environment-abs": "dynamic-abs",
  procedure: "procedure",
  "procedure-abs": "procedure-abs",
  "errors-gotchas": "gotchas",
} as const

export type LongMemEvalV2Category =
  (typeof LONGMEMEVAL_V2_CATEGORY_MAP)[keyof typeof LONGMEMEVAL_V2_CATEGORY_MAP]
export type EvaluationStatus = "completed" | "failed" | "pending" | "blocked"

export interface LongMemEvalV2AggregateRecord {
  questionId: string
  questionType: string
  evalFunction: string
  status: EvaluationStatus
  score?: 0 | 1 | boolean
  isUnknown?: boolean
}

export interface AccuracyBreakdown {
  count: number
  pct_correct: number | null
  pct_answered_wrong: number | null
  pct_unknown: number | null
  count_failed_or_incomplete: number
}

export interface LongMemEvalV2OfficialAggregate {
  overall: {
    overall_full_set: number
    overall_non_abstention_only: number | null
    overall_abstention_only: number | null
    count_all_questions: number
    count_non_abstention: number
    count_abstention: number
  }
  non_abstention_by_category: Record<
    "static" | "dynamic" | "procedure" | "gotchas",
    AccuracyBreakdown
  >
  abstention_by_category: Record<"static-abs" | "dynamic-abs" | "procedure-abs", AccuracyBreakdown>
  combined_abstention_by_category: Record<"static" | "dynamic" | "procedure", AccuracyBreakdown>
  abstention_overall: AccuracyBreakdown
  execution: Record<EvaluationStatus, number>
}

export function categoryFromQuestionType(questionType: string): LongMemEvalV2Category {
  const category =
    LONGMEMEVAL_V2_CATEGORY_MAP[questionType as keyof typeof LONGMEMEVAL_V2_CATEGORY_MAP]
  if (!category) throw new Error(`Unexpected question_type: ${questionType}`)
  return category
}

function numericScore(record: LongMemEvalV2AggregateRecord): 0 | 1 {
  if (record.status !== "completed") return 0
  if (record.score === true || record.score === 1) return 1
  if (record.score === false || record.score === 0) return 0
  throw new Error(`Completed question ${record.questionId} is missing a binary score`)
}

function meanScore(records: LongMemEvalV2AggregateRecord[]): number | null {
  if (records.length === 0) return null
  return records.reduce((total, record) => total + numericScore(record), 0) / records.length
}

function breakdown(records: LongMemEvalV2AggregateRecord[]): AccuracyBreakdown {
  const count = records.length
  if (count === 0) {
    return {
      count: 0,
      pct_correct: null,
      pct_answered_wrong: null,
      pct_unknown: null,
      count_failed_or_incomplete: 0,
    }
  }

  const unknownCount = records.filter((record) => record.isUnknown === true).length
  const correctCount = records.filter(
    (record) => numericScore(record) === 1 && record.isUnknown !== true
  ).length
  const wrongCount = count - correctCount - unknownCount
  return {
    count,
    pct_correct: correctCount / count,
    pct_answered_wrong: wrongCount / count,
    pct_unknown: unknownCount / count,
    count_failed_or_incomplete: records.filter((record) => record.status !== "completed").length,
  }
}

/**
 * Aggregate the complete selected question set. Failed, pending, and blocked
 * rows remain in the denominator with score zero instead of disappearing from
 * the official accuracy.
 */
export function aggregateLongMemEvalV2(
  records: LongMemEvalV2AggregateRecord[]
): LongMemEvalV2OfficialAggregate {
  if (records.length === 0) throw new Error("No records to aggregate")
  const seen = new Set<string>()
  for (const record of records) {
    if (seen.has(record.questionId)) {
      throw new Error(`Duplicate aggregate question id: ${record.questionId}`)
    }
    seen.add(record.questionId)
    categoryFromQuestionType(record.questionType)
  }

  const enriched = records.map((record) => ({
    record,
    category: categoryFromQuestionType(record.questionType),
    isAbstention: parseEvaluationSpec(record.evalFunction).name === "llm_abstention_checker",
  }))
  const nonAbstention = enriched.filter((item) => !item.isAbstention).map((item) => item.record)
  const abstention = enriched.filter((item) => item.isAbstention).map((item) => item.record)

  const categoryRows = (categories: LongMemEvalV2Category[]) =>
    enriched.filter((item) => categories.includes(item.category)).map((item) => item.record)

  const nonAbstentionByCategory = {
    static: breakdown(categoryRows(["static"])),
    dynamic: breakdown(categoryRows(["dynamic"])),
    procedure: breakdown(categoryRows(["procedure"])),
    gotchas: breakdown(categoryRows(["gotchas"])),
  }
  const abstentionByCategory = {
    "static-abs": breakdown(categoryRows(["static-abs"])),
    "dynamic-abs": breakdown(categoryRows(["dynamic-abs"])),
    "procedure-abs": breakdown(categoryRows(["procedure-abs"])),
  }
  const combined = {
    static: breakdown(categoryRows(["static", "static-abs"])),
    dynamic: breakdown(categoryRows(["dynamic", "dynamic-abs"])),
    procedure: breakdown(categoryRows(["procedure", "procedure-abs"])),
  }

  const execution: Record<EvaluationStatus, number> = {
    completed: 0,
    failed: 0,
    pending: 0,
    blocked: 0,
  }
  for (const record of records) execution[record.status] += 1

  return {
    overall: {
      overall_full_set: meanScore(records) ?? 0,
      overall_non_abstention_only: meanScore(nonAbstention),
      overall_abstention_only: meanScore(abstention),
      count_all_questions: records.length,
      count_non_abstention: nonAbstention.length,
      count_abstention: abstention.length,
    },
    non_abstention_by_category: nonAbstentionByCategory,
    abstention_by_category: abstentionByCategory,
    combined_abstention_by_category: combined,
    abstention_overall: breakdown(abstention),
    execution,
  }
}
