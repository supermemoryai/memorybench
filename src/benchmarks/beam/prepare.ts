import { createHash, randomUUID } from "node:crypto"
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import {
  BEAM_CONVERTER_IDENTITY,
  BEAM_DATASET_SOURCES,
  assertReviewedBeamPaddedAssistantCounts,
  canonicalizeBeamRows,
  computeCanonicalFileManifest,
  computeDatasetFingerprint,
  computeManifestHash,
  loadPreparedBeamDataset,
  loadPreparedBeamTestFixture,
  serializeBeamJsonl,
  sha256Text,
  stableBeamStringify,
  validatePreparedBeamSnapshotContents,
} from "./dataset"
import type {
  BeamCanonicalFileManifest,
  BeamDatasetManifest,
  BeamScale,
  BeamSourceFileManifest,
} from "./types"
import { BEAM_CANONICAL_SCHEMA_VERSION, BEAM_MANIFEST_SCHEMA_VERSION } from "./types"
import { decodeBeamParquetWithHyparquet, type BeamParquetDecoder } from "./parquet"

export { decodeBeamParquetWithHyparquet } from "./parquet"

export interface PrepareBeamDatasetOptions {
  tiers: BeamScale[]
  outputRoot: string
  fetchImpl?: typeof fetch
  parquetDecoder?: BeamParquetDecoder
  /**
   * Only for deterministic fixtures that inject both transport and decoding.
   * The resulting manifest is permanently marked as an injected test fixture
   * and ordinary scored-run loading rejects it.
   */
  unsafeSkipPublishedHashCheckForTests?: boolean
}

export interface PrepareBeamDatasetResult {
  snapshotPath: string
  manifest: BeamDatasetManifest
  reused: boolean
}

interface DownloadResult extends BeamSourceFileManifest {
  localPath: string
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function normalizeTiers(tiers: BeamScale[]): BeamScale[] {
  const unique = [...new Set(tiers)]
  if (unique.length === 0) throw new Error("BEAM prepare requires at least one tier")
  for (const tier of unique) {
    if (tier !== "1M" && tier !== "10M") throw new Error(`Unsupported BEAM tier: ${tier}`)
  }
  return unique.sort((left, right) => (left === right ? 0 : left === "1M" ? -1 : 1))
}

function sanitizeSourceName(sourcePath: string): string {
  const name = sourcePath.split("/").pop() || "source.parquet"
  if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
    throw new Error(`BEAM source path has unsafe filename: ${sourcePath}`)
  }
  return name
}

