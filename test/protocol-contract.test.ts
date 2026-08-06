import { describe, expect, test } from "bun:test"
import { createBenchmark, getAvailableBenchmarks } from "../src/benchmarks"
import type { Benchmark, BenchmarkName } from "../src/types/benchmark"
import { CHECKPOINT_SCHEMA_VERSION, type RunCheckpoint } from "../src/types/checkpoint"
import type { BenchmarkProtocol, ProtocolIdentity } from "../src/types/protocol"
import type { UnifiedQuestion, UnifiedSession } from "../src/types/unified"
import { BeamPaperProtocol } from "../src/protocols/beam-paper"
import { legacyBenchmarkProtocol } from "../src/protocols/legacy"
import { prepareValidatedBuildPlans } from "../src/orchestrator/builds"
import { assertResumeIdentity, resolveEffectiveRetrievalTopK } from "../src/orchestrator"
import { fingerprintProviderPrompts } from "../src/providers/prompt-identity"
import { resolveAnsweringRuntimeIdentity } from "../src/utils/models"

function beamQuestion(): UnifiedQuestion {
  return {
    questionId: "beam:test:chat:abstention:question",
    question: "What should be remembered?",
    questionType: "abstention",
    groundTruth: "Nothing",
    haystackSessionIds: ["s1", "s2"],
    metadata: { rubric: ["The answer should abstain when evidence is absent"] },
  }
}

function legacyQuestion(): UnifiedQuestion {
  return {
    questionId: "legacy-question",
    question: "What happened?",
    questionType: "legacy-type",
    groundTruth: "An event",
    haystackSessionIds: ["s1", "s2"],
    metadata: { rubric: ["Array-valued rubric metadata must not select BEAM"] },
  }
}

function sessions(): UnifiedSession[] {
  return [
    {
      sessionId: "s1",
      messages: [
        { role: "user", content: "First message" },
        { role: "assistant", content: "First response" },
      ],
      metadata: { documentDate: "2024-01-01", date: "2024-01-01" },
    },
    {
      sessionId: "s2",
      messages: [
        { role: "user", content: "Second message" },
        { role: "assistant", content: "Second response" },
      ],
      metadata: { documentDate: "2024-01-02", date: "2024-01-02" },
    },
  ]
}

function fakeBenchmark(input: {
  name: string
  protocol: BenchmarkProtocol
  question: UnifiedQuestion
}): Benchmark {
  return {
    name: input.name,
    scope: { displayName: "Fake benchmark", includedTiers: [], coverage: "full" },
    protocol: input.protocol,
    async load() {},
    getQuestions() {
      return [input.question]
    },
    getHaystackSessions() {
      return sessions()
    },
    getGroundTruth() {
      return input.question.groundTruth
    },
    getQuestionTypes() {
      return {
        [input.question.questionType]: {
          id: input.question.questionType,
          alias: input.question.questionType,
          description: "Test",
        },
      }
    },
    getIngestionGroupId() {
      return "shared-chat"
    },
  }
}

function cloneProtocolIdentity(
  identity: ProtocolIdentity,
  changes: Partial<ProtocolIdentity>
): ProtocolIdentity {
  return { ...identity, ...changes }
}

function protocolWithIdentity(
  base: BenchmarkProtocol,
  identity: ProtocolIdentity
): BenchmarkProtocol {
  return {
    identity,
    auxiliaryRetrievalEvaluation: base.auxiliaryRetrievalEvaluation,
    ingestionExecutionPolicy: base.ingestionExecutionPolicy,
    requiredJudge: base.requiredJudge,
    validateQuestion: base.validateQuestion.bind(base),
    createIngestionPlan: base.createIngestionPlan.bind(base),
    createRetrievalPlan: base.createRetrievalPlan.bind(base),
    createAnswerPlan: base.createAnswerPlan.bind(base),
    evaluateQuestion: base.evaluateQuestion.bind(base),
    aggregateQuality: base.aggregateQuality.bind(base),
  }
}

class SameBytesChangedBeamIngestionProtocol extends BeamPaperProtocol {
  override createIngestionPlan(input: Parameters<BenchmarkProtocol["createIngestionPlan"]>[0]) {
    return super.createIngestionPlan(input).map((document) => ({
      ...document,
      metadata: { ...document.metadata },
      messages: document.messages ? [...document.messages] : undefined,
    }))
  }
}

