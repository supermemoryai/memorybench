import { createHash } from "node:crypto"
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs"
import { basename, isAbsolute, join, relative, resolve } from "node:path"
import JSON5 from "json5"
import { z } from "zod"
import type {
  BeamBatch,
  BeamCanonicalChat,
  BeamCanonicalFileManifest,
  BeamCanonicalMessage,
  BeamCanonicalQuestion,
  BeamCanonicalSession,
  BeamDatasetManifest,
  BeamDatasetSource,
  BeamMessage,
  BeamQuestionType,
  BeamScale,
  BeamTierCounts,
  PreparedBeamDataset,
} from "./types"
import {
  BEAM_CANONICAL_SCHEMA_VERSION,
  BEAM_CONVERTER_VERSION,
  BEAM_MANIFEST_SCHEMA_VERSION,
  BEAM_QUESTION_TYPE_IDS,
} from "./types"
import { decodeBeamParquetWithHyparquet, type BeamParquetDecoder } from "./parquet"

export const BEAM_DATASET_SOURCES: Record<BeamScale, BeamDatasetSource> = {
  "1M": {
    repository: "Mohammadta/BEAM",
    split: "1M",
    revision: "3205395e897e7318c7b094ef4e6047b9b82dbb03",
    parquetFiles: [
      {
        path: "data/1M-00000-of-00001.parquet",
        url: "https://huggingface.co/datasets/Mohammadta/BEAM/resolve/3205395e897e7318c7b094ef4e6047b9b82dbb03/data/1M-00000-of-00001.parquet",
        expectedSha256: "41b5acbbb55a586b1305514ef9d9fb03365d9b3331b598a1c2dd7603d93ef533",
      },
    ],
  },
  "10M": {
    repository: "Mohammadta/BEAM-10M",
    split: "10M",
    revision: "9b2096193fe74e2837e4713e483351e19817773c",
    parquetFiles: [
      {
        path: "data/10M-00000-of-00002.parquet",
        url: "https://huggingface.co/datasets/Mohammadta/BEAM-10M/resolve/9b2096193fe74e2837e4713e483351e19817773c/data/10M-00000-of-00002.parquet",
        expectedSha256: "31d96fd47ec56221d202e68792f26c00e49467dd4b36ee105c36ebd19ef78ad5",
      },
      {
        path: "data/10M-00001-of-00002.parquet",
        url: "https://huggingface.co/datasets/Mohammadta/BEAM-10M/resolve/9b2096193fe74e2837e4713e483351e19817773c/data/10M-00001-of-00002.parquet",
        expectedSha256: "a4f13fe25af51d57405ae41008689c31d1421377f3efde56a024b441deb2ee65",
      },
    ],
  },
}

export const BEAM_EXPECTED_COUNTS: Record<BeamScale, { chats: number; questions: number }> = {
  "1M": { chats: 35, questions: 700 },
  "10M": { chats: 10, questions: 200 },
}

function hashRunningConverterImplementation(): string {
  const hash = createHash("sha256")
  for (const source of ["./dataset.ts", "./parquet.ts", "./prepare.ts"]) {
    hash.update(source)
    hash.update(readFileSync(new URL(source, import.meta.url)))
  }
  return hash.digest("hex")
}

/** Hashes the exact converter and publication source files executing this run. */
export const BEAM_CONVERTER_IMPLEMENTATION_HASH = hashRunningConverterImplementation()

const QUESTION_TYPE_SET = new Set<string>(BEAM_QUESTION_TYPE_IDS)

const QUESTION_TYPE_ALIASES: Record<string, BeamQuestionType> = {
  abstention: "abstention",
  contradiction_resolution: "contradiction_resolution",
  event_ordering: "event_ordering",
  information_extraction: "information_extraction",
  instruction_following: "instruction_following",
  knowledge_update: "knowledge_update",
  multi_hop_reasoning: "multi_session_reasoning",
  multi_session_reasoning: "multi_session_reasoning",
  preference_following: "preference_following",
  summarization: "summarization",
  temporal_reasoning: "temporal_reasoning",
}

const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
}

export interface CanonicalBeamTier {
  scale: BeamScale
  chats: BeamCanonicalChat[]
  questions: BeamCanonicalQuestion[]
  counts: BeamTierCounts
}

export interface LoadPreparedBeamDatasetOptions {
  snapshotPath: string
  tiers: BeamScale[]
  expectedDatasetFingerprint?: string
}

interface ValidatePreparedBeamSnapshotContentsOptions extends LoadPreparedBeamDatasetOptions {
  allowInjectedTestSourceIdentity: boolean
}

const canonicalMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    timeAnchor: z.string().optional(),
  })
  .strict()

const canonicalSessionSchema = z
  .object({
    sessionId: z.string().min(1),
    planNumber: z.number().int().positive().optional(),
    batchNumber: z.number().int().nonnegative(),
    turnIndex: z.number().int().positive(),
    documentDate: z.string().optional(),
    hadInvalidTimeAnchor: z.boolean().optional(),
    hasPaddedAssistant: z.literal(true).optional(),
    messages: z.array(canonicalMessageSchema).length(2),
  })
  .strict()

const canonicalChatSchema = z
  .object({
    schemaVersion: z.literal(BEAM_CANONICAL_SCHEMA_VERSION),
    scale: z.enum(["1M", "10M"]),
    chatId: z.string().min(1),
    sessions: z.array(canonicalSessionSchema),
  })
  .strict()

const canonicalQuestionSchema = z
  .object({
    schemaVersion: z.literal(BEAM_CANONICAL_SCHEMA_VERSION),
    scale: z.enum(["1M", "10M"]),
    chatId: z.string(),
    questionId: z.string(),
    questionType: z.enum(BEAM_QUESTION_TYPE_IDS),
    question: z.string(),
    rubric: z.array(z.string()),
    difficulty: z.string().optional(),
    referenceAnswer: z.string().optional(),
  })
  .strict()

