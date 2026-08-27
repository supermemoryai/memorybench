import { randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import { cp, lstat, mkdir, readdir, realpath, rename, rm, stat, symlink } from "node:fs/promises"
import { createInterface } from "node:readline"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import {
  LONGMEMEVAL_V2_ARCHIVES,
  type PinnedDatasetFile,
  acquireDatasetOperationLock,
  sha256FileStreaming,
  validateDatasetRelativePath,
} from "./source"

export type ScreenshotPreparationMode = "symlink" | "copy"

export interface ArchiveEntry {
  path: string
  type: "file" | "directory"
}

export interface ArchiveAdapter {
  list(archivePath: string): Promise<ArchiveEntry[]>
  extract(archivePath: string, destination: string): Promise<void>
}

export interface PrepareLongMemEvalV2ScreenshotsOptions {
  dataRoot: string
  mode?: ScreenshotPreparationMode
  archiveAdapter?: ArchiveAdapter
}

export interface PrepareLongMemEvalV2ScreenshotsResult {
  status: "prepared" | "already-prepared"
  dataRoot: string
  screenshotsRoot: string
  sourceDirectories: string[]
  trajectoryDirectories: number
  stateScreenshotsValidated: number
  symlinked: number
  copied: number
}

interface PrepareScreenshotsOptions extends PrepareLongMemEvalV2ScreenshotsOptions {
  archives: readonly PinnedDatasetFile[]
}

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function normalizeArchiveEntryPath(rawPath: string): string | undefined {
  requireValue(rawPath.length > 0, "Archive contains an empty path")
  requireValue(!rawPath.includes("\0"), "Archive path contains a null byte")
  requireValue(!rawPath.includes("\\"), `Archive path uses a backslash: ${rawPath}`)
  requireValue(!isAbsolute(rawPath), `Archive path is absolute: ${rawPath}`)
  let candidate = rawPath
  while (candidate.startsWith("./")) candidate = candidate.slice(2)
  candidate = candidate.replace(/\/+$/, "")
  if (!candidate) return undefined
  return validateDatasetRelativePath(candidate)
}

async function runTar(args: string[]): Promise<string> {
  const processHandle = Bun.spawn({
    cmd: ["tar", ...args],
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(`tar ${args.join(" ")} failed with exit ${exitCode}: ${stderr.trim()}`)
  }
  return stdout
}

export const systemTarArchiveAdapter: ArchiveAdapter = {
  async list(archivePath: string): Promise<ArchiveEntry[]> {
    const [namesOutput, verboseOutput] = await Promise.all([
      runTar(["-tf", archivePath]),
      runTar(["-tvf", archivePath]),
    ])
    const names = namesOutput.split(/\r?\n/).filter(Boolean)
    const verbose = verboseOutput.split(/\r?\n/).filter(Boolean)
    requireValue(names.length === verbose.length, `Archive listing mismatch for ${archivePath}`)
    return names.flatMap((path, index) => {
      const typeCharacter = verbose[index][0]
      requireValue(
        typeCharacter === "-" || typeCharacter === "d",
        `Archive contains unsupported link or special entry: ${path}`
      )
      const normalized = normalizeArchiveEntryPath(path)
      return normalized
        ? [{ path: normalized, type: typeCharacter === "d" ? "directory" : "file" }]
        : []
    })
  },

  async extract(archivePath: string, destination: string): Promise<void> {
    await runTar([
      "--no-same-owner",
      "--no-same-permissions",
      "-xf",
      archivePath,
      "-C",
      destination,
    ])
  },
}

async function validateExtractedTree(root: string): Promise<void> {
  const rootRealPath = await realpath(root)
  const pending = [rootRealPath]
  while (pending.length > 0) {
    const directory = pending.pop()!
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const metadata = await lstat(path)
      requireValue(
        !metadata.isSymbolicLink(),
        `Extracted archive contains a symbolic link: ${path}`
      )
      requireValue(
        metadata.isDirectory() || metadata.isFile(),
        `Extracted archive contains a special file: ${path}`
      )
      const pathReal = await realpath(path)
      const relativePath = relative(rootRealPath, pathReal)
      requireValue(
        relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath),
        `Extracted archive escaped its destination: ${path}`
      )
      if (metadata.isDirectory()) pending.push(path)
    }
  }
}

async function verifyArchive(dataRoot: string, archive: PinnedDatasetFile): Promise<string> {
  const relativePath = validateDatasetRelativePath(archive.relativePath)
  const archivePath = resolve(dataRoot, relativePath)
  const metadata = await lstat(archivePath)
  requireValue(
    metadata.isFile() && !metadata.isSymbolicLink(),
    `Archive is not a regular file: ${relativePath}`
  )
  if (archive.byteLength !== undefined) {
    requireValue(metadata.size === archive.byteLength, `Archive size mismatch for ${relativePath}`)
  }
  requireValue(
    (await sha256FileStreaming(archivePath)) === archive.sha256,
    `Archive checksum mismatch for ${relativePath}`
  )
  return archivePath
}