function buildPlan(
  benchmark: Benchmark,
  question: UnifiedQuestion,
  providerPromptFingerprint = "prompt-v1"
) {
  return prepareValidatedBuildPlans({
    benchmark,
    questions: [question],
    provider: "fake-provider",
    providerAdapterVersion: "adapter-v1",
    providerPromptFingerprint,
    providerIngestionConfigFingerprint: "ingestion-config-v1",
    dataSourceRunId: "source-run",
  })[0]
}

function checkpoint(protocolIdentity: ProtocolIdentity): RunCheckpoint {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    runId: "resume-run",
    dataSourceRunId: "resume-run",
    status: "running",
    provider: "fake-provider",
    providerAdapterVersion: "adapter-v1",
    providerPromptFingerprint: "prompt-v1",
    benchmark: "renamed-benchmark",
    benchmarkScope: {
      displayName: "Renamed benchmark",
      includedTiers: ["1M"],
      coverage: "subset",
    },
    selectedQuestionIdsDigest: "selected-question-digest",
    benchmarkInputFingerprint: "benchmark-input-digest",
    protocolIdentity,
    judge: "gpt-4.1-mini",
    answeringModel: "answer-model",
    answeringRuntimeIdentity: resolveAnsweringRuntimeIdentity("answer-model"),
    retrievalTopK: 5,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    buildPhaseAttempts: [],
    builds: {},
    questions: {},
  }
}

function resumeInput(protocolIdentity: ProtocolIdentity) {
  return {
    provider: "fake-provider",
    providerAdapterVersion: "adapter-v1",
    providerPromptFingerprint: "prompt-v1",
    benchmark: "renamed-benchmark",
    benchmarkScope: {
      displayName: "Renamed benchmark",
      includedTiers: ["1M"],
      coverage: "subset" as const,
    },
    datasetIdentity: undefined,
    selectedQuestionIdsDigest: "selected-question-digest",
    benchmarkInputFingerprint: "benchmark-input-digest",
    protocolIdentity,
    retrievalTopK: 5,
    judge: "gpt-4.1-mini",
    answeringModel: "answer-model",
    answeringRuntimeIdentity: resolveAnsweringRuntimeIdentity("answer-model"),
  }
}

describe("benchmark registry scope", () => {
  test("exposes only the explicit supported BEAM scope identifiers", () => {
    expect(getAvailableBenchmarks()).toContain("beam-1m")
    expect(getAvailableBenchmarks()).toContain("beam-10m")
    expect(getAvailableBenchmarks()).toContain("beam-1m-10m")
    expect(getAvailableBenchmarks()).not.toContain("beam" as BenchmarkName)

    expect(createBenchmark("beam-1m").name).toBe("beam-1m")
    expect(createBenchmark("beam-10m").name).toBe("beam-10m")
    expect(createBenchmark("beam-1m-10m").name).toBe("beam-1m-10m")
    expect(() => createBenchmark("beam" as BenchmarkName)).toThrow("Unknown benchmark: beam")
  })
})

describe("explicit protocol ownership", () => {
  test("a renamed benchmark remains BEAM when it explicitly owns BeamPaperProtocol", () => {
    const protocol = new BeamPaperProtocol({ retrievalTopK: 5 })
    const value = beamQuestion()
    const benchmark = fakeBenchmark({
      name: "completely-renamed-benchmark",
      protocol,
      question: value,
    })

    expect(benchmark.name.startsWith("beam")).toBe(false)
    expect(benchmark.protocol.identity.id).toBe("beam-paper")
    expect(benchmark.protocol.createRetrievalPlan({ question: value }).requestedTopK).toBe(5)
    expect(buildPlan(benchmark, value).documents[0].content).toStartWith(
      "DOCUMENT_DATE: 2024-01-01"
    )
  })

  test("BEAM ingestion projects provider-visible messages to role and content only", () => {
    const protocol = new BeamPaperProtocol()
    const value = beamQuestion()
    const source = sessions()
    source[0]!.messages[0] = {
      ...source[0]!.messages[0]!,
      speaker: "source-user",
      timestamp: "2024-01-01T12:34:56Z",
    }

    const [document] = protocol.createIngestionPlan({ question: value, sessions: source })
    expect(document!.messages).toEqual([
      { role: "user", content: "First message" },
      { role: "assistant", content: "First response" },
    ])
    expect(document!.content).toBe(
      "DOCUMENT_DATE: 2024-01-01\n\n[USER]\nFirst message\n\n[ASSISTANT]\nFirst response"
    )
  })

  test("a BEAM-looking legacy benchmark with array rubric remains Legacy", () => {
    const value = legacyQuestion()
    const benchmark = fakeBenchmark({
      name: "beam-lookalike",
      protocol: legacyBenchmarkProtocol,
      question: value,
    })

    expect(Array.isArray(value.metadata?.rubric)).toBe(true)
    expect(benchmark.protocol.identity.id).toBe("memorybench.legacy")
    expect(benchmark.protocol.createRetrievalPlan({ question: value }).requestedTopK).toBe(10)
    expect(buildPlan(benchmark, value).documents[0].content).toContain(
      "session as a stringified JSON"
    )
  })
})