const sourceFileSchema = z
  .object({
    path: z.string(),
    snapshotPath: z.string(),
    url: z.string(),
    byteSize: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()

const canonicalFileSchema = z
  .object({
    path: z.string(),
    byteSize: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    rowCount: z.number().int().nonnegative(),
  })
  .strict()

const tierCountsSchema = z
  .object({
    chats: z.number().int().nonnegative(),
    questions: z.number().int().nonnegative(),
    sessions: z.number().int().nonnegative(),
    sessionsWithDocumentDate: z.number().int().nonnegative(),
    sessionsWithoutDocumentDate: z.number().int().nonnegative(),
    sessionsWithInvalidTimeAnchor: z.number().int().nonnegative(),
    sessionsWithPaddedAssistant: z.number().int().nonnegative(),
    byQuestionType: z.record(z.string(), z.number().int().nonnegative()),
    byChat: z.record(
      z.string(),
      z
        .object({
          sessions: z.number().int().nonnegative(),
          questions: z.number().int().nonnegative(),
          byQuestionType: z.record(z.string(), z.number().int().nonnegative()),
        })
        .strict()
    ),
  })
  .strict()

const manifestSchema = z
  .object({
    manifestSchemaVersion: z.literal(BEAM_MANIFEST_SCHEMA_VERSION),
    canonicalSchemaVersion: z.literal(BEAM_CANONICAL_SCHEMA_VERSION),
    converter: z
      .object({
        name: z.literal("memorybench-beam"),
        version: z.string(),
        implementationHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    includedTiers: z.array(z.enum(["1M", "10M"])),
    sources: z.array(
      z
        .object({
          tier: z.enum(["1M", "10M"]),
          sourceIdentity: z.enum(["reviewed-published", "injected-test-fixture"]),
          repository: z.string(),
          split: z.enum(["1M", "10M"]),
          revision: z.string().regex(/^[a-f0-9]{40}$/),
          files: z.array(sourceFileSchema),
        })
        .strict()
    ),
    canonicalFiles: z.array(canonicalFileSchema),
    counts: z.record(z.string(), tierCountsSchema),
    orderedChatIds: z.record(z.string(), z.array(z.string())),
    orderedChatIdsDigest: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
    orderedQuestionIds: z.record(z.string(), z.array(z.string())),
    orderedQuestionIdsDigest: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
    datasetFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => compareStrings(left, right))
        .map(([key, item]) => [key, canonicalize(item)])
    )
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("BEAM canonical JSON cannot contain a non-finite number")
  }
  return value
}

export function stableBeamStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

export function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  const parsed = parseJsonValue(value, context)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${context} must be an object`)
  }
  return parsed as Record<string, unknown>
}

function normalizePythonLiteralKeywords(value: string): string {
  let result = ""
  let quote: "'" | '"' | undefined
  let escaped = false

  for (let index = 0; index < value.length; ) {
    const character = value[index]!
    if (quote) {
      result += character
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === quote) quote = undefined
      index += 1
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      result += character
      index += 1
      continue
    }
    if (/[A-Za-z_]/.test(character)) {
      let end = index + 1
      while (end < value.length && /[A-Za-z0-9_]/.test(value[end]!)) end += 1
      const token = value.slice(index, end)
      result +=
        token === "None" ? "null" : token === "True" ? "true" : token === "False" ? "false" : token
      index = end
      continue
    }
    result += character
    index += 1
  }
  return result
}

function parseJsonValue(value: unknown, context: string): unknown {
  if (typeof value !== "string") return value
  const trimmed = value.trim()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value
  try {
    return JSON.parse(trimmed)
  } catch (jsonError) {
    try {
      return JSON5.parse(normalizePythonLiteralKeywords(trimmed))
    } catch (literalError) {
      throw new Error(
        `${context} contains invalid JSON/Python-style data: ${String(jsonError)}; ${String(literalError)}`
      )
    }
  }
}

function pickAlias(
  record: Record<string, unknown>,
  aliases: string[],
  context: string,
  required = true
): unknown {
  const matches = aliases.filter((key) => record[key] !== undefined && record[key] !== null)
  if (matches.length === 0) {
    if (!required) return undefined
    throw new Error(`${context} is missing; expected one of: ${aliases.join(", ")}`)
  }
  const first = record[matches[0]]
  for (const key of matches.slice(1)) {
    if (stableBeamStringify(record[key]) !== stableBeamStringify(first)) {
      throw new Error(`${context} is ambiguous; conflicting fields: ${matches.join(", ")}`)
    }
  }
  return first
}

function requireNonEmptyString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${context} must be a non-empty string`)
  }
  return value
}

function normalizeChatId(value: unknown, context: string): string {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`${context} must be a string or number`)
  }
  const chatId = String(value).trim()
  if (!chatId) throw new Error(`${context} must not be empty`)
  if (!/^[a-zA-Z0-9_-]+$/.test(chatId)) {
    throw new Error(`${context} contains unsupported characters: ${chatId}`)
  }
  return chatId
}

function normalizeQuestionType(value: unknown, context: string): BeamQuestionType {
  const source = requireNonEmptyString(value, context)
  const normalized = source
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
  const questionType = QUESTION_TYPE_ALIASES[normalized]
  if (!questionType || !QUESTION_TYPE_SET.has(questionType)) {
    throw new Error(`${context} has unknown BEAM question type: ${source}`)
  }
  return questionType
}

function validDateParts(year: number, month: number, day: number): string | undefined {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day))
    return undefined
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined
  const date = new Date(Date.UTC(year, month - 1, day, 12))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    return undefined
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

export function parseBeamTimeAnchorStrict(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const anchor = value.trim()
  const iso = anchor.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (iso) return validDateParts(Number(iso[1]), Number(iso[2]), Number(iso[3]))

  const named = anchor.match(/^([A-Za-z]+)-(\d{1,2})-(\d{4})$/)
  if (!named) return undefined
  const month = MONTHS[named[1].toLowerCase()]
  if (!month) return undefined
  return validDateParts(Number(named[3]), month, Number(named[2]))
}

function isMessageRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.role === "string" && typeof record.content === "string"
}

function flatMessagesToBatch(
  rawMessages: unknown[],
  batchNumber: number,
  context: string
): Record<string, unknown> {
  if (rawMessages.length === 0 || rawMessages.length % 2 !== 0) {
    throw new Error(`${context} must contain complete user/assistant pairs`)
  }
  const turns: unknown[][] = []
  for (let index = 0; index < rawMessages.length; index += 2) {
    const user = asRecord(rawMessages[index], `${context}[${index}]`)
    const assistant = asRecord(rawMessages[index + 1], `${context}[${index + 1}]`)
    if (user.role !== "user" || assistant.role !== "assistant") {
      throw new Error(
        `${context} must alternate user then assistant; found ${String(user.role)}/${String(assistant.role)} at messages ${index}/${index + 1}`
      )
    }
    turns.push([user, assistant])
  }
  return { batch_number: batchNumber, turns }
}

function flattenBatches(value: unknown, context: string): Record<string, unknown>[] {
  const parsed = parseJsonValue(value, context)
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) throw new Error(`${context} must not be empty`)
    if (parsed.every(isMessageRecord)) {
      return [flatMessagesToBatch(parsed, 1, context)]
    }
    if (
      parsed.every((item) => Array.isArray(item) && item.length > 0 && item.every(isMessageRecord))
    ) {
      return parsed.map((messages, index) =>
        flatMessagesToBatch(messages as unknown[], index + 1, `${context}[${index}]`)
      )
    }
    return parsed.flatMap((item, index) => flattenBatches(item, `${context}[${index}]`))
  }
  const record = asRecord(parsed, context)
  if (record.batch_number !== undefined || record.batchNumber !== undefined) return [record]
  return Object.keys(record)
    .sort(compareStrings)
    .flatMap((key) => {
      const nested = record[key]
      if (nested === undefined || nested === null) return []
      const batches = flattenBatches(nested, `${context}.${key}`)
      const planMatch = key.match(/^plan-(\d+)$/)
      if (!planMatch) return batches
      const planNumber = Number(planMatch[1])
      if (!Number.isInteger(planNumber) || planNumber < 1) {
        throw new Error(`${context}.${key} has an invalid plan number`)
      }
      return batches.map((batch) => {
        const existing = batch.plan_number ?? batch.planNumber
        if (existing !== undefined && Number(existing) !== planNumber) {
          throw new Error(`${context}.${key} conflicts with nested plan number ${String(existing)}`)
        }
        return { ...batch, plan_number: planNumber }
      })
    })
}

const BEAM_MISSING_ASSISTANT_PLACEHOLDER = "N/A"

export const BEAM_10M_PINNED_PADDED_ASSISTANT_SOURCE_IDENTITIES = [
  "10M:1:plan-7:batch-10:source-turn-19",
  "10M:2:plan-7:batch-8:source-turn-51",
] as const

