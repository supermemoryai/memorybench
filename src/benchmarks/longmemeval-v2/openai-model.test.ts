import { describe, expect, test } from "bun:test"
import { openAICompletionControls, supportsOpenAIReasoning } from "./openai-model"

describe("LongMemEval-V2 OpenAI model controls", () => {
  test("sends reasoning controls only to reasoning models", () => {
    expect(supportsOpenAIReasoning("gpt-5")).toBe(true)
    expect(supportsOpenAIReasoning("gpt-5-mini")).toBe(true)
    expect(supportsOpenAIReasoning("gpt-4.1")).toBe(false)
    expect(supportsOpenAIReasoning("gpt-4o-mini")).toBe(false)

    expect(openAICompletionControls("gpt-5", 20_000, "high")).toEqual({
      max_completion_tokens: 20_000,
      reasoning_effort: "high",
    })
    expect(openAICompletionControls("gpt-4o", 8_000, "high")).toEqual({
      max_tokens: 8_000,
    })
  })
})
