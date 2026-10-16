import { generateText, stepCountIs, tool, type LanguageModel } from "ai"
import { z } from "zod"
import type { Provider } from "../../types/provider"
import type { UnifiedQuestion } from "../../types/unified"

const MAX_STEPS = 10
const CHUNK_CHARS = 1200

export interface AgentToolCall {
  tool: "search_memories" | "get_profile"
  args: Record<string, unknown>
  resultIds: string[]
  resultCount: number
}

export interface AgentAnswer {
  text: string
  calls: AgentToolCall[]
  /** Every distinct result the agent saw, in the order it first saw them */
  retrieved: unknown[]
  contextTokensApprox: number
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
}

interface V5Result {
  id?: string
  memory?: string
  chunk?: string
  similarity?: number
  metadata?: { sessionDate?: string; sessionId?: string }
}

function formatResults(results: V5Result[]): string {
  if (results.length === 0) return "No results."
  return results
    .map((r, i) => {
      const kind = r.memory !== undefined ? "memory" : "chunk"
      const text = (r.memory ?? r.chunk ?? "").slice(0, CHUNK_CHARS)
      const date = r.metadata?.sessionDate ? `, said on ${r.metadata.sessionDate}` : ""
      return `${i + 1}. (${kind}${date}, relevance ${(r.similarity ?? 0).toFixed(2)}) ${text}`
    })
    .join("\n")
}

function systemPrompt(memoriesOnly: boolean, rules: string): string {
  return `You answer a question about a user using their long-term memory, stored in Supermemory. You cannot see the conversations; you can only search them with the tools. Search as many times as you need (up to ${MAX_STEPS - 1} tool calls), then answer.

Tools:
- search_memories: semantic search. Results come back in relevance order, each with the date it was said.${
    memoriesOnly
      ? "\n  Only learned memories (short extracted facts) are available, not the original conversation text."
      : `
  mode "memories" returns short extracted facts; "chunks" returns original conversation text (exact wording, numbers, code, long explanations); "hybrid" returns both.`
  }
  limit: how many results (10 is a good default; 20-30 when you need many items).
  rerank: "order" reorders by relevance; "aggregate" also merges overlapping results.
  rewrite: expands vague queries.
  include_related: also returns earlier and later versions of each memory (useful for updates and contradictions).
- get_profile: the user's standing facts, preferences and instructions. Use it for questions about how the user wants things done.

What works best, by kind of question:
- A single fact (a number, name, version, date): one focused query${memoriesOnly ? "" : '; if the memory lacks the exact detail, search mode "chunks"'}.
- Order of events, progress over time, summaries: split the topic into several narrower queries (one per step, phase or sub-topic) with limit 20, collect every relevant item with its date, then order by date.
- Time between two events: search each event separately to find its own date, then compute the difference explicitly.
- Updated or changed information: search with include_related true and look for the latest value; dates tell you which is newer.
- Possible contradictions ("have I ever...", "did I..."): search for both the positive and the negative statement.
- Preferences and instructions: call get_profile and search for the specific preference.
- If a search does not answer the question, try again: rephrase the query, use different keywords from what you found${memoriesOnly ? "" : ", switch mode"}, raise the limit, or turn on rewrite. Do not give up after one search.

Answer only from what the tools returned. Do not invent details.

Answer rules:
${rules}`
}

export async function answerWithAgent(input: {
  model: LanguageModel
  provider: Provider
  containerTag: string
  question: UnifiedQuestion
  rules: string
  memoriesOnly: boolean
  temperature?: number
  maxOutputTokens: number
}): Promise<AgentAnswer> {
  const { provider, containerTag, memoriesOnly } = input
  const calls: AgentToolCall[] = []
  const seen = new Map<string, unknown>()
  let contextChars = 0

  const modes = memoriesOnly ? (["memories"] as const) : (["hybrid", "memories", "chunks"] as const)
  const tools = {
    search_memories: tool({
      description:
        "Search the user's memory. Returns results in relevance order with the date each was said.",
      inputSchema: z.object({
        query: z.string().describe("What to look for"),
        mode: z
          .enum(modes as unknown as [string, ...string[]])
          .optional()
          .describe("Default hybrid"),
        limit: z.number().int().min(1).max(50).optional().describe("Default 10"),
        rerank: z.enum(["none", "order", "aggregate"]).optional(),
        rewrite: z.boolean().optional(),
        include_related: z.boolean().optional(),
      }),
      execute: async ({ query, mode, limit, rerank, rewrite, include_related }) => {
        const settings: Record<string, unknown> = {
          searchMode: memoriesOnly ? "memories" : (mode ?? "hybrid"),
          limit: limit ?? 10,
          ...(rerank ? { rerank } : {}),
          ...(rewrite !== undefined ? { rewriteQuery: rewrite } : {}),
          ...(include_related ? { include: { related: true } } : {}),
        }
        const results = (await provider.search(query, { containerTag, settings })) as V5Result[]
        for (const r of results) if (r.id && !seen.has(r.id)) seen.set(r.id, r)
        calls.push({
          tool: "search_memories",
          args: { query, ...settings },
          resultIds: results.map((r) => r.id ?? ""),
          resultCount: results.length,
        })
        const text = formatResults(results)
        contextChars += text.length
        return text
      },
    }),
    get_profile: tool({
      description: "The user's standing facts, preferences and instructions.",
      inputSchema: z.object({}),
      execute: async () => {
        const p = provider.profile
          ? await provider.profile(containerTag)
          : { static: [], dynamic: [] }
        calls.push({
          tool: "get_profile",
          args: {},
          resultIds: [],
          resultCount: p.static.length + p.dynamic.length,
        })
        const text = [
          "Standing facts:",
          ...p.static.map((m) => `- ${m}`),
          "Recent context:",
          ...p.dynamic.map((m) => `- ${m}`),
        ].join("\n")
        contextChars += text.length
        return text
      },
    }),
  }

  const result = await generateText({
    model: input.model,
    system: systemPrompt(memoriesOnly, input.rules),
    prompt: `Question: ${input.question.question}`,
    tools,
    stopWhen: stepCountIs(MAX_STEPS),
    maxOutputTokens: input.maxOutputTokens,
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
  })

  let text = result.text.trim()
  if (!text) {
    // The step budget ran out on a tool call: ask for the answer from what was found
    const final = await generateText({
      model: input.model,
      system: systemPrompt(memoriesOnly, input.rules),
      messages: [
        { role: "user", content: `Question: ${input.question.question}` },
        ...result.response.messages,
        { role: "user", content: "No more searches. Answer the question now from what you found." },
      ],
      maxOutputTokens: input.maxOutputTokens,
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    })
    text = final.text.trim()
  }

  return {
    text,
    calls,
    retrieved: [...seen.values()],
    contextTokensApprox: Math.round(contextChars / 4),
    usage: result.totalUsage ?? {},
  }
}
