import { sqliteTable, text, integer, real, uniqueIndex } from "drizzle-orm/sqlite-core"

export const leaderboardEntries = sqliteTable(
  "leaderboard_entries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    // Run identification
    runId: text("run_id").notNull(),
    provider: text("provider").notNull(),
    benchmark: text("benchmark").notNull(),
    version: text("version").notNull().default("baseline"),

    // Immutable like-for-like comparison identity. JSON columns preserve the
    // complete source identities; scalar fingerprints make cohorts auditable.
    benchmarkScope: text("benchmark_scope"),
    datasetIdentity: text("dataset_identity"),
    datasetFingerprint: text("dataset_fingerprint"),
    questionSetFingerprint: text("question_set_fingerprint"),
    protocolIdentity: text("protocol_identity"),
    protocolFingerprint: text("protocol_fingerprint"),
    retrievalTopK: integer("retrieval_top_k"),
    primaryMetricKey: text("primary_metric_key"),
    primaryMetricValue: real("primary_metric_value"),
    primaryMetricHigherIsBetter: integer("primary_metric_higher_is_better", {
      mode: "boolean",
    }),
    comparisonCohortKey: text("comparison_cohort_key"),

    // Results snapshot
    accuracy: real("accuracy").notNull(),
    totalQuestions: integer("total_questions").notNull(),
    correctCount: integer("correct_count").notNull(),

    // Results by question type (JSON string)
    byQuestionType: text("by_question_type").notNull(),

    // Latency stats (JSON string) - contains { ingest, search, answer, evaluate, total }
    latencyStats: text("latency_stats"),

    // Individual question results (JSON string) - array of evaluation results
    evaluations: text("evaluations"),

    // Code snapshot
    providerCode: text("provider_code").notNull(),
    promptsUsed: text("prompts_used"),

    // Metadata
    judgeModel: text("judge_model").notNull(),
    answeringModel: text("answering_model").notNull(),
    addedAt: text("added_at").notNull(),
    notes: text("notes"),
  },
  (table) => ({
    // A display version only replaces a result from the exact same cohort.
    providerBenchmarkVersionCohort: uniqueIndex("provider_benchmark_version_cohort_idx").on(
      table.provider,
      table.benchmark,
      table.version,
      table.comparisonCohortKey
    ),
  })
)

export type LeaderboardEntry = typeof leaderboardEntries.$inferSelect
export type NewLeaderboardEntry = typeof leaderboardEntries.$inferInsert
