import type { ProviderPrompts } from "../types/prompts"
import { stableSha256 } from "../utils/stable"

function promptValueIdentity(
  value: ProviderPrompts["answerPrompt"] | ProviderPrompts["judgePrompt"]
) {
  if (value === undefined) return null
  if (typeof value === "string") return { kind: "string", value }
  return {
    kind: "function",
    source: Function.prototype.toString.call(value),
  }
}

/**
 * Identifies the provider-selected legacy answer/judge prompt implementation.
 * BEAM never consumes these prompts, but legacy runs must not resume across drift.
 */
export function fingerprintProviderPrompts(prompts?: ProviderPrompts): string {
  return stableSha256({
    schemaVersion: 1,
    answerPrompt: promptValueIdentity(prompts?.answerPrompt),
    judgePrompt: promptValueIdentity(prompts?.judgePrompt),
  })
}
