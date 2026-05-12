/**
 * Prompts for Sandra:
 *   1. EXTRACT_SYSTEM_PROMPT — used at ingestion to turn a raw session into
 *      structured {entities, facts}. Copied VERBATIM from the Python harness
 *      at `sandra/benchmark/longmemeval/src/ingest_claude.py:EXTRACT_SYSTEM_PROMPT`
 *      so the extraction quality is identical and the 76% baseline transfers.
 *      Do not edit without a matching edit on the Python side.
 *
 *   2. answerPrompt — how memorybench's answering LLM reads Sandra's retrieval
 *      output. Mirrors the shape mem0 and zep provide so the downstream
 *      reader treats all three providers comparably.
 */

import type { ProviderPrompts } from "../../types/prompts"

export const EXTRACT_SYSTEM_PROMPT = `You extract a structured knowledge-graph from a single chat session so a downstream system can later answer questions about it.

Output a single JSON object with this exact shape:

{
  "entities": [
    {"name": "<canonical name>", "kind": "person|place|product|activity|topic|other", "notes": "<optional 1-sentence disambiguation>"}
  ],
  "facts": [
    {
      "predicate": "<snake_case short form, e.g. repainted_bedroom, bought_running_shoes, assistant_listed_jobs>",
      "statement": "<one sentence restating the fact verbatim>",
      "subject": "user|assistant",
      "source": "user|assistant|synthesis",
      "object": "<entity name matching the entities list above, or empty>",
      "value": "<scalar value, color, price, list-contents, whatever is the answer-worthy content>",
      "event_date": "<ABSOLUTE date in YYYY-MM-DD form when the event happened, empty if not stated>",
      "turn_idx": <integer turn index 0-based in the session>,
      "typed_refs": {"<unit_concept>": <number>, ...}
    }
  ]
}

Extraction rules:

1. **User facts** (source="user"): anything the user asserts — events, preferences, purchases, corrections, emotional states, plans. One fact per atomic claim. Do not merge.

2. **Assistant facts** (source="assistant"): when the assistant provides structured information that might be referenced later — numbered lists, ranked recommendations, direct answers to factual questions, enumerated items. Put the full list verbatim in \`value\` (enumerated items separated by \\n so "1. Foo\\n2. Bar\\n..." is preserved). Use predicates like "assistant_listed_<topic>" or "assistant_recommended_<topic>".

3. **Preference synthesis** (source="synthesis"): if the user reveals preference patterns across multiple turns (likes, dislikes, habits, constraints, goals), emit ONE fact at the end with predicate="preference_profile" whose \`value\` describes the user's preferences as a short rubric (e.g. "prefers healthy high-protein meals with quinoa and roasted vegetables, open to new twists on chicken salads and wraps, avoids high-calorie options"). This is how you answer "suggest me something" style questions.

4. **Temporal absolutes**: ALWAYS resolve relative dates to absolute YYYY-MM-DD using the session timestamp as anchor. "Yesterday" when session is 2023/05/21 (Sun) → "2023-05-20". "Last Thursday" when session is 2023/05/27 (Sat) → "2023-05-25". If a date range is given ("March 9th" this year), use the session year. If truly unknown, leave empty — do NOT leave the relative phrase.

5. **Knowledge updates**: if the user corrects a previous statement, emit BOTH the old and the new fact — each with its own turn_idx. Downstream picks the most recent.

6. **Consistency**: use the same entity name consistently. Cite entities by name from the entities list above.

7. **No hallucination**. If unsure, skip it. Better to miss a fact than invent one.

8. **Output valid JSON only**. No prose, no markdown code fences.

9. **Quantified events — ONE FACT PER EVENT, WITH A TYPED NUMERIC REF** (narrow rule, applies ONLY when the source explicitly states a count or measurement about an action):

   The \`value\` string stays as a human-readable label (e.g. "$40 lights", "3 rides", "347 miles YTD"). But you ALSO emit a **\`typed_refs\`** dict where the KEY uses the \`dimension[unit]\` convention and the VALUE is a clean number. This is the authoritative numeric channel that Sandra sums at read time WITHOUT mixing units.

   Convention: snake_case dimension + bracketed unit. Use ONLY these keys (case matters — all lowercase):
    - \`cost[usd]\`, \`cost[eur]\`, \`cost[gbp]\` — money amounts
    - \`distance[miles]\`, \`distance[km]\`, \`distance[m]\` — distances
    - \`duration[minutes]\`, \`duration[hours]\`, \`duration[days]\` — durations
    - \`count[times]\` — pure integer event counts (rides, attendances, festivals)
    - \`mass[kg]\`, \`mass[lbs]\` — weights
    - \`temperature[c]\`, \`temperature[f]\` — temperatures

   Examples:
    - "I bought a Bell Zephyr helmet for $120" → \`{"predicate": "bought_helmet", "value": "$120 Bell Zephyr", "typed_refs": {"cost[usd]": 120}}\`
    - "I rode the Mako, Kraken, and Manta rollercoasters at SeaWorld" → \`{"predicate": "rode_rollercoasters_at_seaworld", "value": "3 rides: Mako, Kraken, Manta", "typed_refs": {"count[times]": 3}}\`
    - "I rode Space Mountain three times at Disneyland" → \`{"predicate": "rode_rollercoaster_at_disneyland", "value": "3 rides on Space Mountain", "typed_refs": {"count[times]": 3}}\`
    - "I attended the Portland Film Festival" → \`{"predicate": "attended_film_festival_portland", "value": "Portland Film Festival", "typed_refs": {"count[times]": 1}}\`
    - "I've clocked 347 miles since the start of the year" → \`{"predicate": "tracked_bike_mileage", "value": "347 miles YTD", "typed_refs": {"distance[miles]": 347}}\`
    - "I ran a 5K in 35 minutes" → \`{"predicate": "ran_5k", "value": "35 min finish", "typed_refs": {"duration[minutes]": 35, "distance[km]": 5}}\`
    - "My goal is 1000 miles by summer" → \`{"predicate": "goal_bike_mileage", "value": "1000 miles by summer", "typed_refs": {}}\`  # GOAL, not actual — do NOT add typed_ref (would be summed wrongly)
    - "I'm due to lubricate my chain on May 15th" → \`{"predicate": "due_lubricate_chain", "value": "May 15", "event_date": "2023-05-15", "typed_refs": {}}\`  # date-only
    - "I prefer quinoa over rice" → \`{"predicate": "prefers_quinoa", "value": "quinoa over rice", "typed_refs": {}}\`  # qualitative

   Rules:
    - DO NOT pre-aggregate — emit ONE fact per event with that event's number.
    - DO NOT mix unit types in one fact — split into separate facts if needed.
    - DO NOT add typed_ref for GOALS, INTENTIONS, FUTURE plans, or QUOTED PRICES that aren't a real spend (e.g. "this bike costs $1000" without a purchase = no typed_ref).
    - DO NOT invent — if no number is stated, omit typed_refs.
    - For dates use \`event_date\` (YYYY-MM-DD), NEVER a typed_ref.
    - typed_refs is OPTIONAL — only emit when the fact is a genuinely quantified ACTUAL ACTION the user took.`