async function downloadPinnedFile(
  fetchImpl: typeof fetch,
  url: string,
  sourcePath: string,
  snapshotPath: string,
  destination: string,
  expectedSha256?: string
): Promise<DownloadResult> {
  const response = await fetchImpl(url, { redirect: "follow" })
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download pinned BEAM source ${sourcePath}: HTTP ${response.status}`)
  }

  await mkdir(dirname(destination), { recursive: true })
  const handle = await open(destination, "wx")
  const hash = createHash("sha256")
  let byteSize = 0
  try {
    const reader = response.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.byteLength === 0) continue
      await handle.write(value)
      hash.update(value)
      byteSize += value.byteLength
    }
  } finally {
    await handle.close()
  }

  if (byteSize < 8) throw new Error(`Downloaded BEAM source ${sourcePath} is empty or truncated`)
  const contentLength = response.headers.get("content-length")
  if (contentLength && Number(contentLength) !== byteSize) {
    throw new Error(
      `Downloaded BEAM source ${sourcePath} size mismatch: expected ${contentLength}, got ${byteSize}`
    )
  }
  const sha256 = hash.digest("hex")
  if (expectedSha256 && sha256 !== expectedSha256) {
    throw new Error(`Downloaded BEAM source ${sourcePath} SHA-256 mismatch`)
  }

  const file = await open(destination, "r")
  try {
    const first = Buffer.alloc(4)
    const last = Buffer.alloc(4)
    await file.read(first, 0, 4, 0)
    await file.read(last, 0, 4, byteSize - 4)
    if (first.toString("ascii") !== "PAR1" || last.toString("ascii") !== "PAR1") {
      throw new Error(`Downloaded BEAM source ${sourcePath} is not a complete Parquet file`)
    }
  } finally {
    await file.close()
  }

  return { path: sourcePath, snapshotPath, url, byteSize, sha256, localPath: destination }
}

async function writeCanonicalFile(
  stagingPath: string,
  relativePath: string,
  content: string,
  rowCount: number
): Promise<BeamCanonicalFileManifest> {
  const absolutePath = join(stagingPath, relativePath)
  await mkdir(dirname(absolutePath), { recursive: true })
  const bytes = Buffer.from(content, "utf8")
  await writeFile(absolutePath, bytes, { flag: "wx" })
  return computeCanonicalFileManifest(relativePath, bytes, rowCount)
}

function manifestWithoutIdentity(input: {
  tiers: BeamScale[]
  sourceIdentity: "reviewed-published" | "injected-test-fixture"
  sourceFiles: Partial<Record<BeamScale, DownloadResult[]>>
  canonicalFiles: BeamCanonicalFileManifest[]
  counts: BeamDatasetManifest["counts"]
  orderedChatIds: BeamDatasetManifest["orderedChatIds"]
  orderedChatIdsDigest: BeamDatasetManifest["orderedChatIdsDigest"]
  orderedQuestionIds: BeamDatasetManifest["orderedQuestionIds"]
  orderedQuestionIdsDigest: BeamDatasetManifest["orderedQuestionIdsDigest"]
}): Omit<BeamDatasetManifest, "datasetFingerprint" | "manifestHash"> {
  return {
    manifestSchemaVersion: BEAM_MANIFEST_SCHEMA_VERSION,
    canonicalSchemaVersion: BEAM_CANONICAL_SCHEMA_VERSION,
    converter: BEAM_CONVERTER_IDENTITY,
    includedTiers: input.tiers,
    sources: input.tiers.map((tier) => {
      const descriptor = BEAM_DATASET_SOURCES[tier]
      return {
        tier,
        sourceIdentity: input.sourceIdentity,
        repository: descriptor.repository,
        split: descriptor.split,
        revision: descriptor.revision,
        files: (input.sourceFiles[tier] ?? [])
          .map(({ localPath: _localPath, ...file }) => file)
          .sort((left, right) => compareStrings(left.path, right.path)),
      }
    }),
    canonicalFiles: [...input.canonicalFiles].sort((left, right) =>
      compareStrings(left.path, right.path)
    ),
    counts: input.counts,
    orderedChatIds: input.orderedChatIds,
    orderedChatIdsDigest: input.orderedChatIdsDigest,
    orderedQuestionIds: input.orderedQuestionIds,
    orderedQuestionIdsDigest: input.orderedQuestionIdsDigest,
  }
}

async function publishSnapshot(
  stagingPath: string,
  outputRoot: string,
  manifest: BeamDatasetManifest,
  allowTestSourceIdentity: boolean
): Promise<{ snapshotPath: string; reused: boolean }> {
  const snapshotPath = join(outputRoot, manifest.datasetFingerprint)
  try {
    await rename(stagingPath, snapshotPath)
    return { snapshotPath, reused: false }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error

    const existing = await (allowTestSourceIdentity
      ? loadPreparedBeamTestFixture({
          snapshotPath,
          tiers: manifest.includedTiers,
          expectedDatasetFingerprint: manifest.datasetFingerprint,
        })
      : loadPreparedBeamDataset({
          snapshotPath,
          tiers: manifest.includedTiers,
          expectedDatasetFingerprint: manifest.datasetFingerprint,
        }))
    if (existing.manifest.manifestHash !== manifest.manifestHash) {
      throw new Error(
        `BEAM snapshot ${manifest.datasetFingerprint} already exists with a different manifest`
      )
    }
    await rm(stagingPath, { recursive: true })
    return { snapshotPath, reused: true }
  }
}

export async function prepareBeamDataset(
  options: PrepareBeamDatasetOptions
): Promise<PrepareBeamDatasetResult> {
  const tiers = normalizeTiers(options.tiers)
  if (
    options.unsafeSkipPublishedHashCheckForTests &&
    (!options.fetchImpl || !options.parquetDecoder)
  ) {
    throw new Error(
      "Skipping BEAM published source hashes requires injected test transport and decoder"
    )
  }
  const outputRoot = resolve(options.outputRoot)
  await mkdir(outputRoot, { recursive: true })
  const stagingPath = join(outputRoot, `.staging-${randomUUID()}`)
  await mkdir(stagingPath, { recursive: false })

  const fetchImpl = options.fetchImpl ?? fetch
  const decodeParquet = options.parquetDecoder ?? decodeBeamParquetWithHyparquet
  const sourceIdentity = options.unsafeSkipPublishedHashCheckForTests
    ? "injected-test-fixture"
    : "reviewed-published"
  try {
    const sourceFiles: Partial<Record<BeamScale, DownloadResult[]>> = {}
    const canonicalFiles: BeamCanonicalFileManifest[] = []
    const counts: BeamDatasetManifest["counts"] = {}
    const orderedChatIds: BeamDatasetManifest["orderedChatIds"] = {}
    const orderedChatIdsDigest: BeamDatasetManifest["orderedChatIdsDigest"] = {}
    const orderedQuestionIds: BeamDatasetManifest["orderedQuestionIds"] = {}
    const orderedQuestionIdsDigest: BeamDatasetManifest["orderedQuestionIdsDigest"] = {}

    for (const tier of tiers) {
      const descriptor = BEAM_DATASET_SOURCES[tier]
      const tierSourceFiles: DownloadResult[] = []
      const sourceRows: unknown[] = []
      for (let index = 0; index < descriptor.parquetFiles.length; index++) {
        const source = descriptor.parquetFiles[index]
        const sourceName = sanitizeSourceName(source.path)
        const sourceSnapshotPath = `source/${tier}/${index}-${sourceName}`
        const localPath = join(stagingPath, sourceSnapshotPath)
        const downloaded = await downloadPinnedFile(
          fetchImpl,
          source.url,
          source.path,
          sourceSnapshotPath,
          localPath,
          options.unsafeSkipPublishedHashCheckForTests ? undefined : source.expectedSha256
        )
        tierSourceFiles.push(downloaded)
        const decoded = await decodeParquet(localPath, tier)
        if (!Array.isArray(decoded)) {
          throw new Error(`BEAM ${tier} Parquet decoder did not return an array of rows`)
        }
        sourceRows.push(...decoded)
      }
      sourceFiles[tier] = tierSourceFiles

      const canonical = canonicalizeBeamRows(tier, sourceRows)
      if (sourceIdentity === "reviewed-published") {
        assertReviewedBeamPaddedAssistantCounts(tier, canonical.counts)
      }
      const chatsContent = serializeBeamJsonl(canonical.chats)
      const questionsContent = serializeBeamJsonl(canonical.questions)
      canonicalFiles.push(
        await writeCanonicalFile(
          stagingPath,
          `canonical/${tier}/chats.jsonl`,
          chatsContent,
          canonical.chats.length
        ),
        await writeCanonicalFile(
          stagingPath,
          `canonical/${tier}/questions.jsonl`,
          questionsContent,
          canonical.questions.length
        )
      )
      counts[tier] = canonical.counts
      orderedChatIds[tier] = canonical.chats.map((chat) => chat.chatId)
      orderedChatIdsDigest[tier] = sha256Text(orderedChatIds[tier]!.join("\n"))
      orderedQuestionIds[tier] = canonical.questions.map((question) => question.questionId)
      orderedQuestionIdsDigest[tier] = sha256Text(orderedQuestionIds[tier]!.join("\n"))
    }

    const manifestCore = manifestWithoutIdentity({
      tiers,
      sourceIdentity,
      sourceFiles,
      canonicalFiles,
      counts,
      orderedChatIds,
      orderedChatIdsDigest,
      orderedQuestionIds,
      orderedQuestionIdsDigest,
    })
    const datasetFingerprint = computeDatasetFingerprint(manifestCore)
    const manifestWithoutHash: Omit<BeamDatasetManifest, "manifestHash"> = {
      ...manifestCore,
      datasetFingerprint,
    }
    const manifest: BeamDatasetManifest = {
      ...manifestWithoutHash,
      manifestHash: computeManifestHash(manifestWithoutHash),
    }

    await writeFile(join(stagingPath, "manifest.json"), stableBeamStringify(manifest) + "\n", {
      flag: "wx",
    })

    // Validate every source byte, canonical byte, identity, schema, and count
    // before a completion marker can make this staging directory publishable.
    await validatePreparedBeamSnapshotContents({
      snapshotPath: stagingPath,
      tiers,
      expectedDatasetFingerprint: datasetFingerprint,
      allowInjectedTestSourceIdentity: sourceIdentity === "injected-test-fixture",
    })

    await writeFile(
      join(stagingPath, ".complete"),
      stableBeamStringify({
        datasetFingerprint: manifest.datasetFingerprint,
        manifestHash: manifest.manifestHash,
      }) + "\n",
      { flag: "wx" }
    )

    const published = await publishSnapshot(
      stagingPath,
      outputRoot,
      manifest,
      sourceIdentity === "injected-test-fixture"
    )
    return { snapshotPath: published.snapshotPath, manifest, reused: published.reused }
  } catch (error) {
    await rm(stagingPath, { recursive: true }).catch(() => undefined)
    throw error
  }
}

export async function verifyPreparedBeamSnapshot(
  snapshotPath: string,
  tiers: BeamScale[]
): Promise<BeamDatasetManifest> {
  return (await loadPreparedBeamDataset({ snapshotPath, tiers })).manifest
}

export async function sourceFileSha256(filePath: string): Promise<string> {
  const bytes = await readFile(filePath)
  return createHash("sha256").update(bytes).digest("hex")
}
