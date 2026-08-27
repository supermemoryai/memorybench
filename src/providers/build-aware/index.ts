import { getProviderConfig } from "../../utils/config"
import type { BuildProvider, ProviderName } from "../../types/provider"
import { AdvancedSupermemoryProvider } from "../supermemory/advanced"
import { FilesystemProvider } from "../filesystem"
import { RAGProvider } from "../rag"
import { LegacyBuildProviderAdapter } from "./legacy-adapter"

export const LONGMEMEVAL_V2_BUILD_PROVIDERS = ["supermemory", "filesystem", "rag"] as const
export type LongMemEvalV2BuildProviderName = (typeof LONGMEMEVAL_V2_BUILD_PROVIDERS)[number]

export function isLongMemEvalV2BuildProviderName(
  provider: ProviderName
): provider is LongMemEvalV2BuildProviderName {
  return (LONGMEMEVAL_V2_BUILD_PROVIDERS as readonly string[]).includes(provider)
}

export async function createLongMemEvalV2BuildProvider(input: {
  provider: LongMemEvalV2BuildProviderName
  serviceBaseUrl: string
  maxInFlightRequests: number
  operationTimeoutMs: number
  signal?: AbortSignal
}): Promise<BuildProvider> {
  if (input.provider === "supermemory") {
    const config = getProviderConfig("supermemory")
    if (!config.apiKey) throw new Error("SUPERMEMORY_API_KEY is required for Supermemory")
    return new AdvancedSupermemoryProvider(
      {
        apiKey: config.apiKey,
        baseUrl: input.serviceBaseUrl,
        maxInFlightRequests: input.maxInFlightRequests,
      },
      {
        cleanupTimeoutMs: input.operationTimeoutMs,
        signal: input.signal,
      }
    )
  }

  const provider = input.provider === "filesystem" ? new FilesystemProvider() : new RAGProvider()
  await provider.initialize(getProviderConfig(input.provider))
  return new LegacyBuildProviderAdapter(provider, {
    operationTimeoutMs: input.operationTimeoutMs,
    signal: input.signal,
  })
}

export * from "./legacy-adapter"
