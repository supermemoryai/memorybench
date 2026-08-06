import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  BEAM_EXPECTED_COUNTS,
  canonicalizeBeamRows,
  computeDatasetFingerprint,
  computeManifestHash,
  describeBeamTemporalCoverage,
  getUnverifiedBeamDerivationTiers,
  loadPreparedBeamDataset,
  loadPreparedBeamTestFixture,
  parseBeamTimeAnchorStrict,
  serializeBeamJsonl,
  sha256Bytes,
  stableBeamStringify,
  validateCanonicalBeamTier,
  verifyPreparedBeamSourceDerivation,
} from "../src/benchmarks/beam/dataset"
import { prepareBeamDataset } from "../src/benchmarks/beam/prepare"
import { createBeamDatasetIdentity } from "../src/benchmarks/beam"
import {
  BEAM_QUESTION_TYPE_IDS,
  type BeamDatasetManifest,
  type BeamScale,
} from "../src/benchmarks/beam/types"

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "memorybench-beam-test-"))
  tempRoots.push(path)
  return path
}

function probingQuestions(chatId: string): Record<string, unknown[]> {
  return Object.fromEntries(
    BEAM_QUESTION_TYPE_IDS.map((questionType) => [
      questionType,
      [0, 1].map((ordinal) => ({
        question: `Question ${chatId} ${questionType} ${ordinal}`,
        rubric: [
          `Nugget ${chatId} ${questionType} ${ordinal} A`,
          `Nugget ${chatId} ${questionType} ${ordinal} B`,
        ],
        answer: `Answer ${chatId} ${questionType} ${ordinal}`,
        difficulty: ordinal === 0 ? "easy" : "hard",
      })),
    ])
  )
}

function sourceRows(
  scale: BeamScale,
  options?: { invalidBatchAnchorWithMessageFallback?: boolean }
): Record<string, unknown>[] {
  const count = BEAM_EXPECTED_COUNTS[scale].chats
  return Array.from({ length: count }, (_, index) => {
    const chatId = String(index + 1)
    const invalidWithFallback = index === 0 && options?.invalidBatchAnchorWithMessageFallback
    return {
      conversation_id: chatId,
      chat: [
        {
          batch_number: 1,
          time_anchor: invalidWithFallback ? "February-30-2024" : "March-01-2024",
          turns: [
            [
              {
                role: "user",
                content: `User <literal> ${scale}/${chatId}`,
                ...(invalidWithFallback ? { time_anchor: "March-02-2024" } : {}),
              },
              { role: "assistant", content: `Assistant ${scale}/${chatId}` },
            ],
          ],
        },
      ],
      probing_questions: probingQuestions(chatId),
    }
  })
}

function parquetResponse(payload = "fixture"): Response {
  const bytes = Buffer.concat([Buffer.from("PAR1"), Buffer.from(payload), Buffer.from("PAR1")])
  return new Response(bytes, {
    status: 200,
    headers: { "content-length": String(bytes.byteLength) },
  })
}

function flipOneByte(bytes: Uint8Array): Buffer {
  const changed = Buffer.from(bytes)
  changed[Math.min(4, changed.length - 1)]! ^= 1
  return changed
}

async function rewriteManifest(
  snapshotPath: string,
  mutate: (manifest: BeamDatasetManifest) => void
): Promise<BeamDatasetManifest> {
  const current = JSON.parse(
    await readFile(join(snapshotPath, "manifest.json"), "utf8")
  ) as BeamDatasetManifest
  mutate(current)
  const {
    datasetFingerprint: _oldDatasetFingerprint,
    manifestHash: _oldManifestHash,
    ...core
  } = current
  const datasetFingerprint = computeDatasetFingerprint(core)
  const withoutHash = { ...core, datasetFingerprint }
  const manifest: BeamDatasetManifest = {
    ...withoutHash,
    manifestHash: computeManifestHash(withoutHash),
  }
  await writeFile(join(snapshotPath, "manifest.json"), stableBeamStringify(manifest) + "\n")
  await writeFile(
    join(snapshotPath, ".complete"),
    stableBeamStringify({
      datasetFingerprint: manifest.datasetFingerprint,
      manifestHash: manifest.manifestHash,
    }) + "\n"
  )
  return manifest
}

