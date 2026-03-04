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

  sqlite.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS provider_benchmark_version_idx
        ON leaderboard_entries (provider, benchmark, version)
    `)
}

// Initialize on import
initDatabase()

export { schema }