describe("resume protocol identity", () => {
  test("accepts a byte-identical runtime identity", () => {
    const identity = new BeamPaperProtocol({ retrievalTopK: 5 }).identity
    expect(() => assertResumeIdentity(checkpoint(identity), resumeInput(identity))).not.toThrow()
  })

  test("rejects protocol, protocol-config, retrieval-config, and adapter drift", () => {
    const identity = new BeamPaperProtocol({ retrievalTopK: 5 }).identity
    const cases: Array<{
      expected: string
      mutate: (input: ReturnType<typeof resumeInput>) => void
    }> = [
      {
        expected: "benchmark protocol",
        mutate(input) {
          input.protocolIdentity = cloneProtocolIdentity(identity, { id: "other-protocol" })
        },
      },
      {
        expected: "benchmark protocol",
        mutate(input) {
          input.protocolIdentity = cloneProtocolIdentity(identity, {
            configFingerprint: "changed-config",
          })
        },
      },
      {
        expected: "retrieval Top-K",
        mutate(input) {
          input.retrievalTopK = 10
        },
      },
      {
        expected: "provider adapter version",
        mutate(input) {
          input.providerAdapterVersion = "adapter-v2"
        },
      },
      {
        expected: "answering runtime",
        mutate(input) {
          input.answeringRuntimeIdentity = {
            ...input.answeringRuntimeIdentity,
            modelId: "changed-effective-model-id",
          }
        },
      },
    ]

    for (const item of cases) {
      const input = resumeInput(identity)
      item.mutate(input)
      expect(() => assertResumeIdentity(checkpoint(identity), input)).toThrow(item.expected)
    }
  })

  test("rejects legacy provider-prompt drift while BEAM ignores unused provider prompts", () => {
    const legacyCheckpoint = checkpoint(legacyBenchmarkProtocol.identity)
    const legacyInput = resumeInput(legacyBenchmarkProtocol.identity)
    legacyInput.providerPromptFingerprint = "prompt-v2"
    expect(() => assertResumeIdentity(legacyCheckpoint, legacyInput)).toThrow("provider prompt")

    const beamIdentity = new BeamPaperProtocol({ retrievalTopK: 5 }).identity
    const beamInput = resumeInput(beamIdentity)
    beamInput.providerPromptFingerprint = "prompt-v2"
    expect(() => assertResumeIdentity(checkpoint(beamIdentity), beamInput)).not.toThrow()
  })

  test("rejects schema-v3 checkpoints with missing effective input or answering identity", () => {
    const identity = new BeamPaperProtocol({ retrievalTopK: 5 }).identity
    const missingRuntime = checkpoint(identity) as Partial<RunCheckpoint>
    delete missingRuntime.answeringRuntimeIdentity
    expect(() =>
      assertResumeIdentity(missingRuntime as RunCheckpoint, resumeInput(identity))
    ).toThrow("answering runtime")

    const missingInput = checkpoint(identity) as Partial<RunCheckpoint>
    delete missingInput.benchmarkInputFingerprint
    expect(() =>
      assertResumeIdentity(missingInput as RunCheckpoint, resumeInput(identity))
    ).toThrow("benchmark input")
  })
})

describe("effective retrieval identity", () => {
  test("resolves the BEAM default to 5 when the CLI option is omitted", () => {
    const protocol = new BeamPaperProtocol()
    expect(resolveEffectiveRetrievalTopK(protocol, [beamQuestion()])).toBe(5)
  })

  test("records a supported override and rejects configuration/plan disagreement", () => {
    const protocol = new BeamPaperProtocol({ retrievalTopK: 20 })
    expect(resolveEffectiveRetrievalTopK(protocol, [beamQuestion()], 20)).toBe(20)
    expect(() => resolveEffectiveRetrievalTopK(protocol, [beamQuestion()], 10)).toThrow(
      "differs from protocol plan"
    )
  })
})

