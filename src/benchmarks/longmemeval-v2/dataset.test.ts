import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, relative, resolve } from "node:path"
import { sha256 } from "../../core/canonical"
import { LongMemEvalV2Dataset } from "./dataset"
import { downloadDatasetSnapshotForTesting, LONGMEMEVAL_V2_COMPLETION_MARKER } from "./download"
import {
  type ArchiveAdapter,
  prepareLongMemEvalV2ScreenshotsForTesting,
  validatePreparedScreenshotLayout,
} from "./prepare"
import {
  LONGMEMEVAL_V2_PINNED_REVISION,
  type LongMemEvalV2SnapshotSpec,
  type PinnedDatasetFile,
  parseChecksumManifest,
  validateDatasetRelativePath,
  verifyDatasetSnapshot,
} from "./source"

const temporaryDirectories: string[] = []
const PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "memorybench-lme2-dataset-"))
  temporaryDirectories.push(path)
  return path
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

function fixtureSnapshot(): {
  spec: LongMemEvalV2SnapshotSpec
  files: Map<string, Uint8Array>
} {
  const payloads = new Map<string, Uint8Array>([
    ["questions.jsonl", Buffer.from('{"id":"q1"}\n')],
    ["trajectories.jsonl", Buffer.from('{"id":"t1"}\n')],
    ["haystacks/lme_v2_small.json", Buffer.from('{"q1":["t1"]}\n')],
    ["haystacks/lme_v2_medium.json", Buffer.from('{"q1":["t1"]}\n')],
    ["question_screenshots/q1.png", PNG_HEADER],
    ["README.md", Buffer.from("fixture\n")],
    ["trajectory_screenshots/web.tar.gz", Buffer.from("web archive")],
    ["trajectory_screenshots/enterprise.tar.gz", Buffer.from("enterprise archive")],
  ])
  const requiredFiles = Object.fromEntries(
    [
      "questions.jsonl",
      "trajectories.jsonl",
      "haystacks/lme_v2_small.json",
      "haystacks/lme_v2_medium.json",
    ].map((relativePath) => {
      const bytes = payloads.get(relativePath)!
      return [relativePath, { sha256: sha256(bytes), byteLength: bytes.byteLength }]
    })
  )
  const manifestPaths = [...Object.keys(requiredFiles), "question_screenshots/q1.png", "README.md"]
  const manifest = `${manifestPaths
    .map((relativePath) => {
      const bytes = payloads.get(relativePath)!
      return `${sha256(bytes)}  ${relativePath}`
    })
    .join("\n")}\n`
  payloads.set("checksums.sha256", Buffer.from(manifest))
  const archives = [
    "trajectory_screenshots/web.tar.gz",
    "trajectory_screenshots/enterprise.tar.gz",
  ].map((relativePath) => {
    const bytes = payloads.get(relativePath)!
    return {
      relativePath,
      sha256: sha256(bytes),
      byteLength: bytes.byteLength,
    }
  })
  return {
    spec: {
      repository: "fixture/longmemeval-v2",
      revision: "fixture-revision",
      checksumManifest: {
        relativePath: "checksums.sha256",
        sha256: sha256(manifest),
        byteLength: Buffer.byteLength(manifest),
      },
      requiredFiles,
      archives,
      questionImageCount: 1,
    },
    files: payloads,
  }
}

function fixtureFetch(
  spec: LongMemEvalV2SnapshotSpec,
  files: Map<string, Uint8Array>,
  overrides: Map<string, Uint8Array> = new Map()
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
    const marker = `/resolve/${encodeURIComponent(spec.revision)}/`
    const markerIndex = url.pathname.indexOf(marker)
    if (markerIndex < 0) return new Response("bad fixture URL", { status: 400 })
    const relativePath = url.pathname
      .slice(markerIndex + marker.length)
      .split("/")
      .map(decodeURIComponent)
      .join("/")
    const bytes = overrides.get(relativePath) ?? files.get(relativePath)
    return bytes
      ? new Response(bytes as unknown as BodyInit, { status: 200 })
      : new Response("missing", { status: 404 })
  }) as typeof fetch
}

