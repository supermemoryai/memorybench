import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { createOpenAI } from "@ai-sdk/openai"
import { extractMemories } from "../prompts/extraction"
import { OpenAIJudge } from "./openai"
import { AnthropicJudge } from "./anthropic"
import { GoogleJudge } from "./google"

const http: { fetch: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> } = globalThis
const input = {
  question: "What is the answer?",
  questionType: "single-session",
  groundTruth: "Example",
  hypothesis: "Example",
}

afterEach(() => mock.restore())

test.each([
  { name: "OpenAI", judge: new OpenAIJudge(), body: { max_output_tokens: 1000 } },
  { name: "Anthropic", judge: new AnthropicJudge(), body: { max_tokens: 1000 } },
  {
    name: "Google",
    judge: new GoogleJudge(),
    body: { generationConfig: { maxOutputTokens: 1000 } },
  },
])("$name sends its configured output limit", async ({ judge, body }) => {
  const fetchMock = spyOn(http, "fetch").mockImplementation(async () =>
    Response.json({ error: { message: "Test request captured" } }, { status: 400 })
  )
  await judge.initialize({ apiKey: "test-key" })

  await expect(judge.evaluate(input)).rejects.toThrow()
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject(body)
})

test("memory extraction sends its configured output limit", async () => {
  const fetchMock = spyOn(http, "fetch").mockImplementation(async () =>
    Response.json({ error: { message: "Test request captured" } }, { status: 400 })
  )
  const openai = createOpenAI({ apiKey: "test-key" })

  await expect(extractMemories(openai, { sessionId: "example", messages: [] })).rejects.toThrow()
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
    max_output_tokens: 2000,
  })
})