describe("provider prompt identity", () => {
  test("is deterministic and changes for prompt strings or function source", () => {
    const first = fingerprintProviderPrompts({
      answerPrompt: "Answer {{question}}",
      judgePrompt: (question) => ({ default: `Judge ${question}` }),
    })
    const same = fingerprintProviderPrompts({
      answerPrompt: "Answer {{question}}",
      judgePrompt: (question) => ({ default: `Judge ${question}` }),
    })
    const changedString = fingerprintProviderPrompts({
      answerPrompt: "Changed {{question}}",
      judgePrompt: (question) => ({ default: `Judge ${question}` }),
    })
    const changedFunction = fingerprintProviderPrompts({
      answerPrompt: "Answer {{question}}",
      judgePrompt: (question) => ({ default: `Strictly judge ${question}` }),
    })

    expect(same).toBe(first)
    expect(changedString).not.toBe(first)
    expect(changedFunction).not.toBe(first)
  })
})

describe("build identity includes only protocol ingestion identity", () => {
  test("answer and judge prompt drift does not change legacy or BEAM builds", () => {
    const legacyValue = legacyQuestion()
    const legacy = fakeBenchmark({
      name: "legacy",
      protocol: legacyBenchmarkProtocol,
      question: legacyValue,
    })
    expect(buildPlan(legacy, legacyValue, "prompt-v2").buildFingerprint).toBe(
      buildPlan(legacy, legacyValue, "prompt-v1").buildFingerprint
    )

    const beamValue = beamQuestion()
    const beam = fakeBenchmark({
      name: "beam",
      protocol: new BeamPaperProtocol(),
      question: beamValue,
    })
    expect(buildPlan(beam, beamValue, "prompt-v2").buildFingerprint).toBe(
      buildPlan(beam, beamValue, "prompt-v1").buildFingerprint
    )
  })

  test("BEAM Top-K changes full protocol identity but not build or haystack identity", () => {
    const value = beamQuestion()
    const topK5 = new BeamPaperProtocol({ retrievalTopK: 5 })
    const topK10 = new BeamPaperProtocol({ retrievalTopK: 10 })
    const first = buildPlan(
      fakeBenchmark({ name: "renamed", protocol: topK5, question: value }),
      value
    )
    const second = buildPlan(
      fakeBenchmark({ name: "renamed", protocol: topK10, question: value }),
      value
    )

    expect(topK10.identity.configFingerprint).not.toBe(topK5.identity.configFingerprint)
    expect(topK10.identity.retrievalPolicyHash).not.toBe(topK5.identity.retrievalPolicyHash)
    expect(topK10.identity.ingestionPolicyHash).toBe(topK5.identity.ingestionPolicyHash)
    expect(second.haystack.fingerprint).toBe(first.haystack.fingerprint)
    expect(second.buildFingerprint).toBe(first.buildFingerprint)
    expect(second.buildId).toBe(first.buildId)
  })

  test("non-ingestion implementation drift does not change the build", () => {
    const value = beamQuestion()
    const base = new BeamPaperProtocol({ retrievalTopK: 5 })
    const changedImplementation = protocolWithIdentity(
      base,
      cloneProtocolIdentity(base.identity, {
        implementationFingerprint: "changed-implementation",
      })
    )
    const first = buildPlan(
      fakeBenchmark({ name: "renamed", protocol: base, question: value }),
      value
    )
    const second = buildPlan(
      fakeBenchmark({ name: "renamed", protocol: changedImplementation, question: value }),
      value
    )

    expect(second.haystack.fingerprint).toBe(first.haystack.fingerprint)
    expect(second.buildFingerprint).toBe(first.buildFingerprint)
  })

  test("an ingestion method change changes the build even when emitted bytes match", () => {
    const value = beamQuestion()
    const base = new BeamPaperProtocol({ retrievalTopK: 5 })
    const changedIngestion = new SameBytesChangedBeamIngestionProtocol({ retrievalTopK: 5 })
    const first = buildPlan(
      fakeBenchmark({ name: "renamed", protocol: base, question: value }),
      value
    )
    const second = buildPlan(
      fakeBenchmark({ name: "renamed", protocol: changedIngestion, question: value }),
      value
    )

    expect(changedIngestion.identity.ingestionPolicyHash).not.toBe(
      base.identity.ingestionPolicyHash
    )
    expect(second.haystack.fingerprint).toBe(first.haystack.fingerprint)
    expect(second.buildFingerprint).not.toBe(first.buildFingerprint)
    expect(second.buildId).not.toBe(first.buildId)
  })
})
