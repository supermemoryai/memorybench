export interface AnsweringRuntimeIdentity {
  schemaVersion: 1
  transport: "ai-sdk-generate-text-v1"
  modelAlias: string
  provider: "openai" | "anthropic" | "google"
  modelId: string
  supportsTemperature: boolean
  effectiveDefaultTemperature: number | null
  effectiveDefaultMaxOutputTokens: number
}