export interface SandraSearchHit {
  predicate?: string
  statement?: string
  value?: string
  event_date?: string
  session_timestamp?: string
  source?: string
  similarity?: number
  turn_idx?: string
  session_id?: string
}

export function buildSandraAnswerPrompt(
  question: string,
  context: unknown[],
  questionDate?: string
): string {
  const hits = context as SandraSearchHit[]
  // Sort hits so facts with explicit event_date come first (useful for
  // temporal questions), then by session_timestamp descending (most recent
  // first, useful for knowledge-update questions where the latest fact wins).
  // This is a stable reorder — retrieval still decides what's in the list.
  const sorted = [...hits].sort((a, b) => {
    const aHasDate = a.event_date ? 1 : 0
    const bHasDate = b.event_date ? 1 : 0
    if (aHasDate !== bHasDate) return bHasDate - aHasDate
    const aTs = a.session_timestamp || ""
    const bTs = b.session_timestamp || ""
    return bTs.localeCompare(aTs)
  })
  const rendered = sorted
    .map((h, i) => {
      const dateTag = h.event_date ? ` [event: ${h.event_date}]` : ""
      const sessTag = h.session_timestamp ? ` [session: ${h.session_timestamp}]` : ""
      const srcTag = h.source ? ` (${h.source})` : ""
      const predTag = h.predicate ? ` <${h.predicate}>` : ""
      const head = h.statement || h.value || JSON.stringify(h)
      return `[${i + 1}]${dateTag}${sessTag}${srcTag}${predTag} ${head}`
    })
    .join("\n\n")

  const dateLine = questionDate ? `\nQuestion asked on: ${questionDate}\n` : ""
  // Prompt style mirrors mem0's buildMem0AnswerPrompt so Sandra is evaluated
  // under the same answer-generation constraints. The only adaptations are
  // (a) telling the model the entries are structured facts with timestamps
  // (Sandra's retrieval shape), and (b) asking it to synthesize across facts
  // when the question calls for a recommendation or preference answer.
  return `You are an intelligent memory assistant tasked with retrieving accurate information from conversation memories.

Key instructions:
- Analyze the facts with their timestamps carefully.
- **For knowledge-update questions** (e.g. "current X", "latest Y"): prioritize the most recent fact (facts are sorted most-recent first). Earlier contradicting facts are stale.
- **For enumeration / counting questions** (e.g. "how many", "list all"): count distinct events across ALL retrieved facts. Do not stop after finding one.
- **For temporal comparison** (e.g. "which first, X or Y"): compare event_date or session_timestamp on both items. Answer with the one whose date is earlier.
- **For preference / suggestion questions**: synthesize a recommendation from the user's prior behavior shown in the facts.
- Convert relative time references ("last year", "two months ago") into absolute dates using the session timestamps.
- Look for direct evidence in the facts; do not invent.
- Don't confuse character names with actual users.

Fact entry format:
- \`[N]\` index of the fact
- \`[event: YYYY-MM-DD]\` when the event happened, if known
- \`[session: ... timestamp]\` when this fact was recorded in conversation
- \`(user|assistant|synthesis)\` source of the fact
- \`<predicate>\` short semantic predicate
- Then the fact statement

Special entries: facts with predicate \`<raw_session_transcript>\` are
**verbatim conversation dumps** from a past session. They contain details
that may not appear as structured facts elsewhere in the list. When
structured facts are silent on a question, read the raw transcripts
carefully — the answer often lives there as literal quoted text.
${dateLine}
Facts:
${rendered}

Question: ${question}

Answer concisely and directly.`
}

export const SANDRA_PROMPTS: ProviderPrompts = {
  answerPrompt: buildSandraAnswerPrompt,
}

export default SANDRA_PROMPTS
