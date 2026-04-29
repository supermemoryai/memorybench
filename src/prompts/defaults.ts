import { buildContextString, buildReformattedContext } from "../types/prompts"

/**
 * Detects questions that require enumerating multiple items (list questions).
 * Used to raise confidence threshold and inject exhaustive-list instruction.
 */
export function detectListQuestion(question: string): boolean {
  const q = question.toLowerCase()
  return /what (does|did|do)\s+\w+\s+(do|like|enjoy|prefer|eat|drink|watch|read|play|practice|study|take|make|have|partake|participate)|what are\s+\w+'s|list\s+|what activities|what hobbies|what things|what kinds|name (all|the|some)|what (places|people|items|books|movies|foods|sports|interests|subjects|topics|instruments|languages|courses|classes|games|shows|pets|skills|goals|plans)|how many|what .* partake|what .* participate|what .* involved/.test(q)
}

/**
 * v27: Two-stage Chain-of-Thought pipeline.
 * Stage 1: Reason through evidence, produce structured draft.
 * Stage 2: Verify draft against evidence (called separately in answer.ts).
 */

export function detectPreferenceQuestion(question: string): boolean {
  const q = question.toLowerCase()
  return /any (tips|advice|suggestions?|recommend|ideas)|what (should|would|do) (i|you)|do you think|should i|could you (suggest|recommend)|what.*(look for|consider|try)/i.test(q)
}

export function buildStage1Prompt(
  question: string,
  context: unknown[],
  questionDate?: string,
  sessionDateMap?: Record<string, string>,
  questionType?: string,
): string {
  const contextStr = buildReformattedContextWithDates(context, sessionDateMap)
  const listExhaustEnabled = process.env.ENGRAM_LIST_EXHAUST !== '0'
  const isListQ = listExhaustEnabled && detectListQuestion(question)
  const listInstruction = isListQ
    ? `\n7. LIST QUESTIONS: This question asks for multiple items — enumerate ALL items found across ALL evidence fragments. Do not stop after the first match. Output as a comma-separated list. Missing even one item counts as a wrong answer.`
    : ''

  const isPrefQ = questionType === 'single-session-preference' || detectPreferenceQuestion(question)
  const preferenceInstruction = isPrefQ
    ? `\n8. PERSONALIZATION (REQUIRED): This is a preference/advice question. You MUST cite the specific things the user already mentioned in their memories — named items, apps, tools, experiences, goals. Generic advice that could apply to anyone is WRONG. If the user already owns something, don't suggest they buy it — tell them how to use it. Reference their exact words where possible.`
    : ''

  const isUpdateQ = questionType === 'knowledge-update'
  const updateInstruction = isUpdateQ
    ? `\n8. KNOWLEDGE UPDATE (REQUIRED): The question asks about the user's CURRENT state after one or more changes. When multiple evidence fragments give different values for the same fact, the fragment with the MOST RECENT [Recorded: ...] date is the current truth — always prefer it over older fragments. Explicitly identify the timeline: "Earlier [date]: X → Later [date]: Y → Current answer: Y".`
    : ''

  return `You are an expert analysis engine. Answer the question using ONLY the provided Verbatim Evidence.

Question: ${question}
Question Date: ${questionDate || "Not specified"}

RETRIEVED EVIDENCE:
${contextStr}

INSTRUCTIONS:
1. Scan ALL evidence fragments before answering. Do not stop at the first relevant fact.
2. If the answer requires combining multiple facts, explicitly chain them: Fact A + Fact B → Inference.
3. Use dates from [Recorded: ...] to resolve temporal expressions ("yesterday", "last week", etc.). Calculate relative dates (e.g. "last week" from a recording date of Oct 15 means ~Oct 8).
4. Extract the answer from Verbatim Evidence, not Fact Summary. Summaries are only for context (who "she" is, etc.).
5. Use SPECIFIC values verbatim — "Sweden" not "her home country", "clarinet and violin" not just one.
6. For inference/hypothetical questions, reason from facts and give a direct answer + one brief reason.
7. COMPLETENESS: If the question asks about activities, hobbies, interests, preferences, or any attribute that could have multiple answers, enumerate ALL items found across ALL evidence. Missing items counts as wrong.${listInstruction}${preferenceInstruction}${updateInstruction}

MULTI-HOP EXAMPLE:
Q: "When did Alex start volunteering at the shelter?"
Evidence:
  [Fact 1] [Recorded: 15 Oct 2023] Verbatim: "I started helping out at the local animal shelter last week"
  [Fact 2] Verbatim: "Alex volunteers every Saturday at the shelter"
Reasoning: Fact 1 recorded 15 Oct 2023 says "last week" → started ~8 Oct 2023. Fact 2 confirms ongoing volunteering. Answer: around 8 October 2023.

Output ONLY this JSON (no markdown, no backticks):
{
  "reasoning_steps": ["step1: ...", "step2: ..."],
  "hop_chain": [{"fact_ids": [1, 2], "inference": "combining X and Y yields Z"}],
  "draft_answer": "the answer",
  "confidence": 85
}`
}