async function writeDatasetFixture(dataRoot: string): Promise<void> {
  await mkdir(resolve(dataRoot, "haystacks"), { recursive: true })
  await mkdir(resolve(dataRoot, "screenshots/t1"), { recursive: true })
  await mkdir(resolve(dataRoot, "screenshots/t2"), { recursive: true })
  await mkdir(resolve(dataRoot, "question_screenshots"), { recursive: true })
  await writeFile(resolve(dataRoot, "screenshots/t1/0.png"), PNG_HEADER)
  await writeFile(
    resolve(dataRoot, "screenshots/t2/0.png"),
    Buffer.concat([PNG_HEADER, Buffer.from([2])])
  )
  await writeFile(
    resolve(dataRoot, "question_screenshots/q.png"),
    Buffer.concat([PNG_HEADER, Buffer.from([3])])
  )

  const questions = [
    {
      id: "q1",
      domain: "web",
      environment: "browser",
      question_type: "static-environment",
      question: "Question one?",
      image: "question_screenshots/q.png",
      answer: "one",
      eval_function: "[]",
    },
    {
      id: "q2",
      domain: "web",
      environment: "browser",
      question_type: "static-environment",
      question: "Question two?",
      image: null,
      answer: "two",
      eval_function: "[]",
    },
    {
      id: "q3",
      domain: "web",
      environment: "browser",
      question_type: "procedure",
      question: "Question three?",
      image: null,
      answer: "three",
      eval_function: "[]",
    },
    {
      id: "q4",
      domain: "web",
      environment: "browser",
      question_type: "procedure",
      question: "Question four?",
      image: null,
      answer: "four",
      eval_function: "[]",
    },
  ]
  await writeFile(resolve(dataRoot, "questions.jsonl"), questions.map(jsonLine).join(""))
  const trajectories = [
    {
      id: "t1",
      domain: "web",
      goal: "Goal one",
      start_url: "https://example.test/one",
      outcome: "done",
      states: [
        {
          state_index: 7,
          url: "https://example.test/one",
          action: null,
          thought: null,
          accessibility_tree: "heading 'One'",
          screenshot: "screenshots/t1/0.png",
        },
      ],
    },
    {
      id: "t2",
      domain: "web",
      goal: "Goal two",
      start_url: "https://example.test/two",
      outcome: null,
      states: [
        {
          step: 4,
          url: "https://example.test/two",
          action: "click",
          thought: "inspect",
          accessibility_tree: "heading 'Two'",
          screenshot: "screenshots/t2/0.png",
        },
      ],
    },
  ]
  await writeFile(resolve(dataRoot, "trajectories.jsonl"), trajectories.map(jsonLine).join(""))
  await writeFile(
    resolve(dataRoot, "haystacks/lme_v2_small.json"),
    `${JSON.stringify({
      q1: ["t1"],
      q2: ["t1"],
      q3: ["t2"],
      q4: ["t2"],
    })}\n`
  )
}

