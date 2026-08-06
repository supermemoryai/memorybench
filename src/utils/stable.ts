import { createHash } from "node:crypto"

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item))
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))

    return Object.fromEntries(entries.map(([key, item]) => [key, canonicalize(item)]))
  }

  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("Cannot fingerprint a non-finite number")
  }

  return value
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

export function stableSha256(value: unknown): string {
  return sha256Text(stableStringify(value))
}
