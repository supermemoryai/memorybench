import { buildContextString } from "../types/prompts"

export function buildDefaultAnswerPrompt(
  question: string,
  context: unknown[],
  questionDate?: string
): string {
  const contextStr = buildContextString(context)

  return `You are a question-answering system. Based on the retrieved context below, answer the question.

Question: ${question}
Question Date: ${questionDate || "Not specified"}

Retrieved Context (raw JSON from memory provider):
${contextStr}

Instructions:
- The context above is the raw JSON response from a memory search API
- Extract relevant information from the JSON to answer the question
- Consider any temporal/date information present in the data
- If the context contains enough information, provide a clear, concise answer
- If the context does not contain enough information, respond with "I don't know"
- Base your answer ONLY on the provided context

Answer:`
}

export const DEFAULT_JUDGE_PROMPT = `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no.

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
