import type { BenchmarkJudgeInput } from "../../types/benchmark"
import type { UnifiedQuestion } from "../../types/unified"

// Verbatim from Mem0's paper harness, reused by Zep, Memobase, MemOS and LangMem, so scores are comparable.
// https://github.com/mem0ai/mem0/blob/aae5989e78a6188b3b047c104d960c9ad0927e75/evaluation/prompts.py (ANSWER_PROMPT_ZEP:
// the single-store variant, for providers that keep both speakers in one container)
const ANSWER_PROMPT =
  '\n    You are an intelligent memory assistant tasked with retrieving accurate information from conversation memories.\n\n    # CONTEXT:\n    You have access to memories from a conversation. These memories contain\n    timestamped information that may be relevant to answering the question.\n\n    # INSTRUCTIONS:\n    1. Carefully analyze all provided memories\n    2. Pay special attention to the timestamps to determine the answer\n    3. If the question asks about a specific event or fact, look for direct evidence in the memories\n    4. If the memories contain contradictory information, prioritize the most recent memory\n    5. If there is a question about time references (like "last year", "two months ago", etc.), \n       calculate the actual date based on the memory timestamp. For example, if a memory from \n       4 May 2022 mentions "went to India last year," then the trip occurred in 2021.\n    6. Always convert relative time references to specific dates, months, or years. For example, \n       convert "last year" to "2022" or "two months ago" to "March 2023" based on the memory \n       timestamp. Ignore the reference while answering the question.\n    7. Focus only on the content of the memories. Do not confuse character \n       names mentioned in memories with the actual users who created those memories.\n    8. The answer should be less than 5-6 words.\n\n    # APPROACH (Think step by step):\n    1. First, examine all memories that contain information related to the question\n    2. Examine the timestamps and content of these memories carefully\n    3. Look for explicit mentions of dates, times, locations, or events that answer the question\n    4. If the answer requires calculation (e.g., converting relative time references), show your work\n    5. Formulate a precise, concise answer based solely on the evidence in the memories\n    6. Double-check that your answer directly addresses the question asked\n    7. Ensure your final answer is specific and avoids vague time references\n\n    Memories:\n\n    {{memories}}\n\n    Question: {{question}}\n    Answer:\n    '

// https://github.com/mem0ai/mem0/blob/aae5989e78a6188b3b047c104d960c9ad0927e75/evaluation/metrics/llm_judge.py
const ACCURACY_PROMPT =
  '\nYour task is to label an answer to a question as ’CORRECT’ or ’WRONG’. You will be given the following data:\n    (1) a question (posed by one user to another user), \n    (2) a ’gold’ (ground truth) answer, \n    (3) a generated answer\nwhich you will score as CORRECT/WRONG.\n\nThe point of the question is to ask about something one user should know about the other user based on their prior conversations.\nThe gold answer will usually be a concise and short answer that includes the referenced topic, for example:\nQuestion: Do you remember what I got the last time I went to Hawaii?\nGold answer: A shell necklace\nThe generated answer might be much longer, but you should be generous with your grading - as long as it touches on the same topic as the gold answer, it should be counted as CORRECT. \n\nFor time related questions, the gold answer will be a specific date, month, year, etc. The generated answer might be much longer or use relative time references (like "last Tuesday" or "next month"), but you should be generous with your grading - as long as it refers to the same date or time period as the gold answer, it should be counted as CORRECT. Even if the format differs (e.g., "May 7th" vs "7 May"), consider it CORRECT if it\'s the same date.\n\nNow it\'s time for the real question:\nQuestion: {question}\nGold answer: {gold_answer}\nGenerated answer: {generated_answer}\n\nFirst, provide a short (one sentence) explanation of your reasoning, then finish with CORRECT or WRONG. \nDo NOT include both CORRECT and WRONG in your response, or it will break the evaluation script.\n\nJust return the label CORRECT or WRONG in a json format with the key as "label".\n'

export function buildLoCoMoAnswerPrompt(question: UnifiedQuestion, context: string): string {
  return ANSWER_PROMPT.replace("{{memories}}", () => context).replace(
    "{{question}}",
    () => question.question
  )
}

export function buildLoCoMoJudgePrompt({ question, hypothesis }: BenchmarkJudgeInput): string {
  return ACCURACY_PROMPT.replace("{question}", () => question.question)
    .replace("{gold_answer}", () => question.groundTruth)
    .replace("{generated_answer}", () => hypothesis)
}
