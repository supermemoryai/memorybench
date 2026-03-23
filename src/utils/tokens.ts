import { Tiktoken } from "js-tiktoken"
import cl100k_base from "js-tiktoken/ranks/cl100k_base"
import o200k_base from "js-tiktoken/ranks/o200k_base"
import { countTokens as countAnthropicTokens } from "@anthropic-ai/tokenizer"
import type { ModelConfig } from "./models"

export function countTokens(text: string, modelConfig: ModelConfig): number {
  const provider = modelConfig.provider

  if (provider === "openai") {
    return countOpenAITokens(text, modelConfig.id)
  } else if (provider === "anthropic") {
    return countAnthropicTokens(text)
  } else if (provider === "google") {
    // Approximation: Google doesn't provide a client-side tokenizer.
    // char/4 tends to undercount for JSON-heavy content (lots of short tokens
    // like {, ", :) but is reasonable for natural language.
    return Math.ceil(text.length / 4)
  }

  return Math.ceil(text.length / 4)
}

// Cached encoder instances (lazy singletons) to avoid re-instantiation per call
let _o200k: Tiktoken | null = null
let _cl100k: Tiktoken | null = null

function getEncoder(modelId: string): Tiktoken {
  // o200k_base: GPT-4o, GPT-4.1, GPT-5, and reasoning models (o1, o3, o4)
  if (
    modelId.includes("gpt-4o") ||
    modelId.includes("gpt-4.1") ||
    modelId.includes("gpt-5") ||
    modelId.startsWith("o1") ||
    modelId.startsWith("o3") ||
    modelId.startsWith("o4")
  ) {
    return (_o200k ??= new Tiktoken(o200k_base))
  }
  return (_cl100k ??= new Tiktoken(cl100k_base))
}

function countOpenAITokens(text: string, modelId: string): number {
  try {
    const encoding = getEncoder(modelId)
    const tokens = encoding.encode(text)
    return tokens.length
  } catch (error) {
    return Math.ceil(text.length / 4)
  }
}
