import { createHash } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

function normalizeForJson(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Cannot canonicalize non-finite number: ${value}`)
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.map(normalizeForJson)
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    const output: Record<string, JsonValue> = {}
    for (const key of Object.keys(record).sort()) {
      const item = record[key]
      if (item !== undefined) output[key] = normalizeForJson(item)
    }
    return output
  }
  throw new TypeError(`Cannot canonicalize ${typeof value}`)
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeForJson(value))
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

export function stableHash(value: unknown): string {
  return sha256(canonicalJson(value))
}

export async function sha256File(path: string): Promise<string> {
  return sha256(await readFile(path))
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
  await rename(temporaryPath, path)
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T
}