const BEAM_10M_PINNED_PADDED_ASSISTANT_SOURCE_IDENTITY_SET = new Set<string>(
  BEAM_10M_PINNED_PADDED_ASSISTANT_SOURCE_IDENTITIES
)

function structuredTurnSourceIdentity(input: {
  scale: BeamScale
  chatId: string
  planNumber?: number
  batchNumber: number
  sourceTurnNumber: number
}): string {
  return `${input.scale}:${input.chatId}:plan-${input.planNumber ?? 0}:batch-${input.batchNumber}:source-turn-${input.sourceTurnNumber}`
}

function normalizeBatch(
  value: Record<string, unknown>,
  context: string,
  scale: BeamScale,
  chatId: string
): BeamBatch {
  const rawPlanNumber = pickAlias(
    value,
    ["plan_number", "planNumber"],
    `${context}.plan_number`,
    false
  )
  const planNumber =
    rawPlanNumber === undefined
      ? undefined
      : typeof rawPlanNumber === "number"
        ? rawPlanNumber
        : Number(rawPlanNumber)
  if (planNumber !== undefined && (!Number.isInteger(planNumber) || planNumber < 1)) {
    throw new Error(`${context}.plan_number must be a positive integer`)
  }
  const rawBatchNumber = pickAlias(
    value,
    ["batch_number", "batchNumber"],
    `${context}.batch_number`
  )
  const batchNumber = typeof rawBatchNumber === "number" ? rawBatchNumber : Number(rawBatchNumber)
  if (!Number.isInteger(batchNumber) || batchNumber < 0) {
    throw new Error(`${context}.batch_number must be a non-negative integer`)
  }

  const rawTurns = parseJsonValue(
    pickAlias(value, ["turns"], `${context}.turns`),
    `${context}.turns`
  )
  if (!Array.isArray(rawTurns) || rawTurns.length === 0) {
    throw new Error(`${context}.turns must be a non-empty array`)
  }

  const turns = rawTurns.flatMap((rawTurn, turnIndex) => {
    const parsedTurn = parseJsonValue(rawTurn, `${context}.turns[${turnIndex}]`)
    if (!Array.isArray(parsedTurn) || parsedTurn.length < 2) {
      throw new Error(
        `${context}.turns[${turnIndex}] must contain at least one user message followed by one assistant message`
      )
    }
    const messages = parsedTurn.map((rawMessage, messageIndex): BeamMessage => {
      const message = asRecord(rawMessage, `${context}.turns[${turnIndex}][${messageIndex}]`)
      const role = requireNonEmptyString(
        pickAlias(message, ["role"], `${context}.turns[${turnIndex}][${messageIndex}].role`),
        `${context}.turns[${turnIndex}][${messageIndex}].role`
      )
      if (role !== "user" && role !== "assistant") {
        throw new Error(
          `${context}.turns[${turnIndex}][${messageIndex}].role must be user or assistant`
        )
      }
      const content = requireNonEmptyString(
        pickAlias(message, ["content"], `${context}.turns[${turnIndex}][${messageIndex}].content`),
        `${context}.turns[${turnIndex}][${messageIndex}].content`
      )
      const timeAnchor = pickAlias(
        message,
        ["time_anchor", "timeAnchor"],
        `${context}.turns[${turnIndex}][${messageIndex}].time_anchor`,
        false
      )
      if (timeAnchor !== undefined && typeof timeAnchor !== "string") {
        throw new Error(
          `${context}.turns[${turnIndex}][${messageIndex}].time_anchor must be a string`
        )
      }
      return {
        role,
        content,
        ...(timeAnchor ? { time_anchor: timeAnchor } : {}),
      }
    })
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
      const expectedRole = messageIndex % 2 === 0 ? "user" : "assistant"
      if (messages[messageIndex]?.role !== expectedRole) {
        throw new Error(
          `${context}.turns[${turnIndex}] must alternate user then assistant; expected ${expectedRole} at message ${messageIndex}`
        )
      }
    }

    if (messages.length % 2 !== 0) {
      const trailingSourceMessage = asRecord(
        parsedTurn[parsedTurn.length - 1],
        `${context}.turns[${turnIndex}][${parsedTurn.length - 1}]`
      )
      const trailingQuestionType = pickAlias(
        trailingSourceMessage,
        ["question_type", "questionType"],
        `${context}.turns[${turnIndex}][${parsedTurn.length - 1}].question_type`,
        false
      )
      const sourceIdentity = structuredTurnSourceIdentity({
        scale,
        chatId,
        planNumber,
        batchNumber,
        sourceTurnNumber: turnIndex + 1,
      })

      // The pinned 10M source has exactly the two stable source identities
      // listed above whose three-message blocks end with a follow-up user
      // message persisted without its assistant response.
      // The authors' pair-chunk implementation represents this case as
      // `ASSISTANT: N/A`; reproduce that explicit source policy while rejecting
      // every other incomplete or odd structured block.
      if (
        scale !== "10M" ||
        messages.length !== 3 ||
        trailingQuestionType !== "followup_question" ||
        !BEAM_10M_PINNED_PADDED_ASSISTANT_SOURCE_IDENTITY_SET.has(sourceIdentity)
      ) {
        throw new Error(
          `${context}.turns[${turnIndex}] (${sourceIdentity}) must contain complete user/assistant pairs`
        )
      }
      messages.push({
        role: "assistant",
        content: BEAM_MISSING_ASSISTANT_PLACEHOLDER,
        isPaddedAssistant: true,
      })
    }

    const pairs: BeamMessage[][] = []
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 2) {
      pairs.push([messages[messageIndex]!, messages[messageIndex + 1]!])
    }
    return pairs
  })

  const timeAnchor = pickAlias(
    value,
    ["time_anchor", "timeAnchor"],
    `${context}.time_anchor`,
    false
  )
  if (timeAnchor !== undefined && typeof timeAnchor !== "string") {
    throw new Error(`${context}.time_anchor must be a string when present`)
  }

  return {
    ...(planNumber !== undefined ? { plan_number: planNumber } : {}),
    batch_number: batchNumber,
    turns,
    ...(timeAnchor !== undefined ? { time_anchor: timeAnchor } : {}),
  }
}

function resolveBatchDate(batch: BeamBatch): { date?: string; hadInvalidTimeAnchor: boolean } {
  let hadInvalidTimeAnchor = false
  if (batch.time_anchor) {
    const parsed = parseBeamTimeAnchorStrict(batch.time_anchor)
    if (parsed) return { date: parsed, hadInvalidTimeAnchor }
    hadInvalidTimeAnchor = true
  }

  for (const turn of batch.turns) {
    for (const message of turn) {
      if (!message.time_anchor) continue
      const parsed = parseBeamTimeAnchorStrict(message.time_anchor)
      if (parsed) return { date: parsed, hadInvalidTimeAnchor }
      hadInvalidTimeAnchor = true
    }
  }
  return { hadInvalidTimeAnchor }
}

