/**
 * Fixed factory + verb vocabulary shared with the in-repo Python harness at
 * `sandra/benchmark/longmemeval/src/schema.py`. Keeping these strings identical
 * means a database populated by either harness is queryable by the other, and
 * that any graph-level comparison between the two Sandra benchmarks is on
 * equal footing.
 */

export const FACTORY_FACT = "lme_fact"
export const FACTORY_ENTITY = "lme_entity"
export const FACTORY_SESSION = "lme_session"
// Raw session transcript: one entity per UnifiedSession, storage holds the
// full turn dump. Exists as a retrieval fallback when the structured
// extractor misses details that are still present verbatim in the source
// conversation. Semantic search can pick these up when fact-level retrieval
// comes up empty.
export const FACTORY_SESSION_RAW = "lme_session_raw"

export const VERB_MENTIONS = "lme_mentions"
export const VERB_STATES = "lme_states"
export const VERB_ABOUT = "lme_about"

export const SESSION_FIELDS = ["session_id", "instance_id", "timestamp"] as const

export interface ExtractedEntity {
  name: string
  kind: string
  notes?: string
}

export interface ExtractedFact {
  predicate: string
  statement: string
  subject?: string
  source?: "user" | "assistant" | "synthesis"
  object?: string
  value?: string
  event_date?: string
  turn_idx?: number
  typed_refs?: Record<string, number>
}

export interface SessionExtraction {
  entities: ExtractedEntity[]
  facts: ExtractedFact[]
}
