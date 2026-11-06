import { describe, expect, test } from "bun:test"
import { buildJudgePrompt } from "./base"
import type { JudgeInput } from "../types/judge"
import type { ProviderPrompts } from "../types/prompts"
import { LONGMEMEVAL_QUESTION_TYPES } from "../benchmarks/longmemeval"
import { CONVOMEM_QUESTION_TYPES } from "../benchmarks/convomem"
import { SUPERMEMORY_PROMPTS } from "../providers/supermemory/prompts"
import { MEM0_PROMPTS } from "../providers/mem0/prompts"
import { ZEP_PROMPTS } from "../providers/zep/prompts"
import { RAG_PROMPTS } from "../providers/rag/prompts"
import { FILESYSTEM_PROMPTS } from "../providers/filesystem/prompts"

const PROVIDER_PROMPTS: Record<string, ProviderPrompts> = {
  supermemory: SUPERMEMORY_PROMPTS,
  mem0: MEM0_PROMPTS,
  zep: ZEP_PROMPTS,
  rag: RAG_PROMPTS,
  filesystem: FILESYSTEM_PROMPTS,
}

const QUESTION_TYPES = [
  ...Object.keys(LONGMEMEVAL_QUESTION_TYPES),
  ...Object.keys(CONVOMEM_QUESTION_TYPES),
]

describe("buildJudgePrompt", () => {
  for (const questionType of QUESTION_TYPES) {
    test(`every provider is judged with the same prompt for ${questionType}`, () => {
      const input: JudgeInput = {
        question: "Where did I go on my last trip?",
        questionType,
        groundTruth: "Lisbon",
        hypothesis: "You went to Portugal.",
      }
      const expected = buildJudgePrompt(input)
      for (const [name, providerPrompts] of Object.entries(PROVIDER_PROMPTS)) {
        const prompt = buildJudgePrompt({ ...input, providerPrompts })
        expect({ name, prompt }).toEqual({ name, prompt: expected })
      }
    })
  }
})