function canonicalizeChat(scale: BeamScale, chatId: string, rawChat: unknown): BeamCanonicalChat {
  const batches = flattenBatches(rawChat, `BEAM ${scale}/${chatId} transcript`)
    .map((batch, index) =>
      normalizeBatch(batch, `BEAM ${scale}/${chatId} batch[${index}]`, scale, chatId)
    )
    .sort(
      (left, right) =>
        (left.plan_number ?? 0) - (right.plan_number ?? 0) || left.batch_number - right.batch_number
    )

  const batchIdentities = new Set<string>()
  const sessions: BeamCanonicalSession[] = []
  for (const batch of batches) {
    const batchIdentity = `${batch.plan_number ?? 0}:${batch.batch_number}`
    if (batchIdentities.has(batchIdentity)) {
      throw new Error(
        `BEAM ${scale}/${chatId} has duplicate ${batch.plan_number ? `plan ${batch.plan_number} ` : ""}batch ${batch.batch_number}`
      )
    }
    batchIdentities.add(batchIdentity)
    const date = resolveBatchDate(batch)
    for (let turnIndex = 0; turnIndex < batch.turns.length; turnIndex++) {
      const hasPaddedAssistant = batch.turns[turnIndex][1]?.isPaddedAssistant === true
      const messages: BeamCanonicalMessage[] = batch.turns[turnIndex].map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.time_anchor ? { timeAnchor: message.time_anchor } : {}),
      }))
      const sessionPrefix = batch.plan_number
        ? `beam-${scale}-${chatId}-plan-${batch.plan_number}-batch-${batch.batch_number}`
        : `beam-${scale}-${chatId}-batch-${batch.batch_number}`
      sessions.push({
        sessionId: `${sessionPrefix}-turn-${turnIndex + 1}`,
        ...(batch.plan_number ? { planNumber: batch.plan_number } : {}),
        batchNumber: batch.batch_number,
        turnIndex: turnIndex + 1,
        ...(date.date ? { documentDate: date.date } : {}),
        ...(date.hadInvalidTimeAnchor ? { hadInvalidTimeAnchor: true } : {}),
        ...(hasPaddedAssistant ? { hasPaddedAssistant: true as const } : {}),
        messages,
      })
    }
  }

  return {
    schemaVersion: BEAM_CANONICAL_SCHEMA_VERSION,
    scale,
    chatId,
    sessions,
  }
}

function normalizeQuestionCollections(
  value: unknown,
  context: string
): Map<BeamQuestionType, unknown[]> {
  const parsed = parseJsonValue(value, context)
  const grouped = new Map<BeamQuestionType, unknown[]>()

  if (Array.isArray(parsed)) {
    for (let index = 0; index < parsed.length; index++) {
      const question = asRecord(parsed[index], `${context}[${index}]`)
      const type = normalizeQuestionType(
        pickAlias(
          question,
          ["question_type", "questionType", "type", "ability"],
          `${context}[${index}].question_type`
        ),
        `${context}[${index}].question_type`
      )
      const entries = grouped.get(type) ?? []
      entries.push(question)
      grouped.set(type, entries)
    }
    return grouped
  }

  const record = asRecord(parsed, context)
  for (const [rawType, rawQuestions] of Object.entries(record)) {
    const type = normalizeQuestionType(rawType, `${context} key`)
    const questions = parseJsonValue(rawQuestions, `${context}.${rawType}`)
    if (!Array.isArray(questions)) {
      throw new Error(`${context}.${rawType} must be an array`)
    }
    if (grouped.has(type)) {
      throw new Error(`${context} contains duplicate aliases for ${type}`)
    }
    grouped.set(type, questions)
  }
  return grouped
}

function getReferenceAnswer(record: Record<string, unknown>, context: string): string | undefined {
  const aliases = ["answer", "ideal_answer", "ideal_response", "ideal_summary"]
  const raw = pickAlias(record, aliases, `${context}.referenceAnswer`, false)
  if (raw === undefined) return undefined
  return requireNonEmptyString(raw, `${context}.referenceAnswer`)
}

function canonicalizeQuestions(
  scale: BeamScale,
  chatId: string,
  rawQuestions: unknown
): BeamCanonicalQuestion[] {
  const collections = normalizeQuestionCollections(
    rawQuestions,
    `BEAM ${scale}/${chatId} questions`
  )
  const questions: BeamCanonicalQuestion[] = []

  for (const questionType of BEAM_QUESTION_TYPE_IDS) {
    const entries = collections.get(questionType)
    if (!entries) continue
    for (let index = 0; index < entries.length; index++) {
      const context = `BEAM ${scale}/${chatId}/${questionType}[${index}]`
      const record = asRecord(entries[index], context)
      const question = requireNonEmptyString(
        pickAlias(record, ["question"], `${context}.question`),
        `${context}.question`
      )
      const rawRubric = parseJsonValue(
        pickAlias(record, ["rubric"], `${context}.rubric`),
        `${context}.rubric`
      )
      if (!Array.isArray(rawRubric) || rawRubric.length === 0) {
        throw new Error(`${context}.rubric must be a non-empty array`)
      }
      const rubric = rawRubric.map((item, rubricIndex) =>
        requireNonEmptyString(item, `${context}.rubric[${rubricIndex}]`)
      )
      const difficultyRaw = pickAlias(record, ["difficulty"], `${context}.difficulty`, false)
      const difficulty =
        difficultyRaw === undefined
          ? undefined
          : requireNonEmptyString(difficultyRaw, `${context}.difficulty`)
      const referenceAnswer = getReferenceAnswer(record, context)
      const contentHash = sha256Text(
        stableBeamStringify({ question, rubric, referenceAnswer: referenceAnswer ?? null })
      )
      questions.push({
        schemaVersion: BEAM_CANONICAL_SCHEMA_VERSION,
        scale,
        chatId,
        questionId: `beam:${scale}:${chatId}:${questionType}:${contentHash}`,
        questionType,
        question,
        rubric,
        ...(difficulty ? { difficulty } : {}),
        ...(referenceAnswer ? { referenceAnswer } : {}),
      })
    }
  }

  for (const type of collections.keys()) {
    if (!QUESTION_TYPE_SET.has(type)) {
      throw new Error(`BEAM ${scale}/${chatId} contains unsupported question type ${type}`)
    }
  }
  return questions.sort((left, right) => compareStrings(left.questionId, right.questionId))
}

function extractSourceRow(
  scale: BeamScale,
  rawRow: unknown,
  rowIndex: number
): { chatId: string; chat: unknown; questions: unknown } {
  let row = asRecord(rawRow, `BEAM ${scale} source row ${rowIndex}`)
  if (row.row !== undefined && Object.keys(row).length === 1) {
    row = asRecord(row.row, `BEAM ${scale} source row ${rowIndex}.row`)
  }
  const chatId = normalizeChatId(
    pickAlias(row, ["conversation_id"], `BEAM ${scale} source row ${rowIndex} chat id`),
    `BEAM ${scale} source row ${rowIndex} chat id`
  )
  const chat = pickAlias(row, ["chat"], `BEAM ${scale}/${chatId} published transcript`)

  const questions = pickAlias(
    row,
    ["probing_questions"],
    `BEAM ${scale}/${chatId} probing questions`
  )
  return { chatId, chat, questions }
}

export function canonicalizeBeamRows(scale: BeamScale, rows: unknown[]): CanonicalBeamTier {
  if (!Array.isArray(rows)) throw new Error(`BEAM ${scale} source rows must be an array`)
  const chats: BeamCanonicalChat[] = []
  const questions: BeamCanonicalQuestion[] = []

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const source = extractSourceRow(scale, rows[rowIndex], rowIndex)
    chats.push(canonicalizeChat(scale, source.chatId, source.chat))
    questions.push(...canonicalizeQuestions(scale, source.chatId, source.questions))
  }

  chats.sort((left, right) => compareStrings(left.chatId, right.chatId))
  questions.sort((left, right) => compareStrings(left.questionId, right.questionId))
  return validateCanonicalBeamTier(scale, chats, questions)
}

