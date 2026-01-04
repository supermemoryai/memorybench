import type { Judge, JudgeName } from "../types/judge"
import { OpenAIJudge } from "./openai"
import { AnthropicJudge } from "./anthropic"
import { GoogleJudge } from "./google"
import { CliJudge } from "./cli"

const judges: Record<JudgeName, new () => Judge> = {
    openai: OpenAIJudge,
    anthropic: AnthropicJudge,
    google: GoogleJudge,
    cli: CliJudge,
}

export function createJudge(name: JudgeName): Judge {
    const JudgeClass = judges[name]
    if (!JudgeClass) {
        throw new Error(`Unknown judge: ${name}. Available: ${Object.keys(judges).join(", ")}`)
    }
    return new JudgeClass()
}

export function getAvailableJudges(): JudgeName[] {
    return Object.keys(judges) as JudgeName[]
}

export { OpenAIJudge, AnthropicJudge, GoogleJudge, CliJudge }
export { buildJudgePrompt, parseJudgeResponse, getJudgePrompt } from "./base"
