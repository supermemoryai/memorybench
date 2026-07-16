import { existsSync, readFileSync } from "fs"
import { join } from "path"
import type { Benchmark, BenchmarkConfig, QuestionFilter } from "../../types/benchmark"
import type {
  UnifiedQuestion,
  UnifiedSession,
  UnifiedMessage,
  QuestionTypeRegistry,
} from "../../types/unified"
import type { BABILongItem } from "./types"
import { logger } from "../../utils/logger"

const DEFAULT_DATA_PATH = "./data/benchmarks/babilong"
const DEFAULT_CONTEXT_LENGTH = "0k"

const QA_FOLDERS = [
  "qa1", "qa2", "qa3", "qa4", "qa5",
  "qa6", "qa7", "qa8", "qa9", "qa10",
  "qa11", "qa12", "qa13", "qa14", "qa15",
  "qa16", "qa17", "qa18", "qa19", "qa20",
]

/**
 * BABILong question types - native task types from the dataset (official paper names).
 */
export const BABILONG_QUESTION_TYPES: QuestionTypeRegistry = {
  qa1: { id: "qa1", alias: "single", description: "Single supporting fact" },
  qa2: { id: "qa2", alias: "two", description: "Two supporting facts" },
  qa3: { id: "qa3", alias: "three", description: "Three supporting facts" },
  qa4: { id: "qa4", alias: "two-arg", description: "Two argument relations" },
  qa5: { id: "qa5", alias: "three-arg", description: "Three argument relations" },
  qa6: { id: "qa6", alias: "yes-no", description: "Yes/no questions" },
  qa7: { id: "qa7", alias: "counting", description: "Counting" },
  qa8: { id: "qa8", alias: "lists-sets", description: "Lists/sets" },
  qa9: { id: "qa9", alias: "simple-neg", description: "Simple negation" },
  qa10: { id: "qa10", alias: "indef-know", description: "Indefinite knowledge" },
  qa11: { id: "qa11", alias: "basic-coref", description: "Basic coreference" },
  qa12: { id: "qa12", alias: "conjunction", description: "Conjunction" },
  qa13: { id: "qa13", alias: "compound-coref", description: "Compound coreference" },
  qa14: { id: "qa14", alias: "time-reasoning", description: "Time reasoning" },
  qa15: { id: "qa15", alias: "basic-deduction", description: "Basic deduction" },
  qa16: { id: "qa16", alias: "basic-induction", description: "Basic induction" },
  qa17: { id: "qa17", alias: "positional-reasoning", description: "Positional reasoning" },
  qa18: { id: "qa18", alias: "size-reasoning", description: "Size reasoning" },
  qa19: { id: "qa19", alias: "path-finding", description: "Path finding" },
  qa20: { id: "qa20", alias: "qa20", description: "Task 20" },
}

export class BABILongBenchmark implements Benchmark {
  name = "babilong"

  private questions: UnifiedQuestion[] = []
  private sessionsMap: Map<string, UnifiedSession[]> = new Map()
  private dataPath: string = ""
}

export default BABILongBenchmark