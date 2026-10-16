/**
 * BEAM paper evaluator prompts.
 *
 * Source: Appendix H, Listings 20 and 21, as implemented at
 * mohammadtavakoli78/BEAM@3e12035532eb85768f1a7cd779832b650c4b2ef9.
 * Keep these strings stable: their hashes are part of the protocol identity.
 */

export const BEAM_NUGGET_JUDGE_PROMPT_VERSION = "beam-paper-listing-20-v1"
export const BEAM_EVENT_EQUIVALENCE_PROMPT_VERSION = "beam-paper-listing-21-v1"

export const BEAM_NUGGET_JUDGE_PROMPT = `You are an expert evaluator tasked with judging whether the LLM's response demonstrates compliance with the specified RUBRIC CRITERION.

## EVALUATION INPUTS
- QUESTION (what the user asked): <question>
- RUBRIC CRITERION (what to check): <rubric_item>
- RESPONSE TO EVALUATE: <llm_response>
## EVALUATION RUBRIC:
The rubric defines a specific requirement, constraint, or expected behavior that the LLM response should demonstrate.

**IMPORTANT**: Pay careful attention to whether the rubric specifies:
- **Positive requirements** (things the response SHOULD include/do)
- **Negative constraints** (things the response SHOULD NOT include/do, often indicated by "no", "not", "avoid", "absent")
## RESPONSIVENESS REQUIREMENT (anchored to the QUESTION)
A compliant response must be **on-topic with respect to the QUESTION** and attempt to answer it.
- If the response does not address the QUESTION, score **0.0** and stop.
- For negative constraints, both must hold: (a) the response is responsive to the QUESTION, and (b) the prohibited element is absent.
## SEMANTIC TOLERANCE RULES:
Judge by meaning, not exact wording.
- Accept **paraphrases** and **synonyms** that preserve intent.
- **Case/punctuation/whitespace** differences must be ignored.
- **Numbers/currencies/dates** may appear in equivalent forms (e.g., "$68,000", "68k", "68,000 USD", or "sixty-eight thousand dollars"). Treat them as equal when numerically equivalent.
- If the rubric expects a number or duration, prefer **normalized comparison** (extract and compare values) over string matching.
## STYLE NEUTRALITY (prevents style contamination):
Ignore tone, politeness, length, and flourish unless the rubric explicitly requires a format/structure (e.g., "itemized list", "no citations", "one sentence").
- Do **not** penalize hedging, voice, or verbosity if content satisfies the rubric.
- Only evaluate format when the rubric **explicitly** mandates it.
## SCORING SCALE:
- **1.0 (Complete Compliance)**: Fully complies with the rubric criterion.
  - Positive: required element present, accurate, properly executed (allowing semantic equivalents).
  - Negative: prohibited element **absent** AND response is **responsive**.

- **0.5 (Partial Compliance)**: Partially complies.
  - Positive: element present but minor inaccuracies/incomplete execution.
  - Negative: generally responsive and mostly avoids the prohibited element but with minor/edge violations.
- **0.0 (No Compliance)**: Fails to comply.
  - Positive: required element missing or incorrect.
  - Negative: prohibited element present **or** response is non-responsive/evasive even if the element is absent.
## EVALUATION INSTRUCTIONS:
1. **Understand the Requirement**: Determine if the rubric is asking for something to be present (positive) or absent (negative/constraint).
2. **Parse Compound Statements**: If the rubric contains multiple elements connected by "and" or commas, evaluate whether:
   - **All elements** must be present for full compliance (1.0)
   - **Some elements** present indicates partial compliance (0.5)
   - **No elements** present indicates no compliance (0.0)

3. **Check Compliance**:
   - For positive requirements: Look for the presence and quality of the required element
   - For negative constraints: Look for the absence of the prohibited element
4. **Assign Score**: Based on compliance with the specific rubric criterion according to the scoring scale above.

5. **Provide Reasoning**: Explain whether the rubric criterion was satisfied and justify the score.
## OUTPUT FORMAT:
Return your evaluation in JSON format with two fields:

{
   "score": [your score: 1.0, 0.5, or 0.0],
   "reason": "[detailed explanation of whether the rubric criterion was satisfied and why this justified the assigned score]"
}

NOTE: ONLY output the json object, without any explanation before or after that`

