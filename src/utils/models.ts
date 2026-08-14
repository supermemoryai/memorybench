export interface ModelConfig {
  id: string
  provider: "openai" | "anthropic" | "google"
  displayName: string
  supportsTemperature: boolean
  defaultTemperature: number
  maxTokensParam: "maxTokens" | "max_completion_tokens" | "maxOutputTokens"
  defaultMaxTokens: number
}

export const MODEL_CONFIGS: Record<string, ModelConfig> = {
  // OpenAI - Standard models (support temperature)
  "gpt-4o": {
    id: "gpt-4o",
    provider: "openai",
    displayName: "GPT-4o (Legacy)",
    supportsTemperature: true,
    defaultTemperature: 0,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 1000,
  },
  "gpt-4o-mini": {
    id: "gpt-4o-mini",
    provider: "openai",
    displayName: "GPT-4o Mini (Legacy)",
    supportsTemperature: true,
    defaultTemperature: 0,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 1000,
  },
  "gpt-4.1": {
    id: "gpt-4.1",
    provider: "openai",
    displayName: "GPT-4.1",
    supportsTemperature: true,
    defaultTemperature: 0,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 1000,
  },
  "gpt-4.1-mini": {
    id: "gpt-4.1-mini",
    provider: "openai",
    displayName: "GPT-4.1 Mini",
    supportsTemperature: true,
    defaultTemperature: 0,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 1000,
  },
  "gpt-4.1-nano": {
    id: "gpt-4.1-nano",
    provider: "openai",
    displayName: "GPT-4.1 Nano",
    supportsTemperature: true,
    defaultTemperature: 0,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 1000,
  },

  // OpenAI - Reasoning models (NO temperature support)
  "gpt-5": {
    id: "gpt-5",
    provider: "openai",
    displayName: "GPT-5",
    supportsTemperature: false,
    defaultTemperature: 1,
    maxTokensParam: "max_completion_tokens",
    defaultMaxTokens: 1000,
  },
  "gpt-5-mini": {
    id: "gpt-5-mini",
    provider: "openai",
    displayName: "GPT-5 Mini",
    supportsTemperature: false,
    defaultTemperature: 1,
    maxTokensParam: "max_completion_tokens",
    defaultMaxTokens: 1000,
  },
  o1: {
    id: "o1",
    provider: "openai",
    displayName: "o1",
    supportsTemperature: false,
    defaultTemperature: 1,
    maxTokensParam: "max_completion_tokens",
    defaultMaxTokens: 1000,
  },
  "o1-pro": {
    id: "o1-pro",
    provider: "openai",
    displayName: "o1 Pro",
    supportsTemperature: false,
    defaultTemperature: 1,
    maxTokensParam: "max_completion_tokens",
    defaultMaxTokens: 1000,
  },
  o3: {
    id: "o3",
    provider: "openai",
    displayName: "o3",
    supportsTemperature: false,
    defaultTemperature: 1,
    maxTokensParam: "max_completion_tokens",
    defaultMaxTokens: 1000,
  },
  "o3-mini": {
    id: "o3-mini",
    provider: "openai",
    displayName: "o3 Mini",
    supportsTemperature: false,
    defaultTemperature: 1,
    maxTokensParam: "max_completion_tokens",
    defaultMaxTokens: 1000,
  },
  "o3-pro": {
    id: "o3-pro",
    provider: "openai",
    displayName: "o3 Pro",
    supportsTemperature: false,
    defaultTemperature: 1,
    maxTokensParam: "max_completion_tokens",
    defaultMaxTokens: 1000,
  },
  "o4-mini": {
    id: "o4-mini",
    provider: "openai",
    displayName: "o4 Mini",
    supportsTemperature: false,
    defaultTemperature: 1,
    maxTokensParam: "max_completion_tokens",
    defaultMaxTokens: 1000,
  },

  // Anthropic - All Claude models (support temperature)
  "opus-4.5": {
    id: "claude-opus-4-5-20251101",
    provider: "anthropic",
    displayName: "Claude Opus 4.5",
    supportsTemperature: true,
    defaultTemperature: 0,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 1000,
  },
  "sonnet-4.5": {
    id: "claude-sonnet-4-5-20250929",
    provider: "anthropic",
    displayName: "Claude Sonnet 4.5",
    supportsTemperature: true,
    defaultTemperature: 0,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 1000,
  },
  "haiku-4.5": {
    id: "claude-haiku-4-5-20251001",
    provider: "anthropic",
    displayName: "Claude Haiku 4.5",
    supportsTemperature: true,
    defaultTemperature: 0,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 1000,
  },
  "opus-4.1": {
    id: "claude-opus-4-1-20250805",
    provider: "anthropic",
    displayName: "Claude Opus 4.1",
    supportsTemperature: true,
    defaultTemperature: 0,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 1000,
  },
  "sonnet-4": {
    id: "claude-sonnet-4-20250514",
    provider: "anthropic",
    displayName: "Claude Sonnet 4",
    supportsTemperature: true,
    defaultTemperature: 0,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 1000,
  },

  // Google - Gemini 2.x (support temperature)
  "gemini-2.5-pro": {
    id: "gemini-2.5-pro",
    provider: "google",
    displayName: "Gemini 2.5 Pro",
    supportsTemperature: true,
    defaultTemperature: 0,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 1000,
  },
  "gemini-2.5-flash": {
    id: "gemini-2.5-flash",
    provider: "google",
    displayName: "Gemini 2.5 Flash",
    supportsTemperature: true,
    defaultTemperature: 0,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 1000,
  },
  "gemini-2.5-flash-lite": {
    id: "gemini-2.5-flash-lite",
    provider: "google",
    displayName: "Gemini 2.5 Flash Lite",
    supportsTemperature: true,
    defaultTemperature: 0,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 1000,
  },
  "gemini-2.0-flash": {
    id: "gemini-2.0-flash",
    provider: "google",
    displayName: "Gemini 2.0 Flash",
    supportsTemperature: true,
    defaultTemperature: 0,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 1000,
  },

  // Google - Gemini 3 (MUST use temperature=1, lower causes issues)
  "gemini-3-pro-preview": {
    id: "gemini-3-pro-preview",
    provider: "google",
    displayName: "Gemini 3 Pro Preview",
    supportsTemperature: true,
    defaultTemperature: 1,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 1000,
  },
}

