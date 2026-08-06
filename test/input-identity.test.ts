import { describe, expect, test } from "bun:test"
import type { Benchmark } from "../src/types/benchmark"
import type { UnifiedQuestion, UnifiedSession } from "../src/types/unified"
import { legacyBenchmarkProtocol } from "../src/protocols/legacy"
import {
  canonicalizeSelectedQuestionIds,
  fingerprintSelectedBenchmarkInput,
  resolveEffectiveDatasetRevision,
} from "../src/orchestrator/input-identity"
import { stableSha256 } from "../src/utils/stable"

function question(questionId: string, text = `Question ${questionId}`): UnifiedQuestion {
  return {
    questionId,
    question: text,
    questionType: "test",
    groundTruth: `Answer ${questionId}`,
    haystackSessionIds: ["session-1"],
    metadata: { fixture: true },
  }
}

function session(content = "Shared user content", metadata: Record<string, unknown> = {}) {
  return [
    {
      sessionId: "session-1",
      messages: [
        { role: "user" as const, content },
        { role: "assistant" as const, content: "Shared assistant content" },
      ],
      metadata,
    },
  ]
}

function benchmark(input: {
  questions: UnifiedQuestion[]
  sessionsByQuestion: Record<string, UnifiedSession[]>
  groups?: Record<string, string>
}): Benchmark {
  return {
    name: "legacy-fixture",
    scope: { displayName: "Legacy fixture", includedTiers: [], coverage: "full" },
    protocol: legacyBenchmarkProtocol,
    async load() {},
    getQuestions() {
      return input.questions
    },
    getHaystackSessions(questionId) {
      return input.sessionsByQuestion[questionId] ?? []
    },
    getGroundTruth(questionId) {
      return input.questions.find((value) => value.questionId === questionId)?.groundTruth ?? ""
    },
    getQuestionTypes() {
      return { test: { id: "test", alias: "test", description: "Test" } }
    },
    getIngestionGroupId: input.groups
      ? (questionId) => input.groups![questionId] ?? questionId
      : undefined,
  }
}

describe("selected benchmark input identity", () => {
  test("persists the enclosing snapshot fingerprint as the effective revision", () => {
    expect(resolveEffectiveDatasetRevision(undefined, undefined)).toBeUndefined()
    expect(resolveEffectiveDatasetRevision("configured", undefined)).toBe("configured")
    expect(
      resolveEffectiveDatasetRevision("configured", {
        datasetFingerprint: "resolved-fingerprint",
        snapshotFingerprint: "snapshot-fingerprint",
        manifestHash: "manifest",
        manifestSchemaVersion: 1,
        canonicalSchemaVersion: 1,
        converterVersion: "1",
        converterImplementationHash: "converter",
        includedTiers: ["1M"],
        counts: {},
        orderedQuestionIdsDigest: {},
        sourceFiles: [],
        canonicalFiles: [],
        sources: [],
      })
    ).toBe("snapshot-fingerprint")
  })

  test("canonicalizes identical ID sets independently of caller order and detects set drift", () => {
    const questions = [question("q1"), question("q2"), question("q3")]
    const forward = canonicalizeSelectedQuestionIds(questions, ["q1", "q3"])
    const reverse = canonicalizeSelectedQuestionIds(questions, ["q3", "q1"])

    expect(forward).toEqual(["q1", "q3"])
    expect(reverse).toEqual(forward)
    expect(stableSha256(reverse)).toBe(stableSha256(forward))
    expect(stableSha256(canonicalizeSelectedQuestionIds(questions, ["q1", "q2"]))).not.toBe(
      stableSha256(forward)
    )
    const sharedSessions = session()
    const fixture = benchmark({
      questions,
      sessionsByQuestion: { q1: sharedSessions, q2: sharedSessions, q3: sharedSessions },
    })
    expect(fingerprintSelectedBenchmarkInput(fixture, [questions[2], questions[0]])).toBe(
      fingerprintSelectedBenchmarkInput(fixture, [questions[0], questions[2]])
    )
    expect(() => canonicalizeSelectedQuestionIds(questions, ["q1", "q1"])).toThrow("duplicates")
  })

  test("changes for question or raw haystack drift and rejects declared group collisions", () => {
    const questions = [question("q1"), question("q2")]
    const sharedSessions = session()
    const base = benchmark({
      questions,
      sessionsByQuestion: { q1: sharedSessions, q2: sharedSessions },
      groups: { q1: "chat-1", q2: "chat-1" },
    })
    const baseFingerprint = fingerprintSelectedBenchmarkInput(base, questions)

    const changedQuestion = [question("q1", "Changed question"), question("q2")]
    expect(
      fingerprintSelectedBenchmarkInput(
        benchmark({
          questions: changedQuestion,
          sessionsByQuestion: { q1: sharedSessions, q2: sharedSessions },
          groups: { q1: "chat-1", q2: "chat-1" },
        }),
        changedQuestion
      )
    ).not.toBe(baseFingerprint)

    const changedSessions = session("Changed user content")
    expect(
      fingerprintSelectedBenchmarkInput(
        benchmark({
          questions,
          sessionsByQuestion: { q1: changedSessions, q2: changedSessions },
          groups: { q1: "chat-1", q2: "chat-1" },
        }),
        questions
      )
    ).not.toBe(baseFingerprint)

    expect(() =>
      fingerprintSelectedBenchmarkInput(
        benchmark({
          questions,
          sessionsByQuestion: { q1: sharedSessions, q2: changedSessions },
          groups: { q1: "chat-1", q2: "chat-1" },
        }),
        questions
      )
    ).toThrow("different raw benchmark haystacks")
  })

  test("serializes one shared raw haystack once rather than once per question", () => {
    let metadataReads = 0
    const metadata: Record<string, unknown> = {}
    Object.defineProperty(metadata, "probe", {
      enumerable: true,
      get() {
        metadataReads++
        return "value"
      },
    })
    const sharedSessions = session("Shared", metadata)
    const questions = Array.from({ length: 20 }, (_, index) => question(`q${index + 1}`))
    const fixture = benchmark({
      questions,
      sessionsByQuestion: Object.fromEntries(
        questions.map((value) => [value.questionId, sharedSessions])
      ),
    })

    fingerprintSelectedBenchmarkInput(fixture, questions)
    expect(metadataReads).toBe(2)
  })
})