export function buildStage2Prompt(
  question: string,
  context: unknown[],
  stage1Response: string,
  questionDate?: string
): string {
  const listExhaustEnabled = process.env.ENGRAM_LIST_EXHAUST !== '0'
  const isListQ = listExhaustEnabled && detectListQuestion(question)
  const listCheck = isListQ
    ? `\n5. LIST COMPLETENESS: This question asks for multiple items. Scan ALL evidence fragments and verify no items were omitted. Add any missing items to final_answer.`
    : ''

  return `You are a verification engine. Check whether this draft answer is correct.

Question: ${question}
Question Date: ${questionDate || "Not specified"}

Draft response:
${stage1Response}

Verbatim Evidence (ground truth):
${buildReformattedContext(context)}

VERIFY:
1. Does every claim in the draft trace back to specific Verbatim Evidence?
2. Are there hallucinations (claims not supported by any evidence)?
3. Did the draft miss relevant evidence that changes or extends the answer? Scan ALL evidence fragments for additional items.
4. For temporal answers: are the date calculations correct given the [Recorded: ...] timestamps?
5. If the answer could contain multiple items, verify completeness — check every evidence fragment for additional items the draft may have missed.${listCheck}

Output ONLY this JSON (no markdown, no backticks):
{
  "final_answer": "corrected answer or same as draft",
  "confidence": 90,
  "changes": ["changed X because Y"],
  "hallucination_free": true
}`
}

/**
 * Legacy single-stage prompt (kept for fallback/comparison).
 */
export function buildDefaultAnswerPrompt(
  question: string,
  context: unknown[],
  questionDate?: string
): string {
  const contextStr = buildReformattedContext(context)

  return `You are a precise information extraction engine. Answer the question using ONLY the provided evidence.

Question: ${question}
Question Date: ${questionDate || "Not specified"}

RETRIEVED EVIDENCE:
${contextStr}

RULES (mandatory — violating any rule is a failure):

1. Your answer MUST be extracted from "Verbatim Evidence" lines when available. These contain the original words spoken — they are the ground truth.
2. Use "Fact Summary" lines only to understand context (who "she" refers to, relationships between people). Never use a summary when verbatim evidence contains a more specific answer.
3. Scan ALL facts before answering. Combine information across multiple facts when needed.
   - Lists: enumerate ALL matching items (activities, places, items, people). Separate with commas.
4. Use SPECIFIC values, never paraphrases.
   - Verbatim says "Sweden" → answer "Sweden", not "her home country"
   - Verbatim says "clarinet and violin" → answer both, not just one
   - Copy proper nouns, names, places, dates, and specifics exactly as they appear in verbatim evidence.
5. For inference/hypothetical questions ("would", "likely", "might"), REASON from the facts — give a direct answer ("Yes", "No", "Likely yes", "Probably not") plus one brief reason.
6. Keep answers short and direct. No preamble, no "Based on the context...", no explanation unless reasoning is required.
7. Only say "I don't know" if the facts contain ZERO relevant information AND inference is impossible.

Answer:`
}

/**
 * Build reformatted context with conversation dates injected from session date map.
 */