describe("LongMemEval-V2 pinned snapshot source", () => {
  test("parses only safe, complete checksum manifests", () => {
    const { spec, files } = fixtureSnapshot()
    const manifest = Buffer.from(files.get("checksums.sha256")!).toString("utf8")
    expect(parseChecksumManifest(manifest, spec).map((file) => file.relativePath)).toEqual([
      "questions.jsonl",
      "trajectories.jsonl",
      "haystacks/lme_v2_small.json",
      "haystacks/lme_v2_medium.json",
      "question_screenshots/q1.png",
      "README.md",
    ])
    expect(() => validateDatasetRelativePath("../escape")).toThrow("Unsafe dataset path")
    expect(() => validateDatasetRelativePath("folder\\escape")).toThrow("backslash")
    expect(() => parseChecksumManifest(`${"0".repeat(64)}  ../escape\n`, spec)).toThrow(
      "Unsafe dataset path"
    )
  })

  test("downloads into an atomic staging directory and safely reuses a verified snapshot", async () => {
    const parent = await temporaryDirectory()
    const dataRoot = resolve(parent, "dataset")
    const stale = resolve(parent, ".dataset.memorybench-partial-stale")
    await mkdir(stale)
    await writeFile(resolve(stale, "partial"), "old")
    const staleLock = resolve(parent, ".dataset.memorybench-download.lock")
    await mkdir(staleLock)
    await writeFile(
      resolve(staleLock, "owner.json"),
      `${JSON.stringify({
        pid: 2147483647,
        dataRoot,
        operation: "dataset download",
      })}\n`
    )
    const { spec, files } = fixtureSnapshot()

    const result = await downloadDatasetSnapshotForTesting({
      dataRoot,
      spec,
      fetchImplementation: fixtureFetch(spec, files),
      maxAttempts: 1,
    })
    expect(result.status).toBe("downloaded")
    expect(await stat(resolve(dataRoot, "questions.jsonl"))).toBeTruthy()
    expect(await stat(resolve(dataRoot, LONGMEMEVAL_V2_COMPLETION_MARKER))).toBeTruthy()
    expect(await verifyDatasetSnapshot(dataRoot, spec)).toEqual({
      repository: spec.repository,
      revision: spec.revision,
      files: result.files,
    })
    expect(
      (await readdir(parent)).some((name) => name.startsWith(".dataset.memorybench-partial-"))
    ).toBe(false)

    const reused = await downloadDatasetSnapshotForTesting({
      dataRoot,
      spec,
      fetchImplementation: (async () => {
        throw new Error("verified reuse must not fetch")
      }) as unknown as typeof fetch,
    })
    expect(reused.status).toBe("already-present")
  })

  test("removes partial work after a checksum failure and never publishes the destination", async () => {
    const parent = await temporaryDirectory()
    const dataRoot = resolve(parent, "dataset")
    const { spec, files } = fixtureSnapshot()
    const corrupt = new Map<string, Uint8Array>([["questions.jsonl", Buffer.from("corrupt")]])

    await expect(
      downloadDatasetSnapshotForTesting({
        dataRoot,
        spec,
        fetchImplementation: fixtureFetch(spec, files, corrupt),
        maxAttempts: 1,
      })
    ).rejects.toThrow("Could not download questions.jsonl")
    await expect(stat(dataRoot)).rejects.toMatchObject({ code: "ENOENT" })
    expect(
      (await readdir(parent)).filter(
        (name) => name.includes("memorybench-partial") || name.includes("memorybench-download.lock")
      )
    ).toEqual([])
  })

  test("refuses to overwrite an existing incomplete destination", async () => {
    const parent = await temporaryDirectory()
    const dataRoot = resolve(parent, "dataset")
    await mkdir(dataRoot)
    await writeFile(resolve(dataRoot, "user-file"), "preserve")
    const { spec, files } = fixtureSnapshot()

    await expect(
      downloadDatasetSnapshotForTesting({
        dataRoot,
        spec,
        fetchImplementation: fixtureFetch(spec, files),
      })
    ).rejects.toThrow("refusing to overwrite")
    expect(await readFile(resolve(dataRoot, "user-file"), "utf8")).toBe("preserve")
  })
})

function screenshotArchivesFixture(): {
  archives: PinnedDatasetFile[]
  archiveAdapter: ArchiveAdapter
} {
  const contents = new Map([
    ["web_screenshots.tar.gz", Buffer.from("web screenshots")],
    ["enterprise_screenshots_base.tar.gz", Buffer.from("enterprise screenshots")],
  ])
  const archives = [...contents].map(([name, bytes]) => ({
    relativePath: `trajectory_screenshots/${name}`,
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
  }))
  const archiveAdapter: ArchiveAdapter = {
    async list(archivePath) {
      return basename(archivePath).startsWith("web_")
        ? [
            { path: "./web-trajectory/", type: "directory" },
            { path: "./web-trajectory/0.png", type: "file" },
          ]
        : [
            { path: "./enterprise-trajectory/", type: "directory" },
            { path: "./enterprise-trajectory/0.png", type: "file" },
          ]
    },
    async extract(archivePath, destination) {
      const trajectory = basename(archivePath).startsWith("web_")
        ? "web-trajectory"
        : "enterprise-trajectory"
      await mkdir(resolve(destination, trajectory), { recursive: true })
      await writeFile(resolve(destination, trajectory, "0.png"), PNG_HEADER)
    },
  }
  return { archives, archiveAdapter }
}

async function writeScreenshotPreparationFixture(
  dataRoot: string,
  archives: PinnedDatasetFile[]
): Promise<void> {
  await mkdir(resolve(dataRoot, "trajectory_screenshots"), { recursive: true })
  const bytesByName: Record<string, Buffer> = {
    "web_screenshots.tar.gz": Buffer.from("web screenshots"),
    "enterprise_screenshots_base.tar.gz": Buffer.from("enterprise screenshots"),
  }
  for (const archive of archives) {
    await writeFile(
      resolve(dataRoot, archive.relativePath),
      bytesByName[basename(archive.relativePath)]
    )
  }
  await writeFile(
    resolve(dataRoot, "trajectories.jsonl"),
    [
      {
        id: "web-trajectory",
        states: [{ screenshot: "screenshots/web-trajectory/0.png" }],
      },
      {
        id: "enterprise-trajectory",
        states: [{ screenshot: "screenshots/enterprise-trajectory/0.png" }],
      },
    ]
      .map(jsonLine)
      .join("")
  )
}