function emptyQuestionTypeCounts(): Record<BeamQuestionType, number> {
  return Object.fromEntries(BEAM_QUESTION_TYPE_IDS.map((type) => [type, 0])) as Record<
    BeamQuestionType,
    number
  >
}

function assertCanonicalQuestionId(question: BeamCanonicalQuestion): void {
  const contentHash = sha256Text(
    stableBeamStringify({
      question: question.question,
      rubric: question.rubric,
      referenceAnswer: question.referenceAnswer ?? null,
    })
  )
  const expected = `beam:${question.scale}:${question.chatId}:${question.questionType}:${contentHash}`
  if (question.questionId !== expected) {
    throw new Error(`BEAM question has unstable or tampered ID: ${question.questionId}`)
  }
}

function expectedCanonicalSessionId(
  scale: BeamScale,
  chatId: string,
  session: BeamCanonicalSession
): string {
  const prefix = session.planNumber
    ? `beam-${scale}-${chatId}-plan-${session.planNumber}-batch-${session.batchNumber}`
    : `beam-${scale}-${chatId}-batch-${session.batchNumber}`
  return `${prefix}-turn-${session.turnIndex}`
}

export function validateCanonicalBeamTier(
  scale: BeamScale,
  chatsInput: BeamCanonicalChat[],
  questionsInput: BeamCanonicalQuestion[]
): CanonicalBeamTier {
  const chats = chatsInput.map((chat, index) => {
    const parsed = canonicalChatSchema.parse(chat)
    if (parsed.scale !== scale)
      throw new Error(`BEAM ${scale} chat ${index} has tier ${parsed.scale}`)
    return parsed
  })
  const questions = questionsInput.map((question, index) => {
    const parsed = canonicalQuestionSchema.parse(question)
    if (parsed.scale !== scale) {
      throw new Error(`BEAM ${scale} question ${index} has tier ${parsed.scale}`)
    }
    return parsed
  })

  const expected = BEAM_EXPECTED_COUNTS[scale]
  if (chats.length !== expected.chats) {
    throw new Error(`BEAM ${scale} expected ${expected.chats} chats, found ${chats.length}`)
  }
  if (questions.length !== expected.questions) {
    throw new Error(
      `BEAM ${scale} expected ${expected.questions} questions, found ${questions.length}`
    )
  }

  const chatIds = new Set<string>()
  const sessionIds = new Set<string>()
  let sessionCount = 0
  let sessionsWithDocumentDate = 0
  let sessionsWithInvalidTimeAnchor = 0
  let sessionsWithPaddedAssistant = 0
  for (const chat of chats) {
    if (normalizeChatId(chat.chatId, `BEAM ${scale} chat ID`) !== chat.chatId) {
      throw new Error(`BEAM ${scale} chat ID is not canonical: ${chat.chatId}`)
    }
    if (chatIds.has(chat.chatId)) throw new Error(`BEAM ${scale} has duplicate chat ${chat.chatId}`)
    chatIds.add(chat.chatId)
    if (chat.sessions.length === 0) throw new Error(`BEAM ${scale}/${chat.chatId} has no sessions`)

    let previousPlan = -1
    let previousBatch = -1
    let previousTurn = 0
    for (const session of chat.sessions) {
      const expectedSessionId = expectedCanonicalSessionId(scale, chat.chatId, session)
      if (session.sessionId !== expectedSessionId) {
        throw new Error(
          `BEAM ${scale}/${chat.chatId} has non-canonical session ID ${JSON.stringify(session.sessionId)}; expected ${expectedSessionId}`
        )
      }
      if (sessionIds.has(session.sessionId)) {
        throw new Error(`BEAM ${scale} has duplicate session ${session.sessionId}`)
      }
      sessionIds.add(session.sessionId)
      sessionCount++
      if (
        session.messages.length !== 2 ||
        session.messages[0]?.role !== "user" ||
        session.messages[1]?.role !== "assistant"
      ) {
        throw new Error(
          `BEAM ${scale}/${chat.chatId}/${session.sessionId} must contain exactly one user message followed by one assistant message`
        )
      }
      for (const message of session.messages) {
        if (!message.content.trim()) {
          throw new Error(
            `BEAM ${scale}/${chat.chatId}/${session.sessionId} has empty message content`
          )
        }
      }
      if (session.hasPaddedAssistant) {
        if (
          scale !== "10M" ||
          session.messages[1]?.role !== "assistant" ||
          session.messages[1].content !== BEAM_MISSING_ASSISTANT_PLACEHOLDER
        ) {
          throw new Error(
            `BEAM ${scale}/${chat.chatId}/${session.sessionId} has invalid padded-assistant metadata`
          )
        }
        sessionsWithPaddedAssistant++
      }
      const planNumber = session.planNumber ?? 0
      if (
        planNumber < previousPlan ||
        (planNumber === previousPlan && session.batchNumber < previousBatch) ||
        (planNumber === previousPlan &&
          session.batchNumber === previousBatch &&
          session.turnIndex <= previousTurn)
      ) {
        throw new Error(`BEAM ${scale}/${chat.chatId} sessions are not chronologically ordered`)
      }
      previousPlan = planNumber
      previousBatch = session.batchNumber
      previousTurn = session.turnIndex
      if (session.documentDate) {
        if (parseBeamTimeAnchorStrict(session.documentDate) !== session.documentDate) {
          throw new Error(
            `BEAM ${scale}/${chat.chatId}/${session.sessionId} has invalid documentDate ${session.documentDate}`
          )
        }
        sessionsWithDocumentDate++
      }
      if (session.hadInvalidTimeAnchor) sessionsWithInvalidTimeAnchor++
    }
  }

  const questionIds = new Set<string>()
  const questionsByChat = new Map<string, BeamCanonicalQuestion[]>()
  const byQuestionType = emptyQuestionTypeCounts()
  for (const question of questions) {
    if (!chatIds.has(question.chatId)) {
      throw new Error(
        `BEAM ${scale} question ${question.questionId} references unknown chat ${question.chatId}`
      )
    }
    if (questionIds.has(question.questionId)) {
      throw new Error(`BEAM ${scale} has duplicate question ${question.questionId}`)
    }
    questionIds.add(question.questionId)
    assertCanonicalQuestionId(question)
    if (!question.question.trim()) {
      throw new Error(`BEAM ${scale} question ${question.questionId} is empty`)
    }
    if (question.rubric.length === 0 || question.rubric.some((nugget) => !nugget.trim())) {
      throw new Error(`BEAM ${scale} question ${question.questionId} has an empty rubric`)
    }
    byQuestionType[question.questionType]++
    const grouped = questionsByChat.get(question.chatId) ?? []
    grouped.push(question)
    questionsByChat.set(question.chatId, grouped)
  }

  for (const chat of chats) {
    const chatQuestions = questionsByChat.get(chat.chatId) ?? []
    if (chatQuestions.length !== 20) {
      throw new Error(
        `BEAM ${scale}/${chat.chatId} expected 20 questions, found ${chatQuestions.length}`
      )
    }
    for (const questionType of BEAM_QUESTION_TYPE_IDS) {
      const count = chatQuestions.filter(
        (question) => question.questionType === questionType
      ).length
      if (count !== 2) {
        throw new Error(
          `BEAM ${scale}/${chat.chatId} expected 2 ${questionType} questions, found ${count}`
        )
      }
    }
  }

  const byChat = Object.fromEntries(
    chats.map((chat) => {
      const chatQuestions = questionsByChat.get(chat.chatId) ?? []
      const chatQuestionTypes = emptyQuestionTypeCounts()
      for (const question of chatQuestions) chatQuestionTypes[question.questionType]++
      return [
        chat.chatId,
        {
          sessions: chat.sessions.length,
          questions: chatQuestions.length,
          byQuestionType: chatQuestionTypes,
        },
      ]
    })
  )

  const counts: BeamTierCounts = {
    chats: chats.length,
    questions: questions.length,
    sessions: sessionCount,
    sessionsWithDocumentDate,
    sessionsWithoutDocumentDate: sessionCount - sessionsWithDocumentDate,
    sessionsWithInvalidTimeAnchor,
    sessionsWithPaddedAssistant,
    byQuestionType,
    byChat,
  }
  return { scale, chats, questions, counts }
}