function fixtureDecoder(rows: Record<string, unknown>[]) {
  return async (filePath: string): Promise<unknown[]> => {
    if (filePath.includes("0-10M-")) return rows.slice(0, 5)
    if (filePath.includes("1-10M-")) return rows.slice(5)
    return rows
  }
}

function toPythonLiteral(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("'", "\\'")
    .replaceAll('"', "'")
    .replace(/\btrue\b/g, "True")
    .replace(/\bfalse\b/g, "False")
    .replace(/\bnull\b/g, "None")
}

describe("BEAM canonical dataset", () => {
  test("tracks source derivation independently for every tier in a combined snapshot", () => {
    const fingerprint = "f".repeat(64)
    const verified = new Set([`${fingerprint}:1M`])

    expect(getUnverifiedBeamDerivationTiers(fingerprint, ["1M", "10M"], verified)).toEqual(["10M"])
  })

  test("validates exact 1M counts, abilities, stable IDs, and literal transcript content", () => {
    const canonical = canonicalizeBeamRows("1M", sourceRows("1M"))

    expect(canonical.chats).toHaveLength(35)
    expect(canonical.questions).toHaveLength(700)
    expect(canonical.counts.byQuestionType.abstention).toBe(70)
    expect(canonical.chats[0].sessions[0].messages[0].content).toContain("<literal>")
    expect(canonical.chats[0].sessions[0].documentDate).toBe("2024-03-01")
    expect(canonical.questions[0].questionId).toMatch(
      /^beam:1M:[a-zA-Z0-9_-]+:[a-z_]+:[a-f0-9]{64}$/
    )
  })

  test("validates exact 10M counts", () => {
    const canonical = canonicalizeBeamRows("10M", sourceRows("10M"))
    expect(canonical.chats).toHaveLength(10)
    expect(canonical.questions).toHaveLength(200)
    for (const questionType of BEAM_QUESTION_TYPE_IDS) {
      expect(canonical.counts.byQuestionType[questionType]).toBe(20)
    }
  })

  test("parses the published 1M flat batches and Python-style probing questions", () => {
    const rows = sourceRows("1M")
    const questions = probingQuestions("1")
    ;(questions.abstention[0] as Record<string, unknown>).publishedFlag = true
    ;(questions.abstention[0] as Record<string, unknown>).publishedOptional = null
    rows[0] = {
      conversation_id: "1",
      chat: [
        [
          {
            id: 0,
            role: "user",
            content: "First official user message",
            index: "1,1",
            question_type: "main_question",
            time_anchor: "March-01-2024",
          },
          { id: 1, role: "assistant", content: "First official answer" },
          { id: 2, role: "user", content: "Follow-up" },
          { id: 3, role: "assistant", content: "Follow-up answer" },
        ],
        [
          {
            id: 4,
            role: "user",
            content: "Second batch",
            time_anchor: "March-12-2024",
          },
          { id: 5, role: "assistant", content: "Second batch answer" },
        ],
      ],
      probing_questions: toPythonLiteral(questions),
    }

    const canonical = canonicalizeBeamRows("1M", rows)
    const chat = canonical.chats.find((item) => item.chatId === "1")!
    expect(chat.sessions).toHaveLength(3)
    expect(chat.sessions.map((session) => session.sessionId)).toEqual([
      "beam-1M-1-batch-1-turn-1",
      "beam-1M-1-batch-1-turn-2",
      "beam-1M-1-batch-2-turn-1",
    ])
    expect(chat.sessions.map((session) => session.documentDate)).toEqual([
      "2024-03-01",
      "2024-03-01",
      "2024-03-12",
    ])
    expect(chat.sessions[1].messages.map((message) => message.role)).toEqual(["user", "assistant"])
  })

  test("selects only the reviewed published transcript column", () => {
    const rows = sourceRows("1M")
    rows[0].chat_truncated = rows[0].chat
    delete rows[0].chat

    expect(() => canonicalizeBeamRows("1M", rows)).toThrow("published transcript is missing")
  })

  test("parses nullable 10M plan fields without colliding repeated batch numbers", () => {
    const rows = sourceRows("10M")
    rows[0] = {
      conversation_id: "1",
      chat: [
        {
          "plan-1": [
            {
              batch_number: 1,
              time_anchor: null,
              turns: [
                [
                  { role: "user", content: "Plan one", time_anchor: "July-01-2024" },
                  { role: "assistant", content: "Plan one answer" },
                ],
              ],
            },
          ],
          "plan-2": null,
        },
        {
          "plan-1": null,
          "plan-2": [
            {
              batch_number: 1,
              time_anchor: null,
              turns: [
                [
                  { role: "user", content: "Plan two", time_anchor: "July-16-2024" },
                  { role: "assistant", content: "Plan two answer" },
                ],
              ],
            },
          ],
        },
      ],
      probing_questions: toPythonLiteral(probingQuestions("1")),
    }

    const canonical = canonicalizeBeamRows("10M", rows)
    const chat = canonical.chats.find((item) => item.chatId === "1")!
    expect(chat.sessions.map((session) => session.sessionId)).toEqual([
      "beam-10M-1-plan-1-batch-1-turn-1",
      "beam-10M-1-plan-2-batch-1-turn-1",
    ])
    expect(chat.sessions.map((session) => session.planNumber)).toEqual([1, 2])
    expect(chat.sessions.map((session) => session.documentDate)).toEqual([
      "2024-07-01",
      "2024-07-16",
    ])
  })

  test("splits pinned 10M complete variable-length blocks into strict pairs", () => {
    const rows = sourceRows("10M")
    const fivePairBlock = Array.from({ length: 5 }, (_, pairIndex) => [
      {
        id: pairIndex * 2,
        index: `1,${pairIndex + 1}`,
        question_type: pairIndex === 0 ? "main_question" : "followup_question",
        role: "user",
        content: `Official 10M user ${pairIndex + 1}`,
        time_anchor: pairIndex === 0 ? "July-01-2024" : null,
      },
      {
        id: pairIndex * 2 + 1,
        index: null,
        question_type: null,
        role: "assistant",
        content: `Official 10M assistant ${pairIndex + 1}`,
        time_anchor: null,
      },
    ]).flat()
    rows[0] = {
      conversation_id: "1",
      chat: [
        {
          "plan-1": [
            {
              batch_number: 1,
              time_anchor: null,
              turns: [fivePairBlock],
            },
          ],
        },
      ],
      probing_questions: toPythonLiteral(probingQuestions("1")),
    }

    const canonical = canonicalizeBeamRows("10M", rows)
    const chat = canonical.chats.find((item) => item.chatId === "1")!

    expect(chat.sessions).toHaveLength(5)
    expect(chat.sessions.map((session) => session.sessionId)).toEqual(
      Array.from({ length: 5 }, (_, index) => `beam-10M-1-plan-1-batch-1-turn-${index + 1}`)
    )
    expect(
      chat.sessions.every(
        (session) =>
          session.messages.length === 2 &&
          session.messages[0]?.role === "user" &&
          session.messages[1]?.role === "assistant"
      )
    ).toBe(true)
    expect(chat.sessions.map((session) => session.documentDate)).toEqual(
      Array.from({ length: 5 }, () => "2024-07-01")
    )
    expect(canonical.counts.sessionsWithPaddedAssistant).toBe(0)
  })

  test("pads only the two audited pinned 10M missing-assistant source identities", () => {
    const rows = sourceRows("10M")
    const pair = (label: string) => [
      { role: "user", content: `User ${label}` },
      { role: "assistant", content: `Assistant ${label}` },
    ]
    const incomplete = (literalUserContent: string) => [
      { role: "user", content: `Complete user before ${literalUserContent}` },
      { role: "assistant", content: `Complete assistant before ${literalUserContent}` },
      {
        role: "user",
        content: literalUserContent,
        question_type: "followup_question",
      },
    ]

    rows[0] = {
      conversation_id: "1",
      chat: [
        {
          "plan-7": [
            {
              batch_number: 10,
              time_anchor: null,
              turns: [
                ...Array.from({ length: 18 }, (_, index) => pair(`one-${index + 1}`)),
                incomplete("Literal <dangling user one>"),
              ],
            },
          ],
        },
      ],
      probing_questions: toPythonLiteral(probingQuestions("1")),
    }
    rows[1] = {
      conversation_id: "2",
      chat: [
        {
          "plan-7": [
            {
              batch_number: 8,
              time_anchor: null,
              turns: [
                ...Array.from({ length: 50 }, (_, index) => pair(`two-${index + 1}`)),
                incomplete("Literal <dangling user two>"),
              ],
            },
          ],
        },
      ],
      probing_questions: toPythonLiteral(probingQuestions("2")),
    }

    const canonical = canonicalizeBeamRows("10M", rows)
    const padded = canonical.chats.flatMap((chat) =>
      chat.sessions.filter((session) => session.hasPaddedAssistant)
    )

    expect(canonical.counts.sessionsWithPaddedAssistant).toBe(2)
    expect(padded.map((session) => session.sessionId)).toEqual([
      "beam-10M-1-plan-7-batch-10-turn-20",
      "beam-10M-2-plan-7-batch-8-turn-52",
    ])
    expect(padded.map((session) => session.messages)).toEqual([
      [
        { role: "user", content: "Literal <dangling user one>" },
        { role: "assistant", content: "N/A" },
      ],
      [
        { role: "user", content: "Literal <dangling user two>" },
        { role: "assistant", content: "N/A" },
      ],
    ])
    expect(describeBeamTemporalCoverage({ "10M": canonical.counts }, ["10M"])).toContain(
      `2/${canonical.counts.sessions} use an audited N/A assistant padding`
    )
  })

  test("fails closed when a published flat batch does not alternate user and assistant", () => {
    const rows = sourceRows("1M")
    rows[0].chat = [
      [
        { role: "user", content: "one" },
        { role: "user", content: "two" },
      ],
    ]
    expect(() => canonicalizeBeamRows("1M", rows)).toThrow("must alternate user then assistant")
  })

  test("fails closed for malformed structured 10M message blocks", () => {
    const invalidCases: Array<{ turn: unknown[]; error: string }> = [
      {
        turn: [{ role: "user", content: "missing response" }],
        error: "at least one user message followed by one assistant message",
      },
      {
        turn: [
          { role: "assistant", content: "wrong first role" },
          { role: "user", content: "wrong second role" },
        ],
        error: "must alternate user then assistant",
      },
      {
        turn: [
          { role: "user", content: "first" },
          { role: "assistant", content: "second" },
          { role: "assistant", content: "extra" },
        ],
        error: "must alternate user then assistant",
      },
      {
        turn: [
          { role: "user", content: "first" },
          { role: "assistant", content: "second" },
          { role: "user", content: "unclassified dangling user" },
        ],
        error: "must contain complete user/assistant pairs",
      },
      {
        turn: [
          { role: "user", content: "first" },
          { role: "assistant", content: "second" },
          {
            role: "user",
            content: "classified but identity-mismatched dangling user",
            question_type: "followup_question",
          },
        ],
        error: "10M:1:plan-0:batch-1:source-turn-1",
      },
      {
        turn: [
          { role: "user", content: "first" },
          { role: "assistant", content: "second" },
          { role: "user", content: "third" },
          { role: "assistant", content: "fourth" },
          {
            role: "user",
            content: "unexpected larger odd block",
            question_type: "followup_question",
          },
        ],
        error: "must contain complete user/assistant pairs",
      },
    ]

    for (const invalid of invalidCases) {
      const rows = sourceRows("10M")
      rows[0].chat = [
        {
          batch_number: 1,
          turns: [invalid.turn],
        },
      ]
      expect(() => canonicalizeBeamRows("10M", rows)).toThrow(invalid.error)
    }
  })

  test("rejects structural tampering at an audited padded-assistant identity", () => {
    const rows = sourceRows("10M")
    rows[0].chat = [
      {
        "plan-7": [
          {
            batch_number: 10,
            turns: [
              ...Array.from({ length: 18 }, (_, index) => [
                { role: "user", content: `Prior user ${index}` },
                { role: "assistant", content: `Prior assistant ${index}` },
              ]),
              [
                { role: "user", content: "Complete user" },
                { role: "assistant", content: "Complete assistant" },
                {
                  role: "user",
                  content: "Tampered classification",
                  question_type: "main_question",
                },
              ],
            ],
          },
        ],
      },
    ]

    expect(() => canonicalizeBeamRows("10M", rows)).toThrow(
      "must contain complete user/assistant pairs"
    )
  })

  test("canonical output and IDs are independent of source-row order", () => {
    const rows = sourceRows("1M")
    const forward = canonicalizeBeamRows("1M", rows)
    const reverse = canonicalizeBeamRows("1M", [...rows].reverse())

    expect(serializeBeamJsonl(reverse.chats)).toBe(serializeBeamJsonl(forward.chats))
    expect(serializeBeamJsonl(reverse.questions)).toBe(serializeBeamJsonl(forward.questions))
  })

  test("rejects incomplete tiers before selection", () => {
    expect(() => canonicalizeBeamRows("1M", sourceRows("1M").slice(0, 34))).toThrow(
      "expected 35 chats"
    )
  })

  test("rejects empty rubrics and unknown abilities", () => {
    const emptyRubric = sourceRows("10M")
    ;(
      emptyRubric[0].probing_questions as Record<string, Array<Record<string, unknown>>>
    ).abstention[0].rubric = []
    expect(() => canonicalizeBeamRows("10M", emptyRubric)).toThrow("rubric must be a non-empty")

    const unknown = sourceRows("10M")
    ;(unknown[0].probing_questions as Record<string, unknown[]>).made_up_ability = [
      { question: "Bad", rubric: ["Bad"] },
    ]
    expect(() => canonicalizeBeamRows("10M", unknown)).toThrow("unknown BEAM question type")
  })

  test("uses the first valid message anchor when a batch anchor is invalid", () => {
    const canonical = canonicalizeBeamRows(
      "10M",
      sourceRows("10M", { invalidBatchAnchorWithMessageFallback: true })
    )
    const session = canonical.chats[0].sessions[0]
    expect(session.documentDate).toBe("2024-03-02")
    expect(session.hadInvalidTimeAnchor).toBe(true)
    expect(canonical.counts.sessionsWithInvalidTimeAnchor).toBe(1)
    expect(describeBeamTemporalCoverage({ "10M": canonical.counts }, ["10M"])).toContain(
      "10M: 0/10 sessions without a valid date; 1/10 encountered an invalid source time anchor"
    )
    expect(describeBeamTemporalCoverage({ "10M": canonical.counts }, ["10M"])).toContain(
      "separate, not additive"
    )
  })

  test("strict date parsing rejects impossible dates", () => {
    expect(parseBeamTimeAnchorStrict("March-01-2024")).toBe("2024-03-01")
    expect(parseBeamTimeAnchorStrict("2024-02-29")).toBe("2024-02-29")
    expect(parseBeamTimeAnchorStrict("February-30-2024")).toBeUndefined()
    expect(parseBeamTimeAnchorStrict("2023-02-29")).toBeUndefined()
    expect(parseBeamTimeAnchorStrict(null)).toBeUndefined()
  })

  test("rejects malformed canonical session ordinals, identity, and message pairing", () => {
    const valid = canonicalizeBeamRows("1M", sourceRows("1M"))
    const cases = [
      (chats: typeof valid.chats) => {
        chats[0]!.sessions[0]!.sessionId = ""
      },
      (chats: typeof valid.chats) => {
        chats[0]!.sessions[0]!.sessionId = "arbitrary-session"
      },
      (chats: typeof valid.chats) => {
        chats[0]!.sessions[0]!.batchNumber = -1
      },
      (chats: typeof valid.chats) => {
        chats[0]!.sessions[0]!.messages = [{ role: "assistant", content: "orphan" }]
      },
      (chats: typeof valid.chats) => {
        chats[0]!.sessions[0]!.messages = [
          { role: "assistant", content: "wrong first" },
          { role: "user", content: "wrong second" },
        ]
      },
      (chats: typeof valid.chats) => {
        chats[0]!.sessions[0]!.hasPaddedAssistant = true
      },
    ]

    for (const mutate of cases) {
      const chats = structuredClone(valid.chats)
      mutate(chats)
      expect(() => validateCanonicalBeamTier("1M", chats, valid.questions)).toThrow()
    }
  })
})

