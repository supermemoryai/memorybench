import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { isAbsolute, posix, resolve } from "node:path"

export const LONGMEMEVAL_V2_REPOSITORY = "xiaowu0162/longmemeval-v2"
export const LONGMEMEVAL_V2_PINNED_REVISION = "f152293e235517d504809563c833d7190b8c713b"
export const LONGMEMEVAL_V2_CHECKSUM_MANIFEST = "checksums.sha256"
export const LONGMEMEVAL_V2_CHECKSUM_MANIFEST_SHA256 =
  "b17a18daa52873f915808502217c3c5fab39d20638544f986401155c9e8d67a6"
export const LONGMEMEVAL_V2_QUESTION_IMAGE_COUNT = 29

export interface PinnedDatasetFile {
  relativePath: string
  sha256: string
  byteLength?: number
}

export interface LongMemEvalV2SnapshotSpec {
  repository: string
  revision: string
  checksumManifest: PinnedDatasetFile
  requiredFiles: Readonly<Record<string, Omit<PinnedDatasetFile, "relativePath">>>
  archives: readonly PinnedDatasetFile[]
  questionImageCount: number
}

export const LONGMEMEVAL_V2_REQUIRED_FILES: Readonly<
  Record<string, Omit<PinnedDatasetFile, "relativePath">>
> = {
  LICENSE: {
    sha256: "d547f7673579465fcecc8f257fcdb410f51c82fd784a10b1587e83036f9c29e1",
    byteLength: 9109,
  },
  "questions.jsonl": {
    sha256: "0a3ae5ebea938c24d7800e1e0b0828e08ae1646f939a53853b2b8cdc08e292b7",
    byteLength: 286186,
  },
  "trajectories.jsonl": {
    sha256: "363cec9a8e87aa8d9101ce4e600aadbf7031d674056ebe4f969e8424abc5f3c6",
    byteLength: 1195604539,
  },
  "haystacks/lme_v2_small.json": {
    sha256: "9b5301defb23a088a5f06e45ff8d5f35e569d78305a66d492046a9fff9b46593",
    byteLength: 822632,
  },
  "haystacks/lme_v2_medium.json": {
    sha256: "4756d5126347f0d18f045bb6c47b08cb3b23e9db24386cc48a9b2879e7969b59",
    byteLength: 4054244,
  },
}

export const LONGMEMEVAL_V2_ARCHIVES: readonly PinnedDatasetFile[] = [
  {
    relativePath: "trajectory_screenshots/web_screenshots.tar.gz",
    sha256: "68699c6842412e09a6f89d3c05c5ae8813275918002b52d82dec43ab24dd01fb",
    byteLength: 2562302847,
  },
  {
    relativePath: "trajectory_screenshots/enterprise_screenshots_base.tar.gz",
    sha256: "5c4a67ae0856aa1ede9b040e7da7c7a2d0b76fdd6344ef87380bcdf9f4b6d7a3",
    byteLength: 3354163660,
  },
]

export const LONGMEMEVAL_V2_SNAPSHOT: LongMemEvalV2SnapshotSpec = {
  repository: LONGMEMEVAL_V2_REPOSITORY,
  revision: LONGMEMEVAL_V2_PINNED_REVISION,
  checksumManifest: {
    relativePath: LONGMEMEVAL_V2_CHECKSUM_MANIFEST,
    sha256: LONGMEMEVAL_V2_CHECKSUM_MANIFEST_SHA256,
    byteLength: 3561,
  },
  requiredFiles: LONGMEMEVAL_V2_REQUIRED_FILES,
  archives: LONGMEMEVAL_V2_ARCHIVES,
  questionImageCount: LONGMEMEVAL_V2_QUESTION_IMAGE_COUNT,
}

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function processIsAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

export async function acquireDatasetOperationLock(input: {
  lockPath: string
  dataRoot: string
  operation: string
}): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(input.lockPath)
      try {
        await writeFile(
          resolve(input.lockPath, "owner.json"),
          `${JSON.stringify({
            pid: process.pid,
            dataRoot: resolve(input.dataRoot),
            operation: input.operation,
            createdAt: new Date().toISOString(),
          })}\n`,
          { encoding: "utf8", mode: 0o600 }
        )
      } catch (error) {
        await rm(input.lockPath, { recursive: true, force: true })
        throw error
      }
      return async () => {
        await rm(input.lockPath, { recursive: true, force: true })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      let owner: { pid?: unknown; dataRoot?: unknown } | undefined
      try {
        owner = JSON.parse(await readFile(resolve(input.lockPath, "owner.json"), "utf8")) as {
          pid?: unknown
          dataRoot?: unknown
        }
      } catch {
        throw new Error(`Dataset operation lock is unreadable: ${input.lockPath}`)
      }
      const pid = owner.pid
      const sameRoot = owner.dataRoot === resolve(input.dataRoot)
      if (
        attempt === 0 &&
        sameRoot &&
        typeof pid === "number" &&
        Number.isInteger(pid) &&
        pid > 0 &&
        !(await processIsAlive(pid))
      ) {
        await rm(input.lockPath, { recursive: true, force: true })
        continue
      }
      throw new Error(`Another ${input.operation} operation holds ${input.lockPath}`)
    }
  }
  throw new Error(`Could not acquire dataset operation lock: ${input.lockPath}`)
}

