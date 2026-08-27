import { createReadStream } from "node:fs"
import { access, lstat, open, readFile, realpath, stat } from "node:fs/promises"
import { createInterface } from "node:readline"
import { extname, isAbsolute, relative, resolve, sep } from "node:path"
import type { AssetRef, DatasetFileManifest, DatasetManifest } from "../../types/migration"
import { stableHash } from "../../core/canonical"
import {
  LONGMEMEVAL_V2_QUESTION_IMAGE_COUNT,
  LONGMEMEVAL_V2_PINNED_REVISION,
  LONGMEMEVAL_V2_REQUIRED_FILES,
  sha256FileStreaming,
} from "./source"
import type {
  LongMemEvalV2BuildGroup,
  LongMemEvalV2Domain,
  LongMemEvalV2Question,
  LongMemEvalV2QuestionPlan,
  LongMemEvalV2Tier,
  LongMemEvalV2Trajectory,
  PreparedTrajectory,
} from "./types"

const EXPECTED_QUESTIONS = 451
const EXPECTED_TRAJECTORIES = 1870
const EXPECTED_STATES = 48609
const EXPECTED_ASSETS = EXPECTED_STATES + LONGMEMEVAL_V2_QUESTION_IMAGE_COUNT
const EXPECTED_UNIQUE_BUILDS: Record<LongMemEvalV2Tier, number> = {
  small: 2,
  medium: 447,
}

export interface LongMemEvalV2DatasetValidationProfile {
  expectedCounts: {
    questions: number
    trajectories: number
    states: number
    assets: number
    uniqueBuilds: Readonly<Record<LongMemEvalV2Tier, number>>
  }
  requiredFiles: Readonly<Record<string, { sha256: string; byteLength?: number }>>
}

export const AUDITED_LONGMEMEVAL_V2_DATASET_VALIDATION: LongMemEvalV2DatasetValidationProfile = {
  expectedCounts: {
    questions: EXPECTED_QUESTIONS,
    trajectories: EXPECTED_TRAJECTORIES,
    states: EXPECTED_STATES,
    assets: EXPECTED_ASSETS,
    uniqueBuilds: EXPECTED_UNIQUE_BUILDS,
  },
  requiredFiles: LONGMEMEVAL_V2_REQUIRED_FILES,
}

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
}

