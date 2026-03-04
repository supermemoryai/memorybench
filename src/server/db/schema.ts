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
    // Unique constraint: same provider+benchmark+version replaces existing entry
    providerBenchmarkVersion: uniqueIndex("provider_benchmark_version_idx").on(
      table.provider,
      table.benchmark,
      table.version
    ),
  })
)

export type LeaderboardEntry = typeof leaderboardEntries.$inferSelect
export type NewLeaderboardEntry = typeof leaderboardEntries.$inferInsert