describe("LongMemEval-V2 screenshot preparation", () => {
  test("extracts safely, builds one atomic runtime view, validates it, and reuses it", async () => {
    const dataRoot = await temporaryDirectory()
    const { archives, archiveAdapter } = screenshotArchivesFixture()
    await writeScreenshotPreparationFixture(dataRoot, archives)
    await mkdir(resolve(dataRoot, ".screenshots.memorybench-partial-stale"))
    await mkdir(
      resolve(dataRoot, "trajectory_screenshots/.web_screenshots.memorybench-partial-stale")
    )

    const prepared = await prepareLongMemEvalV2ScreenshotsForTesting({
      dataRoot,
      archives,
      archiveAdapter,
      mode: "symlink",
    })
    expect(prepared.status).toBe("prepared")
    expect(prepared.trajectoryDirectories).toBe(2)
    expect(prepared.stateScreenshotsValidated).toBe(2)
    expect(prepared.symlinked + prepared.copied).toBe(2)
    expect(await validatePreparedScreenshotLayout(dataRoot)).toBe(2)
    expect((await readdir(dataRoot)).some((name) => name.includes("memorybench-partial"))).toBe(
      false
    )

    const reused = await prepareLongMemEvalV2ScreenshotsForTesting({
      dataRoot,
      archives,
      archiveAdapter,
      mode: "symlink",
    })
    expect(reused.status).toBe("already-prepared")
    expect(reused.stateScreenshotsValidated).toBe(2)
  })

  test("rejects archive traversal before extraction and cleans partial state", async () => {
    const dataRoot = await temporaryDirectory()
    const { archives } = screenshotArchivesFixture()
    await writeScreenshotPreparationFixture(dataRoot, archives)
    let extracted = false
    const unsafeAdapter: ArchiveAdapter = {
      async list() {
        return [{ path: "../escape", type: "file" }]
      },
      async extract() {
        extracted = true
      },
    }

    await expect(
      prepareLongMemEvalV2ScreenshotsForTesting({
        dataRoot,
        archives: [archives[0]],
        archiveAdapter: unsafeAdapter,
      })
    ).rejects.toThrow("Unsafe dataset path")
    expect(extracted).toBe(false)
    expect(
      (await readdir(resolve(dataRoot, "trajectory_screenshots"))).some((name) =>
        name.includes("memorybench-partial")
      )
    ).toBe(false)
    expect(
      (await readdir(dataRoot)).some((name) => name.includes("screenshot-preparation.lock"))
    ).toBe(false)
  })

  test("does not overwrite an existing incomplete screenshot view", async () => {
    const dataRoot = await temporaryDirectory()
    const { archives, archiveAdapter } = screenshotArchivesFixture()
    await writeScreenshotPreparationFixture(dataRoot, archives)
    await mkdir(resolve(dataRoot, "screenshots"))
    await writeFile(resolve(dataRoot, "screenshots/user-file"), "preserve")

    await expect(
      prepareLongMemEvalV2ScreenshotsForTesting({
        dataRoot,
        archives,
        archiveAdapter,
      })
    ).rejects.toThrow("refusing to overwrite")
    expect(await readFile(resolve(dataRoot, "screenshots/user-file"), "utf8")).toBe("preserve")
  })
})

