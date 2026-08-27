import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { createWriteStream } from "node:fs"
import { lstat, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { finished } from "node:stream/promises"
import {
  LONGMEMEVAL_V2_SNAPSHOT,
  type LongMemEvalV2SnapshotSpec,
  type PinnedDatasetFile,
  acquireDatasetOperationLock,
  parseChecksumManifest,
  selectRuntimeSnapshotFiles,
  sha256FileStreaming,
  validateDatasetRelativePath,
  verifyDatasetSnapshot,
} from "./source"

export const LONGMEMEVAL_V2_COMPLETION_MARKER = ".memorybench-longmemeval-v2-snapshot.json"

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface DownloadLongMemEvalV2Options {
  dataRoot: string
  fetchImplementation?: FetchImplementation
  maxAttempts?: number
}

export interface DownloadLongMemEvalV2Result {
  status: "downloaded" | "already-present"
  dataRoot: string
  repository: string
  revision: string
  files: Array<Required<PinnedDatasetFile>>
}

interface DownloadSnapshotOptions extends DownloadLongMemEvalV2Options {
  spec: LongMemEvalV2SnapshotSpec
}

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function datasetUrl(repository: string, revision: string, relativePath: string): string {
  const encodedRepository = repository.split("/").map(encodeURIComponent).join("/")
  const encodedRevision = encodeURIComponent(revision)
  const encodedPath = validateDatasetRelativePath(relativePath)
    .split("/")
    .map(encodeURIComponent)
    .join("/")
  return `https://huggingface.co/datasets/${encodedRepository}/resolve/${encodedRevision}/${encodedPath}?download=true`
}

async function streamResponseToFile(response: Response, path: string): Promise<void> {
  requireValue(response.body, "Download response has no body")
  const output = createWriteStream(path, {
    flags: "wx",
    mode: 0o600,
  })
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      if (!output.write(chunk)) {
        await once(output, "drain")
      }
    }
    output.end()
    await finished(output)
  } catch (error) {
    output.destroy()
    throw error
  }
}

async function downloadFile(input: {
  dataRoot: string
  file: PinnedDatasetFile
  repository: string
  revision: string
  fetchImplementation: FetchImplementation
  maxAttempts: number
}): Promise<Required<PinnedDatasetFile>> {
  const relativePath = validateDatasetRelativePath(input.file.relativePath)
  const finalPath = resolve(input.dataRoot, relativePath)
  const partialPath = `${finalPath}.download`
  await mkdir(dirname(finalPath), { recursive: true })
  await rm(partialPath, { force: true })

  let lastError: unknown
  for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
    try {
      const response = await input.fetchImplementation(
        datasetUrl(input.repository, input.revision, relativePath),
        { redirect: "follow" }
      )
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`Download failed for ${relativePath}: HTTP ${response.status}`)
      }
      await streamResponseToFile(response, partialPath)
      const fileStat = await stat(partialPath)
      if (input.file.byteLength !== undefined) {
        requireValue(
          fileStat.size === input.file.byteLength,
          `Size mismatch for ${relativePath}: expected ${input.file.byteLength}, got ${fileStat.size}`
        )
      }
      const actualHash = await sha256FileStreaming(partialPath)
      requireValue(
        actualHash === input.file.sha256,
        `Checksum mismatch for ${relativePath}: expected ${input.file.sha256}, got ${actualHash}`
      )
      await rename(partialPath, finalPath)
      return {
        relativePath,
        sha256: input.file.sha256,
        byteLength: fileStat.size,
      }
    } catch (error) {
      lastError = error
      await rm(partialPath, { force: true })
      if (attempt === input.maxAttempts) break
    }
  }
  throw new Error(`Could not download ${relativePath} after ${input.maxAttempts} attempt(s)`, {
    cause: lastError,
  })
}

async function cleanupPartialDirectories(parent: string, prefix: string): Promise<void> {
  const entries = await readdir(parent, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(prefix)) {
      await rm(join(parent, entry.name), { recursive: true, force: true })
    }
  }
}