async function validateImageSignature(path: string, mimeType: string): Promise<void> {
  const handle = await open(path, "r")
  const header = Buffer.alloc(12)
  let bytesRead = 0
  try {
    ;({ bytesRead } = await handle.read(header, 0, header.length, 0))
  } finally {
    await handle.close()
  }
  const bytes = header.subarray(0, bytesRead)
  const valid =
    (mimeType === "image/png" &&
      bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
    (mimeType === "image/jpeg" &&
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff) ||
    (mimeType === "image/webp" &&
      bytes.length >= 12 &&
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP") ||
    (mimeType === "image/gif" &&
      bytes.length >= 6 &&
      ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii")))
  requireValue(valid, `Corrupt or mismatched ${mimeType} image: ${path}`)
}

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function validateQuestion(value: unknown, lineNumber: number): LongMemEvalV2Question {
  requireValue(value && typeof value === "object", `Question line ${lineNumber} is not an object`)
  const row = value as Record<string, unknown>
  requireValue(
    typeof row.id === "string" && row.id.length > 0,
    `Invalid question id at line ${lineNumber}`
  )
  requireValue(
    row.domain === "web" || row.domain === "enterprise",
    `Invalid question domain for ${row.id}`
  )
  requireValue(typeof row.environment === "string", `Invalid environment for ${row.id}`)
  requireValue(
    typeof row.question_type === "string" && row.question_type.length > 0,
    `Invalid question type for ${row.id}`
  )
  requireValue(
    typeof row.question === "string" && row.question.trim().length > 0,
    `Invalid question text for ${row.id}`
  )
  requireValue(
    row.image === null || typeof row.image === "string",
    `Invalid question image for ${row.id}`
  )
  requireValue(typeof row.answer === "string", `Invalid answer for ${row.id}`)
  requireValue(
    typeof row.eval_function === "string" && row.eval_function.length > 0,
    `Invalid eval function for ${row.id}`
  )
  return row as unknown as LongMemEvalV2Question
}

function validateTrajectory(value: unknown, lineNumber: number): LongMemEvalV2Trajectory {
  requireValue(value && typeof value === "object", `Trajectory line ${lineNumber} is not an object`)
  const row = value as Record<string, unknown>
  requireValue(
    typeof row.id === "string" && row.id.length > 0,
    `Invalid trajectory id at line ${lineNumber}`
  )
  requireValue(
    row.domain === "web" || row.domain === "enterprise",
    `Invalid trajectory domain for ${row.id}`
  )
  requireValue(typeof row.goal === "string", `Invalid goal for ${row.id}`)
  requireValue(
    typeof row.start_url === "string" && row.start_url.length > 0,
    `Invalid start_url for ${row.id}`
  )
  requireValue(
    row.outcome === null || typeof row.outcome === "string",
    `Invalid outcome for ${row.id}`
  )
  requireValue(Array.isArray(row.states) && row.states.length > 0, `Invalid states for ${row.id}`)
  return row as unknown as LongMemEvalV2Trajectory
}

function parseJsonLines<T>(text: string, validator: (value: unknown, line: number) => T): T[] {
  const output: T[] = []
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    output.push(validator(JSON.parse(line), index + 1))
  }
  return output
}

function seededRandom(seed: string): () => number {
  let state = Number.parseInt(stableHash(seed).slice(0, 8), 16) >>> 0
  return () => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

export interface LongMemEvalV2DatasetOptions {
  dataRoot: string
  tier: LongMemEvalV2Tier
  revision: string
  /**
   * Explicit validation profile for deterministic fixtures. Production callers
   * omit this and remain pinned to the complete audited snapshot.
   */
  validationProfile?: LongMemEvalV2DatasetValidationProfile
}

export class LongMemEvalV2Dataset {
  readonly dataRoot: string
  readonly tier: LongMemEvalV2Tier
  readonly revision: string
  private questions: LongMemEvalV2Question[] = []
  private questionsById = new Map<string, LongMemEvalV2Question>()
  private haystacks = new Map<string, string[]>()
  private rootRealPath = ""
  private readonly validationProfile: LongMemEvalV2DatasetValidationProfile

  constructor(options: LongMemEvalV2DatasetOptions) {
    requireValue(
      options.revision === LONGMEMEVAL_V2_PINNED_REVISION,
      `LongMemEval-V2 revision must be pinned to ${LONGMEMEVAL_V2_PINNED_REVISION}`
    )
    this.dataRoot = resolve(options.dataRoot)
    this.tier = options.tier
    this.revision = options.revision
    this.validationProfile = options.validationProfile ?? AUDITED_LONGMEMEVAL_V2_DATASET_VALIDATION
  }

  async load(): Promise<void> {
    this.rootRealPath = await realpath(this.dataRoot)
    const questionsPath = resolve(this.dataRoot, "questions.jsonl")
    const haystackPath = resolve(this.dataRoot, "haystacks", `lme_v2_${this.tier}.json`)
    await Promise.all([
      access(questionsPath),
      access(haystackPath),
      access(resolve(this.dataRoot, "trajectories.jsonl")),
    ])

    this.questions = parseJsonLines(await readFile(questionsPath, "utf8"), validateQuestion)
    this.questionsById = new Map()
    for (const question of this.questions) {
      requireValue(!this.questionsById.has(question.id), `Duplicate question id ${question.id}`)
      this.questionsById.set(question.id, question)
    }
    const rawHaystacks = JSON.parse(await readFile(haystackPath, "utf8")) as unknown
    requireValue(
      rawHaystacks && typeof rawHaystacks === "object" && !Array.isArray(rawHaystacks),
      "Haystack file must be an object"
    )
    this.haystacks = new Map()
    for (const [questionId, value] of Object.entries(rawHaystacks as Record<string, unknown>)) {
      requireValue(
        this.questionsById.has(questionId),
        `Haystack contains unknown question ${questionId}`
      )
      requireValue(
        Array.isArray(value) && value.every((id) => typeof id === "string" && id.length > 0),
        `Invalid haystack for ${questionId}`
      )
      const ids = value as string[]
      requireValue(
        new Set(ids).size === ids.length,
        `Duplicate trajectory in haystack for ${questionId}`
      )
      this.haystacks.set(questionId, [...ids])
    }
    for (const question of this.questions) {
      requireValue(this.haystacks.has(question.id), `Missing haystack for question ${question.id}`)
    }
  }

  getQuestions(domain?: LongMemEvalV2Domain): LongMemEvalV2Question[] {
    return this.questions.filter((question) => !domain || question.domain === domain)
  }

  selectQuestions(
    options: {
      domain?: LongMemEvalV2Domain
      ids?: string[]
      limit?: number
      perCategory?: number
      seed?: string
    } = {}
  ): LongMemEvalV2Question[] {
    let selected = this.getQuestions(options.domain)
    if (options.ids) {
      const requested = new Set(options.ids)
      selected = selected.filter((question) => requested.has(question.id))
      const found = new Set(selected.map((question) => question.id))
      const missing = [...requested].filter((id) => !found.has(id))
      requireValue(missing.length === 0, `Unknown question ids: ${missing.join(", ")}`)
    }
    if (options.perCategory !== undefined) {
      requireValue(
        Number.isInteger(options.perCategory) && options.perCategory > 0,
        "perCategory must be a positive integer"
      )
      const groups = new Map<string, LongMemEvalV2Question[]>()
      for (const question of selected) {
        const group = groups.get(question.question_type) ?? []
        group.push(question)
        groups.set(question.question_type, group)
      }
      selected = []
      const random = seededRandom(options.seed ?? "memorybench-longmemeval-v2")
      for (const category of [...groups.keys()].sort()) {
        const group = [...groups.get(category)!]
        if (options.seed !== undefined) {
          for (let index = group.length - 1; index > 0; index -= 1) {
            const swap = Math.floor(random() * (index + 1))
            ;[group[index], group[swap]] = [group[swap], group[index]]
          }
        }
        selected.push(...group.slice(0, options.perCategory))
      }
      const originalOrder = new Map(this.questions.map((question, index) => [question.id, index]))
      selected.sort((left, right) => originalOrder.get(left.id)! - originalOrder.get(right.id)!)
    }
    if (options.limit !== undefined) {
      requireValue(
        Number.isInteger(options.limit) && options.limit > 0,
        "limit must be a positive integer"
      )
      selected = selected.slice(0, options.limit)
    }
    requireValue(selected.length > 0, "No LongMemEval-V2 questions selected")
    return selected
  }

  planQuestions(questions: LongMemEvalV2Question[]): {
    questions: LongMemEvalV2QuestionPlan[]
    builds: LongMemEvalV2BuildGroup[]
  } {
    const buildMap = new Map<string, LongMemEvalV2BuildGroup>()
    const questionPlans = questions.map((question) => {
      const orderedTrajectoryIds = this.haystacks.get(question.id)
      requireValue(orderedTrajectoryIds, `Missing haystack for ${question.id}`)
      const haystackHash = stableHash(orderedTrajectoryIds)
      const buildKey = `${this.tier}:${question.domain}:${haystackHash}`
      const existing = buildMap.get(buildKey)
      if (existing) {
        existing.questionIds.push(question.id)
      } else {
        buildMap.set(buildKey, {
          buildKey,
          domain: question.domain,
          tier: this.tier,
          orderedTrajectoryIds: [...orderedTrajectoryIds],
          questionIds: [question.id],
        })
      }
      return { question, orderedTrajectoryIds: [...orderedTrajectoryIds], haystackHash, buildKey }
    })
    return { questions: questionPlans, builds: [...buildMap.values()] }
  }

  async resolveQuestionImages(plans: LongMemEvalV2QuestionPlan[]): Promise<void> {
    for (const plan of plans) {
      if (plan.question.image) {
        plan.questionImage = await this.resolveAsset(plan.question.image, "question-image")
      }
    }
  }

  async resolveAssetReference(pathValue: string, kind: AssetRef["kind"]): Promise<AssetRef> {
    return this.resolveAsset(pathValue, kind)
  }

  async loadTrajectories(ids: string[]): Promise<Map<string, PreparedTrajectory>> {
    const requested = new Set(ids)
    requireValue(requested.size === ids.length, "Requested trajectory ids contain duplicates")
    const found = new Map<string, PreparedTrajectory>()
    const stream = createReadStream(resolve(this.dataRoot, "trajectories.jsonl"), {
      encoding: "utf8",
    })
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    let lineNumber = 0
    try {
      for await (const line of lines) {
        lineNumber += 1
        if (!line.trim()) continue
        const idMatch = line.match(/^\s*\{\s*"id"\s*:\s*"([^"]+)"/)
        if (idMatch && !requested.has(idMatch[1])) continue
        const trajectory = validateTrajectory(JSON.parse(line), lineNumber)
        if (!requested.has(trajectory.id)) continue
        requireValue(!found.has(trajectory.id), `Duplicate trajectory id ${trajectory.id}`)
        found.set(trajectory.id, await this.prepareTrajectory(trajectory))
        if (found.size === requested.size) break
      }
    } finally {
      lines.close()
      stream.destroy()
    }
    const missing = ids.filter((id) => !found.has(id))
    requireValue(missing.length === 0, `Unknown trajectories: ${missing.slice(0, 10).join(", ")}`)
    return found
  }

  async validateSnapshot(options: { hashAllAssets?: boolean } = {}): Promise<{
    questions: number
    trajectories: number
    states: number
    assets: number
    uniqueBuilds: number
  }> {
    const expected = this.validationProfile.expectedCounts
    requireValue(
      this.questions.length === expected.questions,
      `Expected ${expected.questions} questions, found ${this.questions.length}`
    )
    let trajectoryCount = 0
    let stateCount = 0
    let assetCount = 0
    const domains = new Map<string, LongMemEvalV2Domain>()
    const seen = new Set<string>()
    const stream = createReadStream(resolve(this.dataRoot, "trajectories.jsonl"), {
      encoding: "utf8",
    })
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    let lineNumber = 0
    for await (const line of lines) {
      lineNumber += 1
      if (!line.trim()) continue
      const trajectory = validateTrajectory(JSON.parse(line), lineNumber)
      requireValue(!seen.has(trajectory.id), `Duplicate trajectory id ${trajectory.id}`)
      seen.add(trajectory.id)
      domains.set(trajectory.id, trajectory.domain)
      trajectoryCount += 1
      stateCount += trajectory.states.length
      for (const state of trajectory.states) {
        requireValue(
          typeof state.screenshot === "string" && state.screenshot.length > 0,
          `Missing screenshot for ${trajectory.id}`
        )
        if (options.hashAllAssets) {
          await this.resolveAsset(state.screenshot, "trajectory-screenshot")
        } else {
          await access(await this.resolveAssetPath(state.screenshot))
        }
        assetCount += 1
      }
    }
    for (const question of this.questions) {
      if (question.image) {
        if (options.hashAllAssets) await this.resolveAsset(question.image, "question-image")
        else await access(await this.resolveAssetPath(question.image))
        assetCount += 1
      }
      for (const trajectoryId of this.haystacks.get(question.id)!) {
        requireValue(seen.has(trajectoryId), `Unknown trajectory ${trajectoryId} in ${question.id}`)
        requireValue(
          domains.get(trajectoryId) === question.domain,
          `Cross-domain trajectory ${trajectoryId} in ${question.id}`
        )
      }
    }
    const uniqueBuilds = new Set(
      this.questions.map((question) => stableHash(this.haystacks.get(question.id)!))
    ).size
    requireValue(
      trajectoryCount === expected.trajectories,
      `Expected ${expected.trajectories} trajectories, found ${trajectoryCount}`
    )
    requireValue(
      stateCount === expected.states,
      `Expected ${expected.states} states, found ${stateCount}`
    )
    requireValue(
      assetCount === expected.assets,
      `Expected ${expected.assets} assets, found ${assetCount}`
    )
    requireValue(
      uniqueBuilds === expected.uniqueBuilds[this.tier],
      `Expected ${expected.uniqueBuilds[this.tier]} ${this.tier} builds, found ${uniqueBuilds}`
    )
    return {
      questions: this.questions.length,
      trajectories: trajectoryCount,
      states: stateCount,
      assets: assetCount,
      uniqueBuilds,
    }
  }

  async createManifest(): Promise<DatasetManifest> {
    const counts = await this.validateSnapshot({ hashAllAssets: false })
    const filePaths = [
      ...("LICENSE" in this.validationProfile.requiredFiles ? ["LICENSE"] : []),
      "questions.jsonl",
      "trajectories.jsonl",
      `haystacks/lme_v2_${this.tier}.json`,
    ]
    const files: DatasetFileManifest[] = []
    for (const relativePath of filePaths) {
      const absolutePath = resolve(this.dataRoot, relativePath)
      const fileStat = await stat(absolutePath)
      const hash = await sha256FileStreaming(absolutePath)
      const expected = this.validationProfile.requiredFiles[relativePath]
      requireValue(expected, `No pinned checksum for ${relativePath}`)
      requireValue(hash === expected.sha256, `Pinned checksum mismatch for ${relativePath}`)
      if (expected.byteLength !== undefined) {
        requireValue(
          fileStat.size === expected.byteLength,
          `Pinned size mismatch for ${relativePath}`
        )
      }
      files.push({
        relativePath,
        sha256: hash,
        byteLength: fileStat.size,
      })
    }
    const trajectoryOrder: string[] = []
    const stream = createReadStream(resolve(this.dataRoot, "trajectories.jsonl"), {
      encoding: "utf8",
    })
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    for await (const line of lines) {
      const match = line.match(/^\s*\{\s*"id"\s*:\s*"([^"]+)"/)
      if (match) trajectoryOrder.push(match[1])
    }
    const payload = {
      schemaVersion: 1,
      benchmark: "longmemeval-v2",
      source: "xiaowu0162/longmemeval-v2",
      revision: this.revision,
      dataRoot: this.dataRoot,
      tier: this.tier,
      files,
      assets: [] as AssetRef[],
      questionOrder: this.questions.map((question) => question.id),
      trajectoryOrder,
      expectedCounts: counts,
    }
    return {
      ...payload,
      fingerprint: stableHash({
        ...payload,
        dataRoot: undefined,
        assets: payload.assets.map((asset) => ({ ...asset, absolutePath: undefined })),
      }),
    }
  }

  private async prepareTrajectory(
    trajectory: LongMemEvalV2Trajectory
  ): Promise<PreparedTrajectory> {
    const states = []
    for (const [index, state] of trajectory.states.entries()) {
      requireValue(
        typeof state.url === "string" && state.url.trim().length > 0,
        `Invalid URL for ${trajectory.id} state ${index}`
      )
      requireValue(
        state.action === null || typeof state.action === "string",
        `Invalid action for ${trajectory.id} state ${index}`
      )
      const thoughts = state.thought ?? state.thoughts ?? null
      requireValue(
        thoughts === null || typeof thoughts === "string",
        `Invalid thought for ${trajectory.id} state ${index}`
      )
      const accessibilityTree = state.accessibility_tree ?? state.text
      requireValue(
        typeof accessibilityTree === "string",
        `Invalid accessibility tree for ${trajectory.id} state ${index}`
      )
      requireValue(
        typeof state.screenshot === "string" && state.screenshot.length > 0,
        `Invalid screenshot for ${trajectory.id} state ${index}`
      )
      states.push({
        stateIndex: index,
        step: Number.isInteger(state.step)
          ? state.step!
          : Number.isInteger(state.state_index)
            ? state.state_index!
            : index,
        url: state.url,
        action: state.action,
        thoughts,
        accessibilityTree,
        screenshot: await this.resolveAsset(state.screenshot, "trajectory-screenshot"),
      })
    }
    const contentHash = stableHash({
      id: trajectory.id,
      domain: trajectory.domain,
      goal: trajectory.goal,
      startUrl: trajectory.start_url,
      outcome: trajectory.outcome,
      states: states.map((state) => ({
        stateIndex: state.stateIndex,
        step: state.step,
        url: state.url,
        action: state.action,
        thoughts: state.thoughts,
        accessibilityTree: state.accessibilityTree,
        screenshotHash: state.screenshot.sha256,
      })),
    })
    return {
      id: trajectory.id,
      domain: trajectory.domain,
      goal: trajectory.goal,
      startUrl: trajectory.start_url,
      outcome: trajectory.outcome,
      states,
      contentHash,
    }
  }

  private async resolveAssetPath(pathValue: string): Promise<string> {
    const candidate = isAbsolute(pathValue) ? pathValue : resolve(this.dataRoot, pathValue)
    const resolvedPath = await realpath(candidate)
    const relativePath = relative(this.rootRealPath, resolvedPath)
    requireValue(
      relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath),
      `Asset escapes dataset root: ${pathValue}`
    )
    const fileStat = await lstat(resolvedPath)
    requireValue(fileStat.isFile(), `Asset is not a regular file: ${pathValue}`)
    return resolvedPath
  }

  private async resolveAsset(pathValue: string, kind: AssetRef["kind"]): Promise<AssetRef> {
    const absolutePath = await this.resolveAssetPath(pathValue)
    const fileStat = await stat(absolutePath)
    const hash = await sha256FileStreaming(absolutePath)
    const extension = extname(absolutePath).toLowerCase()
    const mimeType = MIME_TYPES[extension]
    requireValue(mimeType, `Unsupported image type ${extension || "(none)"} for ${pathValue}`)
    await validateImageSignature(absolutePath, mimeType)
    return {
      assetId: `asset-${hash.slice(0, 24)}`,
      kind,
      absolutePath,
      relativePath: relative(this.rootRealPath, absolutePath),
      mimeType,
      sha256: hash,
      byteLength: fileStat.size,
    }
  }
}