describe("LongMemEval-V2 dataset selection and image identity", () => {
  test("requires the pinned revision, groups exact ordered haystacks, and samples deterministically", async () => {
    const dataRoot = await temporaryDirectory()
    await writeDatasetFixture(dataRoot)
    expect(
      () =>
        new LongMemEvalV2Dataset({
          dataRoot,
          tier: "small",
          revision: "moving-main",
        })
    ).toThrow(`must be pinned to ${LONGMEMEVAL_V2_PINNED_REVISION}`)

    const dataset = new LongMemEvalV2Dataset({
      dataRoot,
      tier: "small",
      revision: LONGMEMEVAL_V2_PINNED_REVISION,
    })
    await dataset.load()
    const selectedA = dataset.selectQuestions({
      perCategory: 1,
      seed: "repeatable-seed",
    })
    const selectedB = dataset.selectQuestions({
      perCategory: 1,
      seed: "repeatable-seed",
    })
    expect(selectedA.map((question) => question.id)).toEqual(
      selectedB.map((question) => question.id)
    )
    const planned = dataset.planQuestions(dataset.getQuestions())
    expect(planned.builds).toHaveLength(2)
    expect(planned.builds.map((build) => build.questionIds)).toEqual([
      ["q1", "q2"],
      ["q3", "q4"],
    ])
  })

  test("hashes question/state image bytes and invalidates trajectory content when bytes change", async () => {
    const dataRoot = await temporaryDirectory()
    await writeDatasetFixture(dataRoot)
    const dataset = new LongMemEvalV2Dataset({
      dataRoot,
      tier: "small",
      revision: LONGMEMEVAL_V2_PINNED_REVISION,
    })
    await dataset.load()
    const planned = dataset.planQuestions([dataset.getQuestions()[0]])
    await dataset.resolveQuestionImages(planned.questions)
    expect(planned.questions[0].questionImage?.sha256).toBe(
      sha256(Buffer.concat([PNG_HEADER, Buffer.from([3])]))
    )

    const first = (await dataset.loadTrajectories(["t1"])).get("t1")!
    await writeFile(
      resolve(dataRoot, "screenshots/t1/0.png"),
      Buffer.concat([PNG_HEADER, Buffer.from([9])])
    )
    const second = (await dataset.loadTrajectories(["t1"])).get("t1")!
    expect(second.states[0].screenshot.sha256).not.toBe(first.states[0].screenshot.sha256)
    expect(second.contentHash).not.toBe(first.contentHash)
  })

  test("rejects duplicate haystack members, escaping symlinks, and corrupt image bytes", async () => {
    const parent = await temporaryDirectory()
    const dataRoot = resolve(parent, "dataset")
    await mkdir(dataRoot)
    await writeDatasetFixture(dataRoot)
    await writeFile(
      resolve(dataRoot, "haystacks/lme_v2_small.json"),
      `${JSON.stringify({
        q1: ["t1", "t1"],
        q2: ["t1"],
        q3: ["t2"],
        q4: ["t2"],
      })}\n`
    )
    const duplicated = new LongMemEvalV2Dataset({
      dataRoot,
      tier: "small",
      revision: LONGMEMEVAL_V2_PINNED_REVISION,
    })
    await expect(duplicated.load()).rejects.toThrow("Duplicate trajectory in haystack for q1")

    await writeFile(
      resolve(dataRoot, "haystacks/lme_v2_small.json"),
      `${JSON.stringify({
        q1: ["t1"],
        q2: ["t1"],
        q3: ["t2"],
        q4: ["t2"],
      })}\n`
    )
    const outsideImage = resolve(parent, "outside.png")
    await writeFile(outsideImage, PNG_HEADER)
    await rm(resolve(dataRoot, "question_screenshots/q.png"))
    await symlink(
      relative(resolve(dataRoot, "question_screenshots"), outsideImage),
      resolve(dataRoot, "question_screenshots/q.png")
    )
    const escaping = new LongMemEvalV2Dataset({
      dataRoot,
      tier: "small",
      revision: LONGMEMEVAL_V2_PINNED_REVISION,
    })
    await escaping.load()
    const escapingPlan = escaping.planQuestions([escaping.getQuestions()[0]])
    await expect(escaping.resolveQuestionImages(escapingPlan.questions)).rejects.toThrow(
      "Asset escapes dataset root"
    )

    await rm(resolve(dataRoot, "question_screenshots/q.png"))
    await writeFile(resolve(dataRoot, "question_screenshots/q.png"), "not a png")
    const corrupt = new LongMemEvalV2Dataset({
      dataRoot,
      tier: "small",
      revision: LONGMEMEVAL_V2_PINNED_REVISION,
    })
    await corrupt.load()
    const corruptPlan = corrupt.planQuestions([corrupt.getQuestions()[0]])
    await expect(corrupt.resolveQuestionImages(corruptPlan.questions)).rejects.toThrow(
      "Corrupt or mismatched image/png"
    )
  })
})
