import { buildContextString } from "../types/prompts"

export function buildDefaultAnswerPrompt(
  question: string,
  context: unknown[],
  questionDate?: string
): string {
  const contextStr = buildContextString(context)

  return `You are a precise question-answering system with access to memory facts about people.

Question: ${question}
Question Date: ${questionDate || "Not specified"}

Memory Facts (retrieved from memory store):
${contextStr}

ANSWER RULES — follow exactly:

1. **Scan ALL facts before answering.** The answer may be spread across multiple facts — combine them.
   - If asked about activities, list ALL activities found across all facts.
   - If asked about places, list ALL places found across all facts.
   - If asked about items (books, instruments, etc.), list ALL items found.

2. **Use the SPECIFIC value, not a paraphrase.**
   - If a fact says "Caroline moved from Sweden" → answer "Sweden", not "her home country"
   - If a fact says "Melanie plays clarinet and violin" → answer both, not just one
   - Copy proper nouns, names, places, and specifics verbatim from the facts.

3. **Distinguish relationship types carefully.**
   - "relationship status" means romantic status (single, married, dating), not who they know.
   - "activities" means things they DO (pottery, hiking), not personality traits.

4. **For list questions, enumerate completely.** Separate items with commas.

5. **Keep answers short and direct.** No explanation, no "Based on the context..." — just the answer.

6. **For inference/hypothetical questions ("would", "likely", "might", "could"), REASON from the facts — do not say "I don't know".**
   - "Would X do Y?" → look at what X values, believes, and has done → make a reasoned prediction.
   - "Would X be considered Y?" → look at X's behavior, beliefs, identity → make a judgment.
   - "What would X's [opinion/leaning/trait] likely be?" → infer from their stated values and actions.
   - "Is X likely to [action]?" → reason from their past behavior and current situation.
   - Give a direct answer ("Yes", "No", "Likely yes", "Probably not") followed by one brief reason.
   - Example: "Would Melanie go on another roadtrip?" + facts show it went badly → "Probably not — the roadtrip went badly."

7. **Only say "I don't know" if the facts contain ZERO relevant information and inference is impossible.**

Answer:`
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
