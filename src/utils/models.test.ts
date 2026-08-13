import { test, expect } from "bun:test"
import { MODEL_CONFIGS, getModelConfig } from "./models"

// Reasoning/thinking models are billed for reasoning tokens against the same ceiling as
// visible output, so a tight maxOutputTokens can be consumed before any answer is emitted.
// An empty judge completion would mark questions incorrect, so these need real headroom.
const NEEDS_HEADROOM = /^(gpt-5|o1|o3|o4|gemini-2\.5|gemini-3)/
const HEADROOM_FLOOR = 25000

test("every model config declares a positive output ceiling", () => {
  for (const [alias, config] of Object.entries(MODEL_CONFIGS)) {
    expect(config.defaultMaxTokens, alias).toBeGreaterThan(0)
  }
})

test("reasoning and thinking models get enough headroom to emit a verdict", () => {
  for (const [alias, config] of Object.entries(MODEL_CONFIGS)) {
    if (NEEDS_HEADROOM.test(alias) || !config.supportsTemperature) {
      expect(config.defaultMaxTokens, alias).toBeGreaterThanOrEqual(HEADROOM_FLOOR)
    }
  }
})

test("unknown models fall back to a ceiling that cannot truncate a verdict", () => {
  // We cannot tell whether an unrecognised model reasons, so the fallback must be roomy.
  for (const alias of ["gpt-5.5", "o5-mini", "gpt-4.7", "claude-opus-5", "gemini-4-pro"]) {
    expect(getModelConfig(alias).defaultMaxTokens, alias).toBeGreaterThanOrEqual(HEADROOM_FLOOR)
  }
})

test("non-reasoning models stay capped tightly enough to be worth capping", () => {
  for (const alias of ["gpt-4o", "gpt-4.1-mini", "sonnet-4", "opus-4.5"]) {
    expect(getModelConfig(alias).defaultMaxTokens, alias).toBeLessThanOrEqual(4000)
  }
})