export function assertReviewedBeamPaddedAssistantCounts(
  scale: BeamScale,
  counts: BeamTierCounts
): void {
  const expected = scale === "10M" ? BEAM_10M_PINNED_PADDED_ASSISTANT_SOURCE_IDENTITIES.length : 0
  if (counts.sessionsWithPaddedAssistant !== expected) {
    throw new Error(
      `Reviewed BEAM ${scale} source expected ${expected} padded missing-assistant sessions, found ${counts.sessionsWithPaddedAssistant}`
    )
  }
}

export function serializeBeamJsonl(rows: unknown[]): string {
  return rows.map((row) => stableBeamStringify(row)).join("\n") + "\n"
}

export function parseBeamJsonl<T>(content: string, schema: z.ZodType<T>, context: string): T[] {
  const rows: T[] = []
  const lines = content.split("\n")
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (!line) continue
    try {
      rows.push(schema.parse(JSON.parse(line)))
    } catch (error) {
      throw new Error(`${context} line ${index + 1} is malformed: ${String(error)}`)
    }
  }
  return rows
}

export function computeCanonicalFileManifest(
  relativePath: string,
  bytes: Uint8Array,
  rowCount: number
): BeamCanonicalFileManifest {
  return {
    path: relativePath,
    byteSize: bytes.byteLength,
    sha256: sha256Bytes(bytes),
    rowCount,
  }
}

export function datasetFingerprintPayload(
  manifest: Omit<BeamDatasetManifest, "datasetFingerprint" | "manifestHash">
): unknown {
  return {
    manifestSchemaVersion: manifest.manifestSchemaVersion,
    canonicalSchemaVersion: manifest.canonicalSchemaVersion,
    converter: manifest.converter,
    includedTiers: manifest.includedTiers,
    sources: manifest.sources.map((source) => ({
      tier: source.tier,
      sourceIdentity: source.sourceIdentity,
      repository: source.repository,
      split: source.split,
      revision: source.revision,
      files: source.files
        .map((file) => ({
          path: file.path,
          byteSize: file.byteSize,
          sha256: file.sha256,
        }))
        .sort((left, right) => compareStrings(left.path, right.path)),
    })),
    canonicalFiles: manifest.canonicalFiles,
    counts: manifest.counts,
    orderedChatIds: manifest.orderedChatIds,
    orderedChatIdsDigest: manifest.orderedChatIdsDigest,
    orderedQuestionIds: manifest.orderedQuestionIds,
    orderedQuestionIdsDigest: manifest.orderedQuestionIdsDigest,
  }
}

export function computeDatasetFingerprint(
  manifest: Omit<BeamDatasetManifest, "datasetFingerprint" | "manifestHash">
): string {
  return sha256Text(stableBeamStringify(datasetFingerprintPayload(manifest)))
}

export function computeManifestHash(manifest: Omit<BeamDatasetManifest, "manifestHash">): string {
  return sha256Text(stableBeamStringify(manifest))
}

function assertManifestSourcePins(
  manifest: BeamDatasetManifest,
  tiers: BeamScale[],
  allowTestSourceIdentity: boolean
): void {
  for (const tier of tiers) {
    const expected = BEAM_DATASET_SOURCES[tier]
    const matchingSources = manifest.sources.filter((entry) => entry.tier === tier)
    if (matchingSources.length !== 1) {
      throw new Error(
        `BEAM snapshot must include exactly one source identity for ${tier}; found ${matchingSources.length}`
      )
    }
    const source = matchingSources[0]!
    if (
      source.repository !== expected.repository ||
      source.split !== expected.split ||
      source.revision !== expected.revision
    ) {
      throw new Error(`BEAM ${tier} source pin does not match the reviewed official revision`)
    }
    const expectedPaths = expected.parquetFiles.map((file) => file.path).sort(compareStrings)
    const actualPaths = source.files.map((file) => file.path).sort(compareStrings)
    if (stableBeamStringify(expectedPaths) !== stableBeamStringify(actualPaths)) {
      throw new Error(`BEAM ${tier} source file set does not match the reviewed source descriptor`)
    }

    if (source.sourceIdentity === "injected-test-fixture") {
      if (!allowTestSourceIdentity) {
        throw new Error(
          `BEAM ${tier} snapshot uses an injected test-source identity and cannot be used for a scored run`
        )
      }
      continue
    }

    for (const expectedFile of expected.parquetFiles) {
      if (!expectedFile.expectedSha256) {
        throw new Error(
          `BEAM ${tier} reviewed source ${expectedFile.path} is missing a SHA-256 pin`
        )
      }
      const actualFile = source.files.find((file) => file.path === expectedFile.path)
      if (!actualFile || actualFile.sha256 !== expectedFile.expectedSha256) {
        throw new Error(
          `BEAM ${tier} source ${expectedFile.path} SHA-256 does not match the reviewed published pin`
        )
      }
      if (actualFile.url !== expectedFile.url) {
        throw new Error(
          `BEAM ${tier} source ${expectedFile.path} URL does not match the reviewed pin`
        )
      }
    }
  }
}

function assertRunningConverterIdentity(manifest: BeamDatasetManifest): void {
  if (stableBeamStringify(manifest.converter) !== stableBeamStringify(BEAM_CONVERTER_IDENTITY)) {
    throw new Error(
      `BEAM snapshot converter identity does not match this runtime; prepare a new snapshot with converter ${BEAM_CONVERTER_IDENTITY.version}`
    )
  }
}

function resolveSnapshotFile(snapshotPath: string, filePath: string): string {
  const absolutePath = resolve(snapshotPath, filePath)
  const snapshotRoot = resolve(snapshotPath)
  const relativePath = relative(snapshotRoot, absolutePath)
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`BEAM manifest contains an unsafe snapshot path: ${filePath}`)
  }
  return absolutePath
}

function verifyFile(snapshotPath: string, file: BeamCanonicalFileManifest): Uint8Array {
  const absolutePath = resolveSnapshotFile(snapshotPath, file.path)
  if (!existsSync(absolutePath)) throw new Error(`BEAM canonical file is missing: ${file.path}`)
  const stat = statSync(absolutePath)
  if (!stat.isFile() || stat.size !== file.byteSize) {
    throw new Error(`BEAM canonical file size mismatch: ${file.path}`)
  }
  const bytes = readFileSync(absolutePath)
  if (sha256Bytes(bytes) !== file.sha256) {
    throw new Error(`BEAM canonical file hash mismatch: ${file.path}`)
  }
  return bytes
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest("hex")
}

