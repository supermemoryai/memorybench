import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { existsSync, mkdirSync } from "fs"
import { dirname } from "path"
import * as schema from "./schema"

const DB_PATH = "./data/leaderboard.db"

// Ensure data directory exists
const dbDir = dirname(DB_PATH)
if (!existsSync(dbDir)) {
  mkdirSync(dbDir, { recursive: true })
}

// Create SQLite connection using Bun's native driver
const sqlite = new Database(DB_PATH)

// Enable WAL mode for better concurrent access
sqlite.exec("PRAGMA journal_mode = WAL")

// Create Drizzle instance
export const db = drizzle(sqlite, { schema })

// Initialize database tables
export function initDatabase() {
  sqlite.exec(`
        CREATE TABLE IF NOT EXISTS leaderboard_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            benchmark TEXT NOT NULL,
            version TEXT NOT NULL DEFAULT 'baseline',
            benchmark_scope TEXT,
            dataset_identity TEXT,
            dataset_fingerprint TEXT,
            question_set_fingerprint TEXT,
            protocol_identity TEXT,
            protocol_fingerprint TEXT,
            retrieval_top_k INTEGER,
            primary_metric_key TEXT,
            primary_metric_value REAL,
            primary_metric_higher_is_better INTEGER,
            comparison_cohort_key TEXT,
            accuracy REAL NOT NULL,
            total_questions INTEGER NOT NULL,
            correct_count INTEGER NOT NULL,
            by_question_type TEXT NOT NULL,
            latency_stats TEXT,
            evaluations TEXT,
            provider_code TEXT NOT NULL,
            prompts_used TEXT,
            judge_model TEXT NOT NULL,
            answering_model TEXT NOT NULL,
            added_at TEXT NOT NULL,
            notes TEXT
        )
    `)

  const columns = new Set(
    (
      sqlite.query("PRAGMA table_info(leaderboard_entries)").all() as Array<{
        name: string
      }>
    ).map((column) => column.name)
  )
  const identityColumns: Array<[string, string]> = [
    ["benchmark_scope", "TEXT"],
    ["dataset_identity", "TEXT"],
    ["dataset_fingerprint", "TEXT"],
    ["question_set_fingerprint", "TEXT"],
    ["protocol_identity", "TEXT"],
    ["protocol_fingerprint", "TEXT"],
    ["retrieval_top_k", "INTEGER"],
    ["primary_metric_key", "TEXT"],
    ["primary_metric_value", "REAL"],
    ["primary_metric_higher_is_better", "INTEGER"],
    ["comparison_cohort_key", "TEXT"],
  ]
  for (const [name, type] of identityColumns) {
    if (!columns.has(name)) {
      sqlite.exec(`ALTER TABLE leaderboard_entries ADD COLUMN ${name} ${type}`)
    }
  }

  // The old index collapsed different datasets/protocols/retrieval policies.
  sqlite.exec("DROP INDEX IF EXISTS provider_benchmark_version_idx")
  sqlite.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS provider_benchmark_version_cohort_idx
        ON leaderboard_entries (provider, benchmark, version, comparison_cohort_key)
    `)
}

// Initialize on import
initDatabase()

export { schema }
