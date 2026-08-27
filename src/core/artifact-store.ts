import { access, copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { existsSync, lstatSync, mkdirSync } from "node:fs"
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import type { AssetRef } from "../types/migration"
import { canonicalJson, sha256, sha256File } from "./canonical"

export interface StoredArtifact {
  relativePath: string
  sha256: string
  byteLength: number
}

function assertRelativePath(path: string): void {
  if (!path || isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) {
    throw new Error(`Artifact path must stay inside the artifact root: ${path}`)
  }
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()
  return (
    normalized === "authorization" ||
    normalized === "token" ||
    normalized === "secret" ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("accesstoken") ||
    normalized.endsWith("refreshtoken") ||
    normalized.endsWith("clientsecret")
  )
}

function redactSecrets(value: unknown, knownSecrets: string[]): unknown {
  if (typeof value === "string") {
    let output = value
    for (const secret of knownSecrets) {
      if (secret.length >= 8) output = output.split(secret).join("[REDACTED]")
    }
    output = output.replace(/\b(?:sk|sm)_[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]")
    return output
  }
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, knownSecrets))
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        isSensitiveKey(key) ? "[REDACTED]" : redactSecrets(item, knownSecrets),
      ])
    )
  }
  return value
}

export class ArtifactStore {
  readonly root: string
  private readonly knownSecrets: string[]

  constructor(root: string, secretEnvironmentNames: string[] = []) {
    this.root = resolve(root)
    mkdirSync(this.root, { recursive: true })
    this.knownSecrets = secretEnvironmentNames
      .map((name) => process.env[name])
      .filter((value): value is string => Boolean(value))
  }

  resolve(relativePath: string): string {
    assertRelativePath(relativePath)
    const absolutePath = resolve(this.root, relativePath)
    const fromRoot = relative(this.root, absolutePath)
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error(`Artifact path escapes root: ${relativePath}`)
    }
    let current = this.root
    for (const component of fromRoot.split(sep).filter(Boolean)) {
      current = join(current, component)
      if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
        throw new Error(`Artifact path contains a symlink: ${relativePath}`)
      }
    }
    return absolutePath
  }

  async writeJson(relativePath: string, value: unknown): Promise<StoredArtifact> {
    const safeValue = redactSecrets(value, this.knownSecrets)
    const bytes = Buffer.from(`${JSON.stringify(safeValue, null, 2)}\n`, "utf8")
    return this.writeImmutable(relativePath, bytes)
  }

  async writeCanonicalJson(relativePath: string, value: unknown): Promise<StoredArtifact> {
    const safeValue = redactSecrets(value, this.knownSecrets)
    return this.writeImmutable(relativePath, Buffer.from(canonicalJson(safeValue), "utf8"))
  }

  async writeImmutable(relativePath: string, bytes: Uint8Array): Promise<StoredArtifact> {
    const absolutePath = this.resolve(relativePath)
    const expectedHash = sha256(bytes)
    await mkdir(dirname(absolutePath), { recursive: true })
    try {
      await access(absolutePath)
      const existingHash = await sha256File(absolutePath)
      if (existingHash !== expectedHash) {
        throw new Error(`Immutable artifact collision at ${relativePath}`)
      }
      const existingStat = await stat(absolutePath)
      return { relativePath, sha256: existingHash, byteLength: existingStat.size }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Immutable artifact collision")) {
        throw error
      }
    }
    const temporaryPath = `${absolutePath}.tmp-${process.pid}-${crypto.randomUUID()}`
    await writeFile(temporaryPath, bytes, { mode: 0o600 })
    await rename(temporaryPath, absolutePath)
    return { relativePath, sha256: expectedHash, byteLength: bytes.byteLength }
  }

  async materializeAsset(asset: AssetRef): Promise<AssetRef> {
    if (!asset.absolutePath) throw new Error(`Asset ${asset.assetId} is not resolved`)
    const actualHash = await sha256File(asset.absolutePath)
    if (actualHash !== asset.sha256) {
      throw new Error(`Asset bytes changed for ${asset.relativePath}`)
    }
    const extension = extname(asset.relativePath).toLowerCase()
    const relativePath = `assets/${asset.sha256}${extension}`
    const target = this.resolve(relativePath)
    await mkdir(dirname(target), { recursive: true })
    try {
      await access(target)
      if ((await sha256File(target)) !== asset.sha256) {
        throw new Error(`Content-addressed asset collision for ${asset.sha256}`)
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Content-addressed asset collision")) {
        throw error
      }
      const temporaryPath = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`
      await copyFile(asset.absolutePath, temporaryPath)
      if ((await sha256File(temporaryPath)) !== asset.sha256) {
        throw new Error(`Copied asset hash mismatch for ${asset.relativePath}`)
      }
      await rename(temporaryPath, target)
    }
    const targetStat = await stat(target)
    if (targetStat.size !== asset.byteLength) {
      throw new Error(`Asset size mismatch for ${asset.relativePath}`)
    }
    return {
      ...asset,
      absolutePath: target,
      relativePath,
    }
  }

  async readJson<T>(relativePath: string): Promise<T> {
    return JSON.parse(await readFile(this.resolve(relativePath), "utf8")) as T
  }

  async describe(relativePath: string): Promise<StoredArtifact> {
    const absolutePath = this.resolve(relativePath)
    const fileStat = await stat(absolutePath)
    return {
      relativePath,
      sha256: await sha256File(absolutePath),
      byteLength: fileStat.size,
    }
  }
}