describe("BEAM preparation and loading", () => {
  test("publishes a validated snapshot with manifest and completion marker", async () => {
    const outputRoot = await tempRoot()
    const result = await prepareBeamDataset({
      tiers: ["1M"],
      outputRoot,
      fetchImpl: async () => parquetResponse(),
      parquetDecoder: async (_path, tier) => sourceRows(tier),
      unsafeSkipPublishedHashCheckForTests: true,
    })

    const loaded = await loadPreparedBeamTestFixture({
      snapshotPath: result.snapshotPath,
      tiers: ["1M"],
      expectedDatasetFingerprint: result.manifest.datasetFingerprint,
    })
    expect(loaded.manifest.sources[0].sourceIdentity).toBe("injected-test-fixture")
    expect(loaded.manifest.sources[0].revision).toHaveLength(40)
    expect(loaded.chatsByTier["1M"]).toHaveLength(35)
    expect(loaded.questionsByTier["1M"]).toHaveLength(700)
    expect(loaded.manifest.counts["1M"]?.byChat["1"]).toMatchObject({
      sessions: 1,
      questions: 20,
      byQuestionType: expect.objectContaining({ abstention: 2, temporal_reasoning: 2 }),
    })
    expect(loaded.manifest.orderedQuestionIds["1M"]).toHaveLength(700)
    expect(loaded.manifest.orderedChatIdsDigest["1M"]).toMatch(/^[a-f0-9]{64}$/)
    expect(loaded.manifest.orderedQuestionIdsDigest["1M"]).toMatch(/^[a-f0-9]{64}$/)
  })

  test("uses selected-tier identity while retaining enclosing snapshot provenance", async () => {
    const outputRoot = await tempRoot()
    const oneTier = await prepareBeamDataset({
      tiers: ["1M"],
      outputRoot,
      fetchImpl: async () => parquetResponse(),
      parquetDecoder: async (_path, tier) => sourceRows(tier),
      unsafeSkipPublishedHashCheckForTests: true,
    })
    const combined = structuredClone(oneTier.manifest)
    combined.includedTiers = ["1M", "10M"]
    combined.datasetFingerprint = "a".repeat(64)
    combined.manifestHash = "b".repeat(64)
    combined.sources.push({
      ...structuredClone(combined.sources[0]!),
      tier: "10M",
      split: "10M",
    })
    combined.canonicalFiles.push({
      ...structuredClone(combined.canonicalFiles[0]!),
      path: "canonical/10M/chats.jsonl",
    })
    combined.counts["10M"] = structuredClone(combined.counts["1M"]!)
    combined.orderedChatIds["10M"] = ["unused"]
    combined.orderedChatIdsDigest["10M"] = "c".repeat(64)
    combined.orderedQuestionIds["10M"] = ["unused"]
    combined.orderedQuestionIdsDigest["10M"] = "d".repeat(64)

    const standaloneIdentity = createBeamDatasetIdentity(oneTier.manifest, ["1M"])
    const combinedIdentity = createBeamDatasetIdentity(combined, ["1M"])
    expect(combinedIdentity.datasetFingerprint).toBe(standaloneIdentity.datasetFingerprint)
    expect(combinedIdentity.manifestHash).toBe(standaloneIdentity.manifestHash)
    expect(combinedIdentity.sourceFiles).toEqual(standaloneIdentity.sourceFiles)
    expect(combinedIdentity.canonicalFiles).toEqual(standaloneIdentity.canonicalFiles)
    expect(combinedIdentity.snapshotFingerprint).toBe(combined.datasetFingerprint)
    expect(combinedIdentity.snapshotFingerprint).not.toBe(
      standaloneIdentity.snapshotFingerprint
    )
  })

  test("validates every manifest count and ordered identity field", async () => {
    const mutations: Array<{
      message: string
      mutate: (manifest: BeamDatasetManifest) => void
    }> = [
      {
        message: "validated counts do not match manifest",
        mutate(manifest) {
          manifest.counts["1M"]!.byChat["1"]!.questions = 19
        },
      },
      {
        message: "validated counts do not match manifest",
        mutate(manifest) {
          manifest.counts["1M"]!.sessionsWithPaddedAssistant = 1
        },
      },
      {
        message: "chat identity digest does not match manifest",
        mutate(manifest) {
          manifest.orderedChatIdsDigest["1M"] = "0".repeat(64)
        },
      },
      {
        message: "ordered question identity does not match manifest",
        mutate(manifest) {
          manifest.orderedQuestionIds["1M"]![0] = "tampered-question"
        },
      },
    ]

    for (const mutation of mutations) {
      const outputRoot = await tempRoot()
      const result = await prepareBeamDataset({
        tiers: ["1M"],
        outputRoot,
        fetchImpl: async () => parquetResponse(),
        parquetDecoder: async (_path, tier) => sourceRows(tier),
        unsafeSkipPublishedHashCheckForTests: true,
      })
      await rewriteManifest(result.snapshotPath, mutation.mutate)
      await expect(
        loadPreparedBeamTestFixture({ snapshotPath: result.snapshotPath, tiers: ["1M"] })
      ).rejects.toThrow(mutation.message)
    }
  })

  test("ordinary scored-run loading rejects an injected test-source snapshot", async () => {
    const outputRoot = await tempRoot()
    const result = await prepareBeamDataset({
      tiers: ["1M"],
      outputRoot,
      fetchImpl: async () => parquetResponse(),
      parquetDecoder: async (_path, tier) => sourceRows(tier),
      unsafeSkipPublishedHashCheckForTests: true,
    })

    await expect(
      loadPreparedBeamDataset({ snapshotPath: result.snapshotPath, tiers: ["1M"] })
    ).rejects.toThrow("injected test-source identity")
  })

  test("ordinary loading authenticates source bytes against the reviewed published pin", async () => {
    const outputRoot = await tempRoot()
    const result = await prepareBeamDataset({
      tiers: ["1M"],
      outputRoot,
      fetchImpl: async () => parquetResponse(),
      parquetDecoder: async (_path, tier) => sourceRows(tier),
      unsafeSkipPublishedHashCheckForTests: true,
    })
    await rewriteManifest(result.snapshotPath, (manifest) => {
      manifest.sources[0]!.sourceIdentity = "reviewed-published"
    })

    await expect(
      loadPreparedBeamDataset({ snapshotPath: result.snapshotPath, tiers: ["1M"] })
    ).rejects.toThrow("SHA-256 does not match the reviewed published pin")
  })

  test("source-byte identity changes the dataset fingerprint even when canonical rows match", async () => {
    const firstRoot = await tempRoot()
    const secondRoot = await tempRoot()
    const first = await prepareBeamDataset({
      tiers: ["1M"],
      outputRoot: firstRoot,
      fetchImpl: async () => parquetResponse("fixture-a"),
      parquetDecoder: async (_path, tier) => sourceRows(tier),
      unsafeSkipPublishedHashCheckForTests: true,
    })
    const second = await prepareBeamDataset({
      tiers: ["1M"],
      outputRoot: secondRoot,
      fetchImpl: async () => parquetResponse("fixture-b"),
      parquetDecoder: async (_path, tier) => sourceRows(tier),
      unsafeSkipPublishedHashCheckForTests: true,
    })

    expect(second.manifest.canonicalFiles).toEqual(first.manifest.canonicalFiles)
    expect(second.manifest.datasetFingerprint).not.toBe(first.manifest.datasetFingerprint)
  })

  test("detects source and canonical file tampering", async () => {
    for (const target of ["source", "canonical"] as const) {
      const outputRoot = await tempRoot()
      const result = await prepareBeamDataset({
        tiers: ["1M"],
        outputRoot,
        fetchImpl: async () => parquetResponse(),
        parquetDecoder: async (_path, tier) => sourceRows(tier),
        unsafeSkipPublishedHashCheckForTests: true,
      })
      const relativePath =
        target === "source"
          ? result.manifest.sources[0]!.files[0]!.snapshotPath
          : result.manifest.canonicalFiles[0]!.path
      const path = join(result.snapshotPath, relativePath)
      await writeFile(path, flipOneByte(await readFile(path)))

      await expect(
        loadPreparedBeamTestFixture({
          snapshotPath: result.snapshotPath,
          tiers: ["1M"],
        })
      ).rejects.toThrow(`${target} file hash mismatch`)
    }
  })

  test("produces the same fingerprint for shuffled source rows", async () => {
    const firstRoot = await tempRoot()
    const secondRoot = await tempRoot()
    const rows = sourceRows("10M")
    const first = await prepareBeamDataset({
      tiers: ["10M"],
      outputRoot: firstRoot,
      fetchImpl: async () => parquetResponse(),
      parquetDecoder: fixtureDecoder(rows),
      unsafeSkipPublishedHashCheckForTests: true,
    })
    const second = await prepareBeamDataset({
      tiers: ["10M"],
      outputRoot: secondRoot,
      fetchImpl: async () => parquetResponse(),
      parquetDecoder: fixtureDecoder([...rows].reverse()),
      unsafeSkipPublishedHashCheckForTests: true,
    })

    expect(second.manifest.datasetFingerprint).toBe(first.manifest.datasetFingerprint)
    expect(second.manifest.manifestHash).toBe(first.manifest.manifestHash)
  })

  test("re-derives canonical bytes from source instead of trusting the manifest", async () => {
    const outputRoot = await tempRoot()
    const rows = sourceRows("1M")
    const result = await prepareBeamDataset({
      tiers: ["1M"],
      outputRoot,
      fetchImpl: async () => parquetResponse(),
      parquetDecoder: async () => rows,
      unsafeSkipPublishedHashCheckForTests: true,
    })
    const prepared = await loadPreparedBeamTestFixture({
      snapshotPath: result.snapshotPath,
      tiers: ["1M"],
    })
    await expect(
      verifyPreparedBeamSourceDerivation(prepared, ["1M"], async () => rows)
    ).resolves.toBeUndefined()

    const chatsPath = join(result.snapshotPath, "canonical/1M/chats.jsonl")
    const chats = (await readFile(chatsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    chats[0].sessions[0].messages[0].content = "forged but schema-valid transcript"
    const forgedContent = serializeBeamJsonl(chats)
    await writeFile(chatsPath, forgedContent)
    await rewriteManifest(result.snapshotPath, (manifest) => {
      const entry = manifest.canonicalFiles.find(
        (file) => file.path === "canonical/1M/chats.jsonl"
      )!
      const bytes = Buffer.from(forgedContent)
      entry.byteSize = bytes.byteLength
      entry.sha256 = sha256Bytes(bytes)
    })
    const forged = await loadPreparedBeamTestFixture({
      snapshotPath: result.snapshotPath,
      tiers: ["1M"],
    })
    await expect(
      verifyPreparedBeamSourceDerivation(forged, ["1M"], async () => rows)
    ).rejects.toThrow("source-to-canonical derivation mismatch")
  })

  test("fails closed and removes staging output after malformed conversion", async () => {
    const outputRoot = await tempRoot()
    await expect(
      prepareBeamDataset({
        tiers: ["1M"],
        outputRoot,
        fetchImpl: async () => parquetResponse(),
        parquetDecoder: async () => sourceRows("1M").slice(0, 1),
        unsafeSkipPublishedHashCheckForTests: true,
      })
    ).rejects.toThrow("expected 35 chats")

    expect(await readdir(outputRoot)).toEqual([])
  })

  test("validates all bytes before publishing a completion marker", async () => {
    const outputRoot = await tempRoot()
    await expect(
      prepareBeamDataset({
        tiers: ["1M"],
        outputRoot,
        fetchImpl: async () => parquetResponse(),
        parquetDecoder: async (filePath, tier) => {
          await writeFile(filePath, flipOneByte(await readFile(filePath)))
          return sourceRows(tier)
        },
        unsafeSkipPublishedHashCheckForTests: true,
      })
    ).rejects.toThrow("source file hash mismatch")

    expect(await readdir(outputRoot)).toEqual([])
  })

  test("refuses a snapshot without its atomic completion marker", async () => {
    const outputRoot = await tempRoot()
    const result = await prepareBeamDataset({
      tiers: ["10M"],
      outputRoot,
      fetchImpl: async () => parquetResponse(),
      parquetDecoder: fixtureDecoder(sourceRows("10M")),
      unsafeSkipPublishedHashCheckForTests: true,
    })
    await unlink(join(result.snapshotPath, ".complete"))

    await expect(
      loadPreparedBeamTestFixture({
        snapshotPath: result.snapshotPath,
        tiers: ["10M"],
      })
    ).rejects.toThrow("snapshot is incomplete")
  })
})