export function validateDatasetRelativePath(relativePath: string): string {
  requireValue(relativePath.length > 0, "Dataset path must not be empty")
  requireValue(!relativePath.includes("\0"), "Dataset path contains a null byte")
  requireValue(!relativePath.includes("\\"), `Dataset path uses a backslash: ${relativePath}`)
  requireValue(!isAbsolute(relativePath), `Dataset path must be relative: ${relativePath}`)
  requireValue(!/^[A-Za-z]:/.test(relativePath), `Dataset path has a drive prefix: ${relativePath}`)
  const normalized = posix.normalize(relativePath)
  requireValue(
    normalized === relativePath &&
      normalized !== "." &&
      normalized !== ".." &&
      !normalized.startsWith("../"),
    `Unsafe dataset path: ${relativePath}`
  )
  return normalized
}

export function parseChecksumManifest(
  text: string,
  spec: LongMemEvalV2SnapshotSpec = LONGMEMEVAL_V2_SNAPSHOT
): PinnedDatasetFile[] {
  const files: PinnedDatasetFile[] = []
  const seen = new Set<string>()
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    if (!rawLine.trim()) continue
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(rawLine)
    requireValue(match, `Invalid checksum line ${index + 1}`)
    const relativePath = validateDatasetRelativePath(match[2])
    requireValue(!seen.has(relativePath), `Duplicate checksum path: ${relativePath}`)
    seen.add(relativePath)
    files.push({ relativePath, sha256: match[1] })
  }
  requireValue(files.length > 0, "Checksum manifest is empty")

  const byPath = new Map(files.map((file) => [file.relativePath, file]))
  for (const [relativePath, expected] of Object.entries(spec.requiredFiles)) {
    const actual = byPath.get(relativePath)
    requireValue(actual, `Checksum manifest is missing ${relativePath}`)
    requireValue(actual.sha256 === expected.sha256, `Pinned checksum mismatch for ${relativePath}`)
  }
  const questionImages = files.filter((file) =>
    file.relativePath.startsWith("question_screenshots/")
  )
  requireValue(
    questionImages.length === spec.questionImageCount,
    `Expected ${spec.questionImageCount} question images, found ${questionImages.length}`
  )
  return files
}

export function selectRuntimeSnapshotFiles(
  files: PinnedDatasetFile[],
  spec: LongMemEvalV2SnapshotSpec = LONGMEMEVAL_V2_SNAPSHOT
): PinnedDatasetFile[] {
  const requiredPaths = new Set(Object.keys(spec.requiredFiles))
  const selected = files.filter(
    (file) =>
      requiredPaths.has(file.relativePath) || file.relativePath.startsWith("question_screenshots/")
  )
  requireValue(
    selected.length === requiredPaths.size + spec.questionImageCount,
    "Checksum manifest does not contain the complete runtime dataset"
  )
  return selected
}

export async function sha256FileStreaming(path: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer)
  }
  return hash.digest("hex")
}

export interface VerifiedDatasetSnapshot {
  repository: string
  revision: string
  files: Array<Required<PinnedDatasetFile>>
}

export async function verifyDatasetSnapshot(
  dataRoot: string,
  spec: LongMemEvalV2SnapshotSpec = LONGMEMEVAL_V2_SNAPSHOT
): Promise<VerifiedDatasetSnapshot> {
  const root = resolve(dataRoot)
  const checksumPath = resolve(
    root,
    validateDatasetRelativePath(spec.checksumManifest.relativePath)
  )
  const checksumStat = await stat(checksumPath)
  requireValue(checksumStat.isFile(), `Checksum manifest is not a file: ${checksumPath}`)
  if (spec.checksumManifest.byteLength !== undefined) {
    requireValue(
      checksumStat.size === spec.checksumManifest.byteLength,
      `Checksum manifest size mismatch: expected ${spec.checksumManifest.byteLength}, got ${checksumStat.size}`
    )
  }
  requireValue(
    (await sha256FileStreaming(checksumPath)) === spec.checksumManifest.sha256,
    "Checksum manifest does not match the pinned snapshot"
  )

  const manifestFiles = selectRuntimeSnapshotFiles(
    parseChecksumManifest(await readFile(checksumPath, "utf8"), spec),
    spec
  )
  const allFiles = [{ ...spec.checksumManifest }, ...manifestFiles, ...spec.archives]
  const seen = new Set<string>()
  const verified: Array<Required<PinnedDatasetFile>> = []
  for (const expected of allFiles) {
    const relativePath = validateDatasetRelativePath(expected.relativePath)
    if (seen.has(relativePath)) continue
    seen.add(relativePath)
    const absolutePath = resolve(root, relativePath)
    const fileStat = await lstat(absolutePath)
    requireValue(
      fileStat.isFile() && !fileStat.isSymbolicLink(),
      `Snapshot entry must be a regular file: ${relativePath}`
    )
    if (expected.byteLength !== undefined) {
      requireValue(
        fileStat.size === expected.byteLength,
        `Size mismatch for ${relativePath}: expected ${expected.byteLength}, got ${fileStat.size}`
      )
    }
    const actualHash = await sha256FileStreaming(absolutePath)
    requireValue(
      actualHash === expected.sha256,
      `Checksum mismatch for ${relativePath}: expected ${expected.sha256}, got ${actualHash}`
    )
    verified.push({
      relativePath,
      sha256: expected.sha256,
      byteLength: fileStat.size,
    })
  }

  return {
    repository: spec.repository,
    revision: spec.revision,
    files: verified,
  }
}