export const BEAM_EVENT_EQUIVALENCE_SYSTEM_PROMPT = `You are a binary classifier.
If the TWO snippets describe the SAME event/fact, reply **YES**
Otherwise reply **NO**. No extra words. DO NOT provide any exaplanation.`

export const BEAM_EVENT_EQUIVALENCE_USER_PROMPT =
  "First snippet: <reference_event> \n Second snippet: <predicted_event>"

function replaceAllLiteral(value: string, token: string, replacement: string): string {
  return value.split(token).join(replacement)
}

export function buildBeamPaperNuggetPrompt(input: {
  question: string
  nugget: string
  answer: string
}): string {
  return replaceAllLiteral(
    replaceAllLiteral(
      replaceAllLiteral(BEAM_NUGGET_JUDGE_PROMPT, "<question>", input.question),
      "<rubric_item>",
      input.nugget
    ),
    "<llm_response>",
    input.answer
  )
}

export function buildBeamEventEquivalencePrompt(input: {
  referenceEvent: string
  predictedEvent: string
}): string {
  return replaceAllLiteral(
    replaceAllLiteral(
      BEAM_EVENT_EQUIVALENCE_USER_PROMPT,
      "<reference_event>",
      input.referenceEvent
    ),
    "<predicted_event>",
    input.predictedEvent
  )
}

interface BeamSearchResult {
  memory?: string
  chunk?: string
  metadata?: { sessionId?: string }
}

/**
 * Answer prompt from the BEAM 1M run on the v3/v4 API (memorybench-pr44-fix,
 * src/prompts/beam.ts): evidence sorted oldest first as "[YYYY-MM-DD] text", and one
 * event per line for event ordering so the Kendall scorer can split the answer.
 */
export function buildBeamAnswerPrompt(
  question: string,
  questionType: string,
  results: unknown[],
  sessionDates: Map<string, string>
): string {
  const items = (results as BeamSearchResult[])
    .map((r) => {
      const sessionId = r.metadata?.sessionId ?? ""
      return { text: r.memory ?? r.chunk ?? "", sessionId, date: sessionDates.get(sessionId) }
    })
    .filter((item) => item.text.trim())
    .sort(
      (a, b) =>
        (a.date ?? "").localeCompare(b.date ?? "") ||
        a.sessionId.localeCompare(b.sessionId, undefined, { numeric: true })
    )
  const memoriesText = items.length
    ? items
        .map((item, i) => `${i + 1}. ${item.date ? `[${item.date}] ` : ""}${item.text}`)
        .join("\n")
    : "(No memories available)"
  const eventOrderingRule =
    questionType === "event_ordering"
      ? "\n10. For this event-ordering question, output exactly one event per line in chronological order. Do not use bullets, numbering, headings, or explanations."
      : ""
  return `You are an AI assistant with access to stored memories from prior conversations with a user.
Use these memories to answer the following question as accurately and completely as possible.

IMPORTANT RULES:
1. Scan ALL provided memories before answering — do not stop after the first relevant one.
2. If multiple memories contain relevant information, combine and cross-reference them.
3. If the memories contain contradictory information, prefer the more recent one.
4. If the memories don't contain enough information to answer, say exactly: "I don't have enough information to answer this question."
5. For temporal questions: pay attention to dates and relative time references.
6. For ordering questions: present events in chronological order.
7. For preference questions: use the most recently stated preference.
8. Be specific and direct — include exact names, dates, numbers, and details from the memories.
9. Do NOT invent or assume information that isn't in the memories.${eventOrderingRule}

QUESTION: ${question}

RETRIEVED MEMORIES:
${memoriesText}

ANSWER:`
}