async function verifySourceFiles(
  snapshotPath: string,
  manifest: BeamDatasetManifest
): Promise<void> {
  for (const source of manifest.sources) {
    for (const file of source.files) {
      const absolutePath = resolveSnapshotFile(snapshotPath, file.snapshotPath)
      if (!existsSync(absolutePath)) {
        throw new Error(`BEAM source file is missing: ${file.snapshotPath}`)
      }
      const fileStat = statSync(absolutePath)
      if (!fileStat.isFile() || fileStat.size !== file.byteSize) {
        throw new Error(`BEAM source file size mismatch: ${file.snapshotPath}`)
      }
      if ((await hashFile(absolutePath)) !== file.sha256) {
        throw new Error(`BEAM source file hash mismatch: ${file.snapshotPath}`)
      }
    }
  }
}

function assertCompleteMarker(snapshotPath: string, manifest: BeamDatasetManifest): void {
  const completePath = join(snapshotPath, ".complete")
  if (!existsSync(completePath)) {
    throw new Error(`BEAM snapshot is incomplete at ${snapshotPath}; run the BEAM prepare command`)
  }
  let marker: unknown
  try {
    marker = JSON.parse(readFileSync(completePath, "utf8"))
  } catch (error) {
    throw new Error(`BEAM .complete marker is malformed: ${String(error)}`)
  }
  const record = asRecord(marker, "BEAM .complete marker")
  if (
    record.datasetFingerprint !== manifest.datasetFingerprint ||
    record.manifestHash !== manifest.manifestHash
  ) {
    throw new Error("BEAM .complete marker does not match manifest identity")
  }
}

/**
 * Validate every source, canonical file, manifest identity, and dataset invariant.
 * Preparation uses this before it writes `.complete`; scored runs must call
 * `loadPreparedBeamDataset`, which additionally requires the completion marker.
 */
export async function validatePreparedBeamSnapshotContents(
  options: ValidatePreparedBeamSnapshotContentsOptions
): Promise<PreparedBeamDataset> {
  const snapshotPath = resolve(options.snapshotPath)
  const manifestPath = join(snapshotPath, "manifest.json")
  if (!existsSync(manifestPath)) {
    throw new Error(`BEAM manifest not found at ${manifestPath}; run the BEAM prepare command`)
  }

  let rawManifest: unknown
  try {
    rawManifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  } catch (error) {
    throw new Error(`BEAM manifest is malformed: ${String(error)}`)
  }
  const manifest = manifestSchema.parse(rawManifest) as BeamDatasetManifest
  const withoutHash = { ...manifest } as Partial<BeamDatasetManifest>
  delete withoutHash.manifestHash
  const actualManifestHash = computeManifestHash(
    withoutHash as Omit<BeamDatasetManifest, "manifestHash">
  )
  if (actualManifestHash !== manifest.manifestHash) {
    throw new Error("BEAM manifest hash mismatch")
  }

  const withoutIdentity = { ...withoutHash } as Partial<BeamDatasetManifest>
  delete withoutIdentity.datasetFingerprint
  const actualFingerprint = computeDatasetFingerprint(
    withoutIdentity as Omit<BeamDatasetManifest, "datasetFingerprint" | "manifestHash">
  )
  if (actualFingerprint !== manifest.datasetFingerprint) {
    throw new Error("BEAM dataset fingerprint mismatch")
  }
  if (
    options.expectedDatasetFingerprint &&
    options.expectedDatasetFingerprint !== manifest.datasetFingerprint
  ) {
    throw new Error(
      `BEAM dataset revision mismatch: expected ${options.expectedDatasetFingerprint}, found ${manifest.datasetFingerprint}`
    )
  }
  const manifestTiers = [...new Set(manifest.includedTiers)]
  if (
    manifestTiers.length !== manifest.includedTiers.length ||
    manifest.sources.length !== manifestTiers.length
  ) {
    throw new Error("BEAM manifest tier/source identities must be unique and one-to-one")
  }
  assertRunningConverterIdentity(manifest)
  assertManifestSourcePins(manifest, manifestTiers, options.allowInjectedTestSourceIdentity)

  const expectedTierKeys = [...manifestTiers].sort(compareStrings)
  for (const [name, record] of Object.entries({
    counts: manifest.counts,
    orderedChatIds: manifest.orderedChatIds,
    orderedChatIdsDigest: manifest.orderedChatIdsDigest,
    orderedQuestionIds: manifest.orderedQuestionIds,
    orderedQuestionIdsDigest: manifest.orderedQuestionIdsDigest,
  })) {
    if (
      stableBeamStringify(Object.keys(record).sort(compareStrings)) !==
      stableBeamStringify(expectedTierKeys)
    ) {
      throw new Error(`BEAM manifest ${name} tier keys do not match includedTiers`)
    }
  }

  const expectedCanonicalPaths = manifestTiers
    .flatMap((tier) => [`canonical/${tier}/chats.jsonl`, `canonical/${tier}/questions.jsonl`])
    .sort(compareStrings)
  const actualCanonicalPaths = manifest.canonicalFiles.map((file) => file.path).sort(compareStrings)
  if (
    new Set(actualCanonicalPaths).size !== actualCanonicalPaths.length ||
    stableBeamStringify(actualCanonicalPaths) !== stableBeamStringify(expectedCanonicalPaths)
  ) {
    throw new Error(
      "BEAM manifest canonical file set must contain exactly one chats and questions file per tier"
    )
  }

  const tiers = [...new Set(options.tiers)]
  for (const tier of tiers) {
    if (!manifest.includedTiers.includes(tier)) {
      throw new Error(`BEAM snapshot ${manifest.datasetFingerprint} does not include tier ${tier}`)
    }
  }
  await verifySourceFiles(snapshotPath, manifest)

  const chatsByTier: Partial<Record<BeamScale, BeamCanonicalChat[]>> = {}
  const questionsByTier: Partial<Record<BeamScale, BeamCanonicalQuestion[]>> = {}
  for (const tier of tiers) {
    const chatsPath = `canonical/${tier}/chats.jsonl`
    const questionsPath = `canonical/${tier}/questions.jsonl`
    const chatsFile = manifest.canonicalFiles.find((file) => file.path === chatsPath)
    const questionsFile = manifest.canonicalFiles.find((file) => file.path === questionsPath)
    if (!chatsFile || !questionsFile) {
      throw new Error(`BEAM ${tier} canonical file entries are missing from manifest`)
    }
    const chatsBytes = verifyFile(snapshotPath, chatsFile)
    const questionsBytes = verifyFile(snapshotPath, questionsFile)
    const chats = parseBeamJsonl(
      Buffer.from(chatsBytes).toString("utf8"),
      canonicalChatSchema,
      `BEAM ${tier} chats`
    )
    const questions = parseBeamJsonl(
      Buffer.from(questionsBytes).toString("utf8"),
      canonicalQuestionSchema,
      `BEAM ${tier} questions`
    )
    if (chats.length !== chatsFile.rowCount || questions.length !== questionsFile.rowCount) {
      throw new Error(`BEAM ${tier} canonical row count does not match manifest`)
    }
    const validated = validateCanonicalBeamTier(tier, chats, questions)
    if (stableBeamStringify(validated.counts) !== stableBeamStringify(manifest.counts[tier])) {
      throw new Error(`BEAM ${tier} validated counts do not match manifest`)
    }
    const source = manifest.sources.find((entry) => entry.tier === tier)
    if (source?.sourceIdentity === "reviewed-published") {
      assertReviewedBeamPaddedAssistantCounts(tier, validated.counts)
    }
    const orderedChatIds = validated.chats.map((chat) => chat.chatId)
    if (
      stableBeamStringify(orderedChatIds) !== stableBeamStringify(manifest.orderedChatIds[tier])
    ) {
      throw new Error(`BEAM ${tier} ordered chat identity does not match manifest`)
    }
    const chatIdDigest = sha256Text(orderedChatIds.join("\n"))
    if (chatIdDigest !== manifest.orderedChatIdsDigest[tier]) {
      throw new Error(`BEAM ${tier} chat identity digest does not match manifest`)
    }
    const orderedQuestionIds = validated.questions.map((question) => question.questionId)
    if (
      stableBeamStringify(orderedQuestionIds) !==
      stableBeamStringify(manifest.orderedQuestionIds[tier])
    ) {
      throw new Error(`BEAM ${tier} ordered question identity does not match manifest`)
    }
    const questionIdDigest = sha256Text(orderedQuestionIds.join("\n"))
    if (questionIdDigest !== manifest.orderedQuestionIdsDigest[tier]) {
      throw new Error(`BEAM ${tier} question identity digest does not match manifest`)
    }
    chatsByTier[tier] = validated.chats
    questionsByTier[tier] = validated.questions
  }

  return { snapshotPath, manifest, chatsByTier, questionsByTier }
}

