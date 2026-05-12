export interface Config {
  supermemoryApiKey: string
  supermemoryBaseUrl: string
  mem0ApiKey: string
  zepApiKey: string
  openaiApiKey: string
  anthropicApiKey: string
  googleApiKey: string
  sandraUrl: string
  sandraToken: string
}

export const config: Config = {
  supermemoryApiKey: process.env.SUPERMEMORY_API_KEY || "",
  supermemoryBaseUrl: process.env.SUPERMEMORY_BASE_URL || "https://api.supermemory.ai",
  mem0ApiKey: process.env.MEM0_API_KEY || "",
  zepApiKey: process.env.ZEP_API_KEY || "",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  googleApiKey: process.env.GOOGLE_API_KEY || "",
  sandraUrl: process.env.SANDRA_URL || "http://localhost:8090/mcp",
  sandraToken: process.env.SANDRA_TOKEN || "",
}

export function getProviderConfig(provider: string): {
  apiKey: string
  baseUrl?: string
  token?: string
} {
  switch (provider) {
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
    case "sandra":
      // Sandra's API key slot carries ANTHROPIC_API_KEY (used by the
      // ingestion extractor). baseUrl + token address the MCP HTTP server.
      return {
        apiKey: config.anthropicApiKey,
        baseUrl: config.sandraUrl,
        token: config.sandraToken,
      }
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
