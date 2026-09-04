export interface Config {
  supermemoryApiKey: string
  supermemoryBaseUrl: string
  mem0ApiKey: string
  zepApiKey: string
  openaiApiKey: string
  anthropicApiKey: string
  googleApiKey: string
  aricordBaseUrl: string
  aricordApiToken: string
}

export const config: Config = {
  supermemoryApiKey: process.env.SUPERMEMORY_API_KEY || "",
  supermemoryBaseUrl: process.env.SUPERMEMORY_BASE_URL || "https://api.supermemory.ai",
  mem0ApiKey: process.env.MEM0_API_KEY || "",
  zepApiKey: process.env.ZEP_API_KEY || "",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  googleApiKey: process.env.GOOGLE_API_KEY || "",
  // ARICORD runs locally, so a base URL rather than a hosted API key.
  // AME_* stays readable: bench scripts written before the rename keep working.
  aricordBaseUrl: process.env.ARICORD_BASE_URL || process.env.AME_BASE_URL || "http://localhost:3100",
  aricordApiToken: process.env.ARICORD_API_TOKEN || process.env.AME_API_TOKEN || "",
}

export function getProviderConfig(provider: string): { apiKey: string; baseUrl?: string } {
  switch (provider) {
    case "aricord":
      // `|| "none"` so a token-less local run (ARICORD_AUTH_DISABLED=true)
      // still satisfies callers that require a non-empty apiKey.
      return { apiKey: config.aricordApiToken || "none", baseUrl: config.aricordBaseUrl }
    case "supermemory":
      return { apiKey: config.supermemoryApiKey, baseUrl: config.supermemoryBaseUrl }
    case "mem0":
      return { apiKey: config.mem0ApiKey }
    case "zep":
      return { apiKey: config.zepApiKey }
    case "filesystem":
      return { apiKey: config.openaiApiKey } // Filesystem uses OpenAI for memory extraction
    case "rag":
      return { apiKey: config.openaiApiKey } // RAG provider uses OpenAI for embeddings
    default:
      throw new Error(`Unknown provider: ${provider}`)
  }
}

export function getJudgeConfig(judge: string): { apiKey: string; model?: string } {
  switch (judge) {
    case "openai":
      return { apiKey: config.openaiApiKey }
    case "anthropic":
      return { apiKey: config.anthropicApiKey }
    case "google":
      return { apiKey: config.googleApiKey }
    default:
      throw new Error(`Unknown judge: ${judge}`)
  }
}