async function extractArchiveAtomically(input: {
  dataRoot: string
  archive: PinnedDatasetFile
  archiveAdapter: ArchiveAdapter
}): Promise<string> {
  const archivePath = await verifyArchive(input.dataRoot, input.archive)
  const sourceRoot = dirname(archivePath)
  const sourceName = basename(archivePath).replace(/\.tar\.gz$/i, "")
  requireValue(sourceName !== basename(archivePath), `Unsupported archive name ${archivePath}`)
  const destination = resolve(sourceRoot, sourceName)

  let destinationExists = false
  try {
    const existing = await lstat(destination)
    destinationExists = true
    requireValue(existing.isDirectory(), `Archive destination is not a directory: ${destination}`)
    await validateExtractedTree(destination)
    return destination
  } catch (error) {
    if (destinationExists || (error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error
    }
  }

  const entries = await input.archiveAdapter.list(archivePath)
  requireValue(entries.length > 0, `Archive is empty: ${archivePath}`)
  const seen = new Set<string>()
  for (const entry of entries) {
    const path = normalizeArchiveEntryPath(entry.path)
    if (!path) continue
    requireValue(!seen.has(path), `Archive has duplicate entry ${path}`)
    seen.add(path)
    requireValue(
      entry.type === "file" || entry.type === "directory",
      `Archive has unsupported entry ${path}`
    )
  }

  const partial = resolve(
    sourceRoot,
    `.${sourceName}.memorybench-partial-${process.pid}-${randomUUID()}`
  )
  await mkdir(partial, { mode: 0o700 })
  try {
    await input.archiveAdapter.extract(archivePath, partial)
    await validateExtractedTree(partial)
    await rename(partial, destination)
    return destination
  } catch (error) {
    await rm(partial, { recursive: true, force: true })
    throw error
  }
}

async function linkOrCopyDirectory(
  source: string,
  destination: string,
  mode: ScreenshotPreparationMode
): Promise<"symlinked" | "copied"> {
  if (mode === "symlink") {
    try {
      await symlink(relative(dirname(destination), source), destination, "dir")
      return "symlinked"
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!["EPERM", "EACCES", "ENOTSUP", "EINVAL"].includes(code ?? "")) {
        throw error
      }
    }
  }
  await cp(source, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
  })
  return "copied"
}

async function cleanupPreparationPartials(
  dataRoot: string,
  archives: readonly PinnedDatasetFile[]
): Promise<void> {
  for (const entry of await readdir(dataRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith(".screenshots.memorybench-partial-")) {
      await rm(resolve(dataRoot, entry.name), { recursive: true, force: true })
    }
  }
  for (const archive of archives) {
    const archivePath = resolve(dataRoot, validateDatasetRelativePath(archive.relativePath))
    const sourceRoot = dirname(archivePath)
    const sourceName = basename(archivePath).replace(/\.tar\.gz$/i, "")
    const prefix = `.${sourceName}.memorybench-partial-`
    for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(prefix)) {
        await rm(resolve(sourceRoot, entry.name), {
          recursive: true,
          force: true,
        })
      }
    }
  }
}

export async function validatePreparedScreenshotLayout(
  dataRoot: string,
  screenshotsRoot = resolve(dataRoot, "screenshots")
): Promise<number> {
  const root = await realpath(dataRoot)
  const trajectoryPath = resolve(root, "trajectories.jsonl")
  const stream = createReadStream(trajectoryPath, { encoding: "utf8" })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  let count = 0
  let lineNumber = 0
  try {
    for await (const line of lines) {
      lineNumber += 1
      if (!line.trim()) continue
      const trajectory = JSON.parse(line) as Record<string, unknown>
      requireValue(Array.isArray(trajectory.states), `Trajectory line ${lineNumber} has no states`)
      for (const [stateIndex, stateValue] of trajectory.states.entries()) {
        requireValue(
          stateValue && typeof stateValue === "object",
          `Invalid state ${stateIndex} on trajectory line ${lineNumber}`
        )
        const screenshot = (stateValue as Record<string, unknown>).screenshot
        requireValue(
          typeof screenshot === "string" && screenshot.length > 0,
          `Missing screenshot at state ${stateIndex} on trajectory line ${lineNumber}`
        )
        const relativePath = validateDatasetRelativePath(screenshot)
        requireValue(
          relativePath.startsWith("screenshots/"),
          `Trajectory screenshot is outside screenshots/: ${relativePath}`
        )
        const path = resolve(screenshotsRoot, relativePath.slice("screenshots/".length))
        const fileMetadata = await stat(path)
        requireValue(fileMetadata.isFile(), `Screenshot is not a file: ${relativePath}`)
        const resolvedPath = await realpath(path)
        const withinDataset = relative(root, resolvedPath)
        requireValue(
          withinDataset !== ".." &&
            !withinDataset.startsWith(`..${sep}`) &&
            !isAbsolute(withinDataset),
          `Screenshot resolves outside the dataset: ${relativePath}`
        )
        count += 1
      }
    }
  } finally {
    lines.close()
    stream.destroy()
  }
  return count
}

