import { describe, expect, test } from "bun:test"
import { getModelConfig, listAvailableModels, resolveModel } from "./models"

describe("getModelConfig", () => {
  test("returns the registered config for a known alias", () => {
    const config = getModelConfig("gpt-4o")

    expect(config.id).toBe("gpt-4o")
    expect(config.provider).toBe("openai")
  })

  test("matches a registered alias regardless of casing", () => {
    expect(getModelConfig("GPT-4O")).toEqual(getModelConfig("gpt-4o"))
  })

  describe("provider prefix inference", () => {
    test("routes claude- to anthropic", () => {
      const config = getModelConfig("claude-opus-4.5")

      expect(config.provider).toBe("anthropic")
      expect(config.id).toBe("claude-opus-4.5")
    })

    test("routes gemini- to google", () => {
      expect(getModelConfig("gemini-9.9-pro").provider).toBe("google")
    })

    test("routes gpt- to openai", () => {
      expect(getModelConfig("gpt-9-turbo").provider).toBe("openai")
    })

    test("treats o-series and gpt-5 as reasoning models without temperature", () => {
      for (const alias of ["gpt-5-turbo", "o1-preview", "o3-mini", "o4-max"]) {
        expect(getModelConfig(alias).supportsTemperature).toBe(false)
        expect(getModelConfig(alias).maxTokensParam).toBe("max_completion_tokens")
      }
    })

    test("keeps gemini-3 on its own temperature default", () => {
      expect(getModelConfig("gemini-3-pro").defaultTemperature).toBe(1)
      expect(getModelConfig("gemini-2.9-pro").defaultTemperature).toBe(0)
    })

    // Before the fix these matched the caller's casing, so an upper-case alias
    // fell past every prefix branch into the silent OpenAI default.
    test("infers the provider from a prefix regardless of casing", () => {
      expect(getModelConfig("Claude-Sonnet-4-6").provider).toBe("anthropic")
      expect(getModelConfig("Gemini-9.9-Pro").provider).toBe("google")
      expect(getModelConfig("O3-Mini").supportsTemperature).toBe(false)
    })

    test("normalises the resolved model id to lower case", () => {
      // Providers reject a mis-cased model id, so the id we send must be normalised.
      expect(getModelConfig("Claude-Sonnet-4-6").id).toBe("claude-sonnet-4-6")
      expect(getModelConfig("GPT-4.5").id).toBe("gpt-4.5")
    })

    test("does not treat an upper-case reasoning model as temperature-capable", () => {
      expect(getModelConfig("GPT-5-Mini").supportsTemperature).toBe(false)
    })
  })

  describe("unrecognised aliases", () => {
    // Each of these previously became an OpenAI judge using the typo verbatim.
    const TYPOS = ["sonnet-4-5", "opus4.5", "gemini2.5-pro", "haiku", "", "   "]

    for (const alias of TYPOS) {
      test(`rejects ${JSON.stringify(alias)} instead of defaulting to openai`, () => {
        expect(() => getModelConfig(alias)).toThrow(/Unknown model/)
      })
    }

    test("names the offending alias and lists what is available", () => {
      let message = ""
      try {
        getModelConfig("sonnet-4-5")
      } catch (e) {
        message = (e as Error).message
      }

      expect(message).toContain("sonnet-4-5")
      // The correct spelling is a registered alias, so the list points the user at it.
      expect(message).toContain("sonnet-4.5")
      expect(listAvailableModels().length).toBeGreaterThan(0)
    })
  })

  test("resolveModel delegates to getModelConfig", () => {
    expect(resolveModel("gpt-4o")).toEqual(getModelConfig("gpt-4o"))
    expect(() => resolveModel("not-a-model")).toThrow(/Unknown model/)
  })

  test("every registered alias resolves", () => {
    for (const alias of listAvailableModels()) {
      expect(() => getModelConfig(alias)).not.toThrow()
    }
  })
})