function buildReformattedContextWithDates(
  context: unknown[],
  sessionDateMap?: Record<string, string>
): string {
  if (!Array.isArray(context) || context.length === 0) return "(no facts retrieved)"

  return context
    .map((item: any, i: number) => {
      const canonical = item?.content || "(no content)"
      const support = item?.metadata?.supportText
      const subject = item?.metadata?.subject || ""
      const sessionId = item?.metadata?.sessionId || ""

      // Resolve session date: try LoCoMo session date map first, then fall back to
      // the top-level timestamp field that engram/LongMemEval providers emit.
      let dateStr = ""
      if (sessionDateMap && sessionId) {
        const match = sessionId.match(/session_(\d+)/)
        if (match) {
          const sessionKey = `session_${match[1]}_date_time`
          if (sessionDateMap[sessionKey]) {
            dateStr = `[Recorded: ${sessionDateMap[sessionKey]}]`
          }
        }
      }
      if (!dateStr && item?.timestamp) {
        // ISO timestamp → readable date, e.g. "2023-03-04"
        const ts = String(item.timestamp)
        const d = new Date(ts)
        if (!isNaN(d.getTime())) {
          dateStr = `[Recorded: ${d.toISOString().slice(0, 10)}]`
        }
      }

      if (support) {
        return `[Fact ${i + 1}] ${dateStr}
Verbatim Evidence: "${support}"
Fact Summary: ${canonical}${subject ? `\nSubject: ${subject}` : ""}`
      }

      return `[Fact ${i + 1}] ${dateStr}
${canonical}${subject ? `\nSubject: ${subject}` : ""}`
    })
    .join("\n\n")
}

export const DEFAULT_JUDGE_PROMPT = `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no.

IMPORTANT — For lists and sets: ignore order. "mountains, beach, forest" is correct when the ground truth is "beach, mountains, forest". Accept semantically equivalent phrasing for list items (e.g. "counseling and mental health" is equivalent to "counseling or mental health"). A response that includes all required items but also includes one or two extra items should still be marked correct.

Respond with ONLY a JSON object:
{"score": 1, "label": "correct", "explanation": "..."} if the response contains the correct answer
{"score": 0, "label": "incorrect", "explanation": "..."} if the response does not contain the correct answer`

export const ABSTENTION_JUDGE_PROMPT = `You are evaluating an abstention question. The correct answer is that the information was NOT in the conversation, so the system should abstain or say it doesn't know.

The hypothesis is CORRECT if the system correctly abstains, says "I don't know", indicates uncertainty, or explicitly states the information is not available. It is INCORRECT if the system makes up an answer or hallucinates.

Respond with ONLY a JSON object:
{"score": 1, "label": "correct", "explanation": "..."} if the system properly abstained
{"score": 0, "label": "incorrect", "explanation": "..."} if the system hallucinated an answer`

export const TEMPORAL_JUDGE_PROMPT = `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct.

Respond with ONLY a JSON object:
{"score": 1, "label": "correct", "explanation": "..."} if the response contains the correct answer
{"score": 0, "label": "incorrect", "explanation": "..."} if the response does not contain the correct answer`

export const KNOWLEDGE_UPDATE_JUDGE_PROMPT = `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.

Respond with ONLY a JSON object:
{"score": 1, "label": "correct", "explanation": "..."} if the response contains the correct answer
{"score": 0, "label": "incorrect", "explanation": "..."} if the response does not contain the correct answer`

export const PREFERENCE_JUDGE_PROMPT = `I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.

Respond with ONLY a JSON object:
{"score": 1, "label": "correct", "explanation": "..."} if the response satisfies the rubric
{"score": 0, "label": "incorrect", "explanation": "..."} if the response does not satisfy the rubric`

export function getJudgePromptForType(questionType: string): string {
  const type = questionType.toLowerCase()

  if (type.includes("abstention") || type.includes("adversarial")) {
    return ABSTENTION_JUDGE_PROMPT
  }

  if (type.includes("temporal")) {
    return TEMPORAL_JUDGE_PROMPT
  }

  if (type.includes("update") || type.includes("changing")) {
    return KNOWLEDGE_UPDATE_JUDGE_PROMPT
  }

  if (type.includes("preference")) {
    return PREFERENCE_JUDGE_PROMPT
  }

  return DEFAULT_JUDGE_PROMPT
}