async function writeCompletionMarker(
  dataRoot: string,
  result: Omit<DownloadLongMemEvalV2Result, "status" | "dataRoot">
): Promise<void> {
  const markerPath = resolve(dataRoot, LONGMEMEVAL_V2_COMPLETION_MARKER)
  const partialPath = `${markerPath}.partial`
  await writeFile(
    partialPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        repository: result.repository,
        revision: result.revision,
        files: result.files,
      },
      null,
      2
    )}\n`,
    { encoding: "utf8", mode: 0o600 }
  )
  await rename(partialPath, markerPath)
}

async function downloadSnapshot(
  options: DownloadSnapshotOptions
): Promise<DownloadLongMemEvalV2Result> {
  const dataRoot = resolve(options.dataRoot)
  const parent = dirname(dataRoot)
  const directoryName = basename(dataRoot)
  requireValue(directoryName !== "." && directoryName !== "", "Invalid data root")
  const maxAttempts = options.maxAttempts ?? 3
  requireValue(
    Number.isInteger(maxAttempts) && maxAttempts >= 1,
    "maxAttempts must be an integer >= 1"
  )
  const fetchImplementation = options.fetchImplementation ?? fetch
  await mkdir(parent, { recursive: true })

  const lockPath = join(parent, `.${directoryName}.memorybench-download.lock`)
  const releaseLock = await acquireDatasetOperationLock({
    lockPath,
    dataRoot,
    operation: "dataset download",
  })
  const partialPrefix = `.${directoryName}.memorybench-partial-`
  let stagingPath: string | undefined
  try {
    await cleanupPartialDirectories(parent, partialPrefix)
    let dataRootExists = false
    try {
      const existing = await lstat(dataRoot)
      dataRootExists = true
      requireValue(existing.isDirectory(), `Data root is not a directory: ${dataRoot}`)
      const verified = await verifyDatasetSnapshot(dataRoot, options.spec)
      await writeCompletionMarker(dataRoot, verified)
      return {
        status: "already-present",
        dataRoot,
        ...verified,
      }
    } catch (error) {
      if (dataRootExists || (error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(
          `Existing data root is not the pinned complete snapshot; refusing to overwrite ${dataRoot}`,
          { cause: error }
        )
      }
    }

    stagingPath = join(parent, `${partialPrefix}${process.pid}-${randomUUID()}`)
    await mkdir(stagingPath, { mode: 0o700 })

    const checksumManifest = await downloadFile({
      dataRoot: stagingPath,
      file: options.spec.checksumManifest,
      repository: options.spec.repository,
      revision: options.spec.revision,
      fetchImplementation,
      maxAttempts,
    })
    const checksumText = await Bun.file(
      resolve(stagingPath, options.spec.checksumManifest.relativePath)
    ).text()
    const manifestFiles = selectRuntimeSnapshotFiles(
      parseChecksumManifest(checksumText, options.spec),
      options.spec
    ).map((file) => ({
      ...file,
      byteLength: options.spec.requiredFiles[file.relativePath]?.byteLength,
    }))
    const downloaded: Array<Required<PinnedDatasetFile>> = [checksumManifest]
    for (const file of [...manifestFiles, ...options.spec.archives]) {
      downloaded.push(
        await downloadFile({
          dataRoot: stagingPath,
          file,
          repository: options.spec.repository,
          revision: options.spec.revision,
          fetchImplementation,
          maxAttempts,
        })
      )
    }

    const verified = {
      repository: options.spec.repository,
      revision: options.spec.revision,
      files: downloaded,
    }
    await writeCompletionMarker(stagingPath, verified)
    await rename(stagingPath, dataRoot)
    stagingPath = undefined
    return {
      status: "downloaded",
      dataRoot,
      ...verified,
    }
  } finally {
    if (stagingPath) {
      await rm(stagingPath, { recursive: true, force: true })
    }
    await releaseLock()
  }
}

export async function downloadLongMemEvalV2Dataset(
  options: DownloadLongMemEvalV2Options
): Promise<DownloadLongMemEvalV2Result> {
  return downloadSnapshot({ ...options, spec: LONGMEMEVAL_V2_SNAPSHOT })
}

/** A fixture seam for checksum/atomicity tests; production must use the pinned wrapper. */
export async function downloadDatasetSnapshotForTesting(
  options: DownloadSnapshotOptions
): Promise<DownloadLongMemEvalV2Result> {
  return downloadSnapshot(options)
}