async function prepareScreenshots(
  options: PrepareScreenshotsOptions
): Promise<PrepareLongMemEvalV2ScreenshotsResult> {
  const dataRoot = resolve(options.dataRoot)
  const mode = options.mode ?? "symlink"
  requireValue(mode === "symlink" || mode === "copy", "mode must be symlink or copy")
  const archiveAdapter = options.archiveAdapter ?? systemTarArchiveAdapter
  const rootMetadata = await lstat(dataRoot)
  requireValue(rootMetadata.isDirectory(), `Data root is not a directory: ${dataRoot}`)
  const screenshotsRoot = resolve(dataRoot, "screenshots")

  const lockPath = resolve(dataRoot, ".memorybench-screenshot-preparation.lock")
  const releaseLock = await acquireDatasetOperationLock({
    lockPath,
    dataRoot,
    operation: "screenshot preparation",
  })

  let partialRoot: string | undefined
  try {
    await cleanupPreparationPartials(dataRoot, options.archives)
    const sourceDirectories: string[] = []
    for (const archive of options.archives) {
      sourceDirectories.push(
        await extractArchiveAtomically({
          dataRoot,
          archive,
          archiveAdapter,
        })
      )
    }

    let screenshotsRootExists = false
    try {
      const existing = await lstat(screenshotsRoot)
      screenshotsRootExists = true
      requireValue(
        existing.isDirectory(),
        `Screenshots root is not a directory: ${screenshotsRoot}`
      )
      const stateScreenshotsValidated = await validatePreparedScreenshotLayout(dataRoot)
      return {
        status: "already-prepared",
        dataRoot,
        screenshotsRoot,
        sourceDirectories,
        trajectoryDirectories: (await readdir(screenshotsRoot, { withFileTypes: true })).filter(
          (entry) => entry.isDirectory() || entry.isSymbolicLink()
        ).length,
        stateScreenshotsValidated,
        symlinked: 0,
        copied: 0,
      }
    } catch (error) {
      if (screenshotsRootExists || (error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(
          `Existing screenshots root is incomplete; refusing to overwrite ${screenshotsRoot}`,
          { cause: error }
        )
      }
    }

    partialRoot = resolve(
      dataRoot,
      `.screenshots.memorybench-partial-${process.pid}-${randomUUID()}`
    )
    await mkdir(partialRoot, { mode: 0o700 })
    let symlinked = 0
    let copied = 0
    let trajectoryDirectories = 0
    const seen = new Set<string>()
    for (const sourceDirectory of sourceDirectories) {
      for (const entry of (await readdir(sourceDirectory, { withFileTypes: true })).sort(
        (left, right) => left.name.localeCompare(right.name)
      )) {
        if (!entry.isDirectory()) continue
        requireValue(
          !seen.has(entry.name),
          `Duplicate trajectory screenshot directory: ${entry.name}`
        )
        seen.add(entry.name)
        const source = resolve(sourceDirectory, entry.name)
        const destination = resolve(partialRoot, entry.name)
        const result = await linkOrCopyDirectory(source, destination, mode)
        if (result === "symlinked") symlinked += 1
        else copied += 1
        trajectoryDirectories += 1
      }
    }
    requireValue(trajectoryDirectories > 0, "No trajectory screenshot directories were extracted")
    const stateScreenshotsValidated = await validatePreparedScreenshotLayout(dataRoot, partialRoot)
    await rename(partialRoot, screenshotsRoot)
    partialRoot = undefined
    return {
      status: "prepared",
      dataRoot,
      screenshotsRoot,
      sourceDirectories,
      trajectoryDirectories,
      stateScreenshotsValidated,
      symlinked,
      copied,
    }
  } finally {
    if (partialRoot) {
      await rm(partialRoot, { recursive: true, force: true })
    }
    await releaseLock()
  }
}

export async function prepareLongMemEvalV2Screenshots(
  options: PrepareLongMemEvalV2ScreenshotsOptions
): Promise<PrepareLongMemEvalV2ScreenshotsResult> {
  return prepareScreenshots({ ...options, archives: LONGMEMEVAL_V2_ARCHIVES })
}

/** A fixture seam for archive-safety and atomicity tests. */
export async function prepareLongMemEvalV2ScreenshotsForTesting(
  options: PrepareScreenshotsOptions
): Promise<PrepareLongMemEvalV2ScreenshotsResult> {
  return prepareScreenshots(options)
}