export const DEFAULT_ANSWERING_MODEL = "gpt-4o"
export const DEFAULT_JUDGE_MODELS: Record<string, string> = {
  openai: "gpt-4o",
  anthropic: "sonnet-4",
  google: "gemini-2.5-flash",
}

export function getModelConfig(alias: string): ModelConfig {
  const lowerAlias = alias.toLowerCase()

  if (MODEL_CONFIGS[lowerAlias]) {
    return MODEL_CONFIGS[lowerAlias]
  }

  // Fallback for unknown models - try to infer from prefix. Match on lowerAlias
  // throughout: matching the caller's casing here would send `GPT-4.1` past every
  // branch into a guess, and providers reject a mis-cased model id anyway.
  if (
    lowerAlias.startsWith("gpt-5") ||
    lowerAlias.startsWith("o1") ||
    lowerAlias.startsWith("o3") ||
    lowerAlias.startsWith("o4")
  ) {
    return {
      id: lowerAlias,
      provider: "openai",
      displayName: lowerAlias,
      supportsTemperature: false,
      defaultTemperature: 1,
      maxTokensParam: "max_completion_tokens",
      defaultMaxTokens: 1000,
    }
  }
  if (lowerAlias.startsWith("gpt-")) {
    return {
      id: lowerAlias,
      provider: "openai",
      displayName: lowerAlias,
      supportsTemperature: true,
      defaultTemperature: 0,
      maxTokensParam: "maxTokens",
      defaultMaxTokens: 1000,
    }
  }
  if (lowerAlias.startsWith("claude-")) {
    return {
      id: lowerAlias,
      provider: "anthropic",
      displayName: lowerAlias,
      supportsTemperature: true,
      defaultTemperature: 0,
      maxTokensParam: "maxTokens",
      defaultMaxTokens: 1000,
    }
  }
  if (lowerAlias.startsWith("gemini-3")) {
    return {
      id: lowerAlias,
      provider: "google",
      displayName: lowerAlias,
      supportsTemperature: true,
      defaultTemperature: 1,
      maxTokensParam: "maxTokens",
      defaultMaxTokens: 1000,
    }
  }
  if (lowerAlias.startsWith("gemini-")) {
    return {
      id: lowerAlias,
      provider: "google",
      displayName: lowerAlias,
      supportsTemperature: true,
      defaultTemperature: 0,
      maxTokensParam: "maxTokens",
      defaultMaxTokens: 1000,
    }
  }

  // No registry entry and no recognisable provider prefix: the provider genuinely
  // cannot be inferred. Defaulting to OpenAI here used to route a typo'd Anthropic
  // or Google alias to OpenAI under the user's original spelling, surfacing as a
  // 401/404 from the wrong provider deep in the evaluate phase.
  throw new Error(
    `Unknown model "${alias}". It is not a registered alias and does not start with ` +
      `a recognised provider prefix (gpt-, o1/o3/o4, claude-, gemini-), so its ` +
      `provider cannot be determined. Available models: ${listAvailableModels().join(", ")}`
  )
}

// Legacy exports for backward compatibility
export const MODEL_ALIASES = MODEL_CONFIGS

export function resolveModel(alias: string): ModelConfig {
  return getModelConfig(alias)
}

export function getModelId(alias: string): string {
  return getModelConfig(alias).id
}

export function getModelProvider(alias: string): "openai" | "anthropic" | "google" {
  return getModelConfig(alias).provider
}

export function listAvailableModels(): string[] {
  return Object.keys(MODEL_CONFIGS)
}

export function listModelsByProvider(provider: "openai" | "anthropic" | "google"): string[] {
  return Object.entries(MODEL_CONFIGS)
    .filter(([_, config]) => config.provider === provider)
    .map(([alias]) => alias)
}
