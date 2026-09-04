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

  // --- Open-weight candidates routed through OpenRouter (OPENAI_BASE_URL) ---
  // These are reasoning models: they emit reasoning tokens before content, and
  // the 1000-token default fallback is spent thinking, so `content` comes back
  // null and the answer phase counts a failure that aborts the whole run.
  // Verified directly: qwen3.8-27b at max_tokens=12 returns finish_reason
  // "length" with content null; at 1200 it returns "stop" and a real answer.
  // Temperature is rejected by this family, hence supportsTemperature: false.
  "deepseek/deepseek-v4-flash-0731": {
    id: "deepseek/deepseek-v4-flash-0731",
    provider: "openai",
    displayName: "DeepSeek V4 Flash",
    supportsTemperature: false,
    defaultTemperature: 1,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 4000,
  },
  "z-ai/glm-5.3-flash": {
    id: "z-ai/glm-5.3-flash",
    provider: "openai",
    displayName: "GLM 5.3 Flash",
    supportsTemperature: false,
    defaultTemperature: 1,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 4000,
  },
  "z-ai/glm-4.7-flash": {
    id: "z-ai/glm-4.7-flash",
    provider: "openai",
    displayName: "GLM 4.7 Flash",
    supportsTemperature: false,
    defaultTemperature: 1,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 4000,
  },
  "qwen/qwen3.8-flash": {
    id: "qwen/qwen3.8-flash",
    provider: "openai",
    displayName: "Qwen3.8 Flash",
    supportsTemperature: false,
    defaultTemperature: 1,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 4000,
  },
  "qwen/qwen3.8-27b": {
    id: "qwen/qwen3.8-27b",
    provider: "openai",
    displayName: "Qwen3.8 27B",
    supportsTemperature: false,
    defaultTemperature: 1,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 4000,
  },
  "openai/gpt-oss-120b": {
    id: "openai/gpt-oss-120b",
    provider: "openai",
    displayName: "GPT-OSS 120B",
    supportsTemperature: false,
    defaultTemperature: 1,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 4000,
  },
  "z-ai/glm-5.2": {
    id: "z-ai/glm-5.2",
    provider: "openai",
    displayName: "GLM 5.2",
    supportsTemperature: false,
    defaultTemperature: 1,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 4000,
  },
  "z-ai/glm-5.3": {
    id: "z-ai/glm-5.3",
    provider: "openai",
    displayName: "GLM 5.3",
    supportsTemperature: false,
    defaultTemperature: 1,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 4000,
  },
  "moonshotai/kimi-k3": {
    id: "moonshotai/kimi-k3",
    provider: "openai",
    displayName: "Kimi K3",
    supportsTemperature: false,
    defaultTemperature: 1,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 4000,
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

  // Fallback for unknown models - try to infer from prefix
  if (
    alias.startsWith("gpt-5") ||
    alias.startsWith("o1") ||
    alias.startsWith("o3") ||
    alias.startsWith("o4")
  ) {
    return {
      id: alias,
      provider: "openai",
      displayName: alias,
      supportsTemperature: false,
      defaultTemperature: 1,
      maxTokensParam: "max_completion_tokens",
      defaultMaxTokens: 1000,
    }
  }
  if (alias.startsWith("gpt-")) {
    return {
      id: alias,
      provider: "openai",
      displayName: alias,
      supportsTemperature: true,
      defaultTemperature: 0,
      maxTokensParam: "maxTokens",
      defaultMaxTokens: 1000,
    }
  }
  if (alias.startsWith("claude-")) {
    return {
      id: alias,
      provider: "anthropic",
      displayName: alias,
      supportsTemperature: true,
      defaultTemperature: 0,
      maxTokensParam: "maxTokens",
      defaultMaxTokens: 1000,
    }
  }
  if (alias.startsWith("gemini-3")) {
    return {
      id: alias,
      provider: "google",
      displayName: alias,
      supportsTemperature: true,
      defaultTemperature: 1,
      maxTokensParam: "maxTokens",
      defaultMaxTokens: 1000,
    }
  }
  if (alias.startsWith("gemini-")) {
    return {
      id: alias,
      provider: "google",
      displayName: alias,
      supportsTemperature: true,
      defaultTemperature: 0,
      maxTokensParam: "maxTokens",
      defaultMaxTokens: 1000,
    }
  }

  // Default fallback
  return {
    id: alias,
    provider: "openai",
    displayName: alias,
    supportsTemperature: true,
    defaultTemperature: 0,
    maxTokensParam: "maxTokens",
    defaultMaxTokens: 1000,
  }
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
