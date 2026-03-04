import { spawn } from "child_process"
import type { Judge, JudgeConfig, JudgeInput, JudgeResult } from "../types/judge"
import type { ProviderPrompts } from "../types/prompts"
import { buildJudgePrompt, parseJudgeResponse, getJudgePrompt } from "./base"
import { logger } from "../utils/logger"
import { getModelConfig, ModelConfig } from "../utils/models"

/**
 * Call Claude CLI in print mode for text generation.
 * Uses subprocess to avoid API key requirements.
 */
async function generateTextViaCli(prompt: string, modelAlias: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const claude = spawn('claude', [
            '-p', prompt,
            '--output-format', 'json',
            '--model', modelAlias,
            '--max-budget-usd', '1.00',  // Allow $1 per evaluation (generous)
        ], {
            timeout: 180000,  // 3 minute timeout
            cwd: process.cwd(),
        })

        let stdout = ''
        let stderr = ''

        claude.stdout.on('data', (data) => { stdout += data })
        claude.stderr.on('data', (data) => { stderr += data })

        claude.on('close', (code) => {
            if (code === 0) {
                try {
                    const response = JSON.parse(stdout)
                    resolve(response.result?.trim() || '')
                } catch {
                    resolve(stdout.trim())
                }
            } else {
                reject(new Error(`Claude CLI exited with code ${code}: ${stderr}`))
            }
        })

        claude.on('error', reject)
    })
}

export class CliJudge implements Judge {
    name = "cli"
    private modelConfig: ModelConfig | null = null
    private modelAlias: string = "sonnet"

    async initialize(config: JudgeConfig): Promise<void> {
        // For CLI, apiKey is ignored - we use the locally authenticated `claude` command
        const modelAlias = config.model || "sonnet"
        this.modelAlias = modelAlias
        this.modelConfig = getModelConfig(modelAlias)
        logger.info(`Initialized CLI judge with model: ${this.modelConfig.displayName} (${this.modelConfig.id})`)
    }

    async evaluate(input: JudgeInput): Promise<JudgeResult> {
        if (!this.modelConfig) throw new Error("Judge not initialized")

        const prompt = buildJudgePrompt(input)
        const text = await generateTextViaCli(prompt, this.modelConfig.id)

        return parseJudgeResponse(text)
    }

    getPromptForQuestionType(questionType: string, providerPrompts?: ProviderPrompts): string {
        return getJudgePrompt(questionType, providerPrompts)
    }

    getModel(): import("ai").LanguageModel {
        // CLI doesn't use AI SDK LanguageModel - throw if called
        throw new Error("CLI judge does not expose an AI SDK model")
    }
}

export default CliJudge
