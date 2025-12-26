export interface Config {
    supermemoryApiKey: string
    supermemoryBaseUrl: string
    mem0ApiKey: string
    zepApiKey: string
    openaiApiKey: string
    anthropicApiKey: string
    googleApiKey: string
}

export const config: Config = {
    supermemoryApiKey: process.env.SUPERMEMORY_API_KEY || "",
    supermemoryBaseUrl: process.env.SUPERMEMORY_BASE_URL || "https://api.supermemory.ai",
    mem0ApiKey: process.env.MEM0_API_KEY || "",
    zepApiKey: process.env.ZEP_API_KEY || "",
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
    googleApiKey: process.env.GOOGLE_API_KEY || "",
}

export function getProviderConfig(provider: string): { apiKey: string; baseUrl?: string } {
    switch (provider) {
        case "supermemory":
            return { apiKey: config.supermemoryApiKey, baseUrl: config.supermemoryBaseUrl }
        case "mem0":
            return { apiKey: config.mem0ApiKey }
        case "zep":
            return { apiKey: config.zepApiKey }
        case "localbm25":
            return { apiKey: "" }
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