/**
 * Re-run the canonical converter over authenticated source Parquet rows and
 * compare exact deterministic JSONL bytes. This couples source and canonical
 * files instead of trusting a self-asserted manifest relationship.
 */
export async function verifyPreparedBeamSourceDerivation(
  prepared: PreparedBeamDataset,
  tiers: BeamScale[],
  decodeParquet: BeamParquetDecoder = decodeBeamParquetWithHyparquet
): Promise<void> {
  for (const tier of [...new Set(tiers)]) {
    const source = prepared.manifest.sources.find((entry) => entry.tier === tier)
    if (!source) throw new Error(`BEAM ${tier} source identity is missing during derivation check`)
    const descriptor = BEAM_DATASET_SOURCES[tier]
    const sourceRows: unknown[] = []
    for (const expectedFile of descriptor.parquetFiles) {
      const sourceFile = source.files.find((file) => file.path === expectedFile.path)
      if (!sourceFile) {
        throw new Error(
          `BEAM ${tier} source ${expectedFile.path} is missing during derivation check`
        )
      }
      const rows = await decodeParquet(
        resolveSnapshotFile(prepared.snapshotPath, sourceFile.snapshotPath),
        tier
      )
      if (!Array.isArray(rows)) {
        throw new Error(`BEAM ${tier} derivation decoder did not return an array of rows`)
      }
      sourceRows.push(...rows)
    }

    const canonical = canonicalizeBeamRows(tier, sourceRows)
    if (source.sourceIdentity === "reviewed-published") {
      assertReviewedBeamPaddedAssistantCounts(tier, canonical.counts)
    }
    for (const [kind, expectedContent] of [
      ["chats", serializeBeamJsonl(canonical.chats)],
      ["questions", serializeBeamJsonl(canonical.questions)],
    ] as const) {
      const relativePath = `canonical/${tier}/${kind}.jsonl`
      const actualContent = readFileSync(
        resolveSnapshotFile(prepared.snapshotPath, relativePath),
        "utf8"
      )
      if (actualContent !== expectedContent) {
        throw new Error(
          `BEAM ${tier} ${kind} source-to-canonical derivation mismatch; prepare a new snapshot from the pinned source`
        )
      }
    }
  }
}

const verifiedPublishedDerivations = new Set<string>()

export function getUnverifiedBeamDerivationTiers(
  datasetFingerprint: string,
  tiers: BeamScale[],
  verifiedDerivations: ReadonlySet<string> = verifiedPublishedDerivations
): BeamScale[] {
  return [...new Set(tiers)].filter(
    (tier) => !verifiedDerivations.has(`${datasetFingerprint}:${tier}`)
  )
}

export async function loadPreparedBeamDataset(
  options: LoadPreparedBeamDatasetOptions
): Promise<PreparedBeamDataset> {
  const prepared = await validatePreparedBeamSnapshotContents({
    ...options,
    allowInjectedTestSourceIdentity: false,
  })
  assertCompleteMarker(prepared.snapshotPath, prepared.manifest)
  const unverifiedTiers = getUnverifiedBeamDerivationTiers(
    prepared.manifest.datasetFingerprint,
    options.tiers
  )
  for (const tier of unverifiedTiers) {
    await verifyPreparedBeamSourceDerivation(prepared, [tier])
    verifiedPublishedDerivations.add(`${prepared.manifest.datasetFingerprint}:${tier}`)
  }
  return prepared
}

/** Explicit fixture-only loader; scored benchmark code must never call this. */
export async function loadPreparedBeamTestFixture(
  options: LoadPreparedBeamDatasetOptions
): Promise<PreparedBeamDataset> {
  const prepared = await validatePreparedBeamSnapshotContents({
    ...options,
    allowInjectedTestSourceIdentity: true,
  })
  assertCompleteMarker(prepared.snapshotPath, prepared.manifest)
  return prepared
}

export function resolvePreparedSnapshotPath(dataPath: string, datasetRevision?: string): string {
  const fullPath = resolve(dataPath)
  if (existsSync(join(fullPath, "manifest.json"))) return fullPath
  if (datasetRevision) return join(fullPath, datasetRevision)

  throw new Error(
    `BEAM data path ${fullPath} is not a prepared snapshot. Pass --dataset-revision <fingerprint> or run the BEAM prepare command.`
  )
}

export function describeBeamSnapshot(manifest: BeamDatasetManifest): string {
  return `${manifest.includedTiers.join("+")} @ ${manifest.datasetFingerprint.slice(0, 12)}`
}

export function describeBeamTemporalCoverage(
  counts: BeamDatasetManifest["counts"],
  tiers: BeamScale[]
): string {
  const tierSummaries = [...new Set(tiers)].map((tier) => {
    const tierCounts = counts[tier]
    if (!tierCounts) throw new Error(`BEAM temporal counts are missing tier ${tier}`)
    return `${tier}: ${tierCounts.sessionsWithoutDocumentDate}/${tierCounts.sessions} sessions without a valid date; ${tierCounts.sessionsWithInvalidTimeAnchor}/${tierCounts.sessions} encountered an invalid source time anchor; ${tierCounts.sessionsWithPaddedAssistant}/${tierCounts.sessions} use an audited N/A assistant padding`
  })
  return `BEAM temporal/source coverage — ${tierSummaries.join(" | ")}. Invalid-anchor counts are separate, not additive: a session may have a valid fallback date after an invalid anchor. Padded-assistant counts identify the two pinned 10M source follow-ups whose responses are absent.`
}

export function isPreparedBeamSnapshot(path: string): boolean {
  return existsSync(join(path, "manifest.json")) && existsSync(join(path, ".complete"))
}

export function snapshotDirectoryName(manifest: BeamDatasetManifest): string {
  return basename(manifest.datasetFingerprint)
}

export const BEAM_DATASET_MANIFEST_SCHEMA = manifestSchema
export const BEAM_CANONICAL_CHAT_SCHEMA = canonicalChatSchema
export const BEAM_CANONICAL_QUESTION_SCHEMA = canonicalQuestionSchema
export const BEAM_CONVERTER_IDENTITY = {
  name: "memorybench-beam" as const,
  version: BEAM_CONVERTER_VERSION,
  implementationHash: BEAM_CONVERTER_IMPLEMENTATION_HASH,
}
