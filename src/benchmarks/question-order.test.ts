import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"

// Captured before the mock is installed so the real module can be restored for
// any other test file in the same run.
const realFs = { ...(await import("fs")) }

/**
 * Directory listing handed back by the mocked `readdirSync`, deliberately out of
 * lexicographic order. This is what an ext4 directory with `dir_index` looks
 * like: entries come back in hash order, not sorted. NTFS and APFS happen to
 * return something close to sorted, which is why the bug hides on a maintainer's
 * machine and shows up on CI.
 */
const UNSORTED_LISTING = ["q3.json", "q1.json", "q10.json", "q2.json"]

/** questionId per file, so a selection can be traced back to its source file. */
const QUESTION_IDS: Record<string, string> = {
  "q1.json": "q1",
  "q2.json": "q2",
  "q3.json": "q3",
  "q10.json": "q10",
}

function longMemEvalItem(questionId: string) {
  return {
    question_id: questionId,
    question: `question ${questionId}?`,
    question_type: "single-session-user",
    answer: `answer ${questionId}`,
    question_date: "2023/05/20 (Sat) 02:21",
    haystack_dates: ["2023/05/20 (Sat) 02:21"],
    haystack_sessions: [[{ role: "user", content: `content ${questionId}` }]],
  }
}

const locomoConversation = {
  sample_id: "conv-1",
  conversation: {
    speaker_a: "Alice",
    speaker_b: "Bob",
    session_1_date_time: "1:00 pm on 20 May, 2023",
    session_1: [
      { speaker: "Alice", text: "hello", dia_id: "D1:1" },
      { speaker: "Bob", text: "hi", dia_id: "D1:2" },
    ],
  },
  qa: [
    { question: "who said hello?", answer: "Alice", category: 1, evidence: ["D1:1"] },
    { question: "who replied?", answer: "Bob", category: 1, evidence: ["D1:2"] },
  ],
}

const convoMemItems = [
  {
    category: "assistant_memory",
    item: {
      question: "what did they order?",
      answer: "a flat white",
      conversations: [{ messages: [{ speaker: "User", text: "I ordered a flat white" }] }],
      message_evidences: [0],
    },
  },
  {
    category: "assistant_memory",
    item: {
      question: "where from?",
      answer: "the corner cafe",
      conversations: [{ messages: [{ speaker: "User", text: "from the corner cafe" }] }],
      message_evidences: [0],
    },
  },
]

/** Serves each benchmark's on-disk layout without touching a real filesystem. */
function installFsMock(): void {
  mock.module("fs", () => ({
    ...realFs,
    existsSync: () => true,
    mkdirSync: () => undefined,
    writeFileSync: () => undefined,
    readdirSync: () => [...UNSORTED_LISTING],
    readFileSync: (path: string) => {
      const file = String(path).split(/[\\/]/).pop() ?? ""

      const questionId = QUESTION_IDS[file]
      if (questionId) return JSON.stringify(longMemEvalItem(questionId))

      if (file.startsWith("locomo")) return JSON.stringify([locomoConversation])
      if (file.startsWith("convomem")) return JSON.stringify(convoMemItems)

      return "{}"
    },
  }))
}

installFsMock()

afterAll(() => {
  mock.module("fs", () => realFs)
})

beforeEach(() => {
  installFsMock()
})

describe("LongMemEvalBenchmark question order", () => {
  async function loadBenchmark() {
    const { LongMemEvalBenchmark } = await import("./longmemeval/index")
    const benchmark = new LongMemEvalBenchmark()
    await benchmark.load()
    return benchmark
  }

  test("returns questions in a stable order regardless of directory order", async () => {
    const benchmark = await loadBenchmark()

    // Lexicographic by filename: q1.json, q10.json, q2.json, q3.json. Without the
    // sort this is the filesystem's order (q3, q1, q10, q2).
    expect(benchmark.getQuestions().map((q) => q.questionId)).toEqual(["q1", "q10", "q2", "q3"])
  })

  test("`--limit N` selects the same subset on any filesystem", async () => {
    const benchmark = await loadBenchmark()

    // This is the slice the orchestrator takes for a limited run. On the
    // unsorted listing it would have been ["q3", "q1"] — a different pair of
    // questions, and so a different, incomparable accuracy number.
    const limited = benchmark.getQuestions().slice(0, 2)
    expect(limited.map((q) => q.questionId)).toEqual(["q1", "q10"])
  })

  test("sessions stay attached to their question", async () => {
    const benchmark = await loadBenchmark()

    for (const questionId of ["q1", "q2", "q3", "q10"]) {
      const sessions = benchmark.getHaystackSessions(questionId)
      expect(sessions).toHaveLength(1)
      expect(sessions[0].sessionId).toBe(`${questionId}-session-0`)
      expect(sessions[0].messages[0].content).toBe(`content ${questionId}`)
    }
  })

  test("loading twice does not duplicate questions", async () => {
    const { LongMemEvalBenchmark } = await import("./longmemeval/index")
    const benchmark = new LongMemEvalBenchmark()

    await benchmark.load()
    const first = benchmark.getQuestions().map((q) => q.questionId)
    await benchmark.load()
    const second = benchmark.getQuestions().map((q) => q.questionId)

    expect(second).toEqual(first)
    expect(new Set(second).size).toBe(second.length)
  })
})

describe("LoCoMoBenchmark", () => {
  test("loading twice does not duplicate questions", async () => {
    const { LoCoMoBenchmark } = await import("./locomo/index")
    const benchmark = new LoCoMoBenchmark()

    await benchmark.load()
    const first = benchmark.getQuestions().map((q) => q.questionId)
    await benchmark.load()
    const second = benchmark.getQuestions().map((q) => q.questionId)

    expect(first).toEqual(["conv-1-q0", "conv-1-q1"])
    expect(second).toEqual(first)
    expect(new Set(second).size).toBe(second.length)
  })

  test("keeps ground truth and sessions intact across a reload", async () => {
    const { LoCoMoBenchmark } = await import("./locomo/index")
    const benchmark = new LoCoMoBenchmark()

    await benchmark.load()
    await benchmark.load()

    expect(benchmark.getGroundTruth("conv-1-q0")).toBe("Alice")
    expect(benchmark.getHaystackSessions("conv-1-q0")).toHaveLength(1)
  })
})

describe("ConvoMemBenchmark", () => {
  test("loading twice does not duplicate questions", async () => {
    const { ConvoMemBenchmark } = await import("./convomem/index")
    const benchmark = new ConvoMemBenchmark()

    await benchmark.load()
    const first = benchmark.getQuestions().map((q) => q.questionId)
    await benchmark.load()
    const second = benchmark.getQuestions().map((q) => q.questionId)

    expect(first).toHaveLength(convoMemItems.length)
    expect(second).toEqual(first)
    expect(new Set(second).size).toBe(second.length)
  })
})
