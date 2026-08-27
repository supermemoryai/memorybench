import type { ProviderCapabilities } from "../types/migration"

export type RequiredCapability = keyof ProviderCapabilities

export function requireProviderCapabilities(
  providerName: string,
  available: ProviderCapabilities,
  required: RequiredCapability[]
): void {
  const missing = required.filter((capability) => {
    const value = available[capability]
    return Array.isArray(value) ? value.length === 0 : value !== true
  })
  if (missing.length > 0) {
    throw new Error(
      `Provider ${providerName} cannot run this workflow; missing capabilities: ${missing.join(", ")}`
    )
  }
}
