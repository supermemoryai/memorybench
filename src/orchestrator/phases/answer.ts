import { readFileSync, existsSync } from "fs"
import { spawn } from "child_process"
import { createOpenAI } from "@ai-sdk/openai"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { generateText } from "ai"
import type { Benchmark } from "../../types/benchmark"
import type { RunCheckpoint } from "../../types/checkpoint"
import type { Provider } from "../../types/provider"
import { CheckpointManager } from "../checkpoint"
import { config } from "../../utils/config"
import { logger } from "../../utils/logger"
import { getModelConfig, ModelConfig, DEFAULT_ANSWERING_MODEL } from "../../utils/models"
import { buildDefaultAnswerPrompt } from "../../prompts/defaults"
import { buildContextString } from "../../types/prompts"
import { shouldStop } from "../../server/runState"

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
            '--max-budget-usd', '1.00',  // Allow $1 per answer (generous)
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

type LanguageModel = ReturnType<typeof createOpenAI> | ReturnType<typeof createAnthropic> | ReturnType<typeof createGoogleGenerativeAI>

function getAnsweringModel(modelAlias: string): { client: LanguageModel | null; modelConfig: ModelConfig } {
    const modelConfig = getModelConfig(modelAlias || DEFAULT_ANSWERING_MODEL)

    switch (modelConfig.provider) {
        case "openai":
            return {
                client: createOpenAI({ apiKey: config.openaiApiKey }),
                modelConfig,
            }
        case "anthropic":
            return {
                client: createAnthropic({ apiKey: config.anthropicApiKey }),
                modelConfig,
            }
        case "google":
            return {
                client: createGoogleGenerativeAI({ apiKey: config.googleApiKey }),
                modelConfig,
            }
        case "cli":
            // CLI uses subprocess instead of API client
            return {
                client: null,
                modelConfig,
            }
    }
}

function buildAnswerPrompt(question: string, context: unknown[], questionDate?: string, provider?: Provider): string {
    if (provider?.prompts?.answerPrompt) {
        const customPrompt = provider.prompts.answerPrompt
        if (typeof customPrompt === "function") {
            return customPrompt(question, context, questionDate)
        }
        const contextStr = buildContextString(context)
        return customPrompt
            .replace("{{question}}", question)
            .replace("{{questionDate}}", questionDate || "Not specified")
            .replace("{{context}}", contextStr)
    }

    return buildDefaultAnswerPrompt(question, context, questionDate)
}

export async function runAnswerPhase(
    benchmark: Benchmark,
    checkpoint: RunCheckpoint,
    checkpointManager: CheckpointManager,
    questionIds?: string[],
    provider?: Provider
): Promise<void> {
    const questions = benchmark.getQuestions()
    const targetQuestions = questionIds
        ? questions.filter(q => questionIds.includes(q.questionId))
        : questions

    const { client, modelConfig } = getAnsweringModel(checkpoint.answeringModel)

    logger.info(`Generating answers for ${targetQuestions.length} questions using ${modelConfig.displayName} (${modelConfig.id})...`)

    for (let i = 0; i < targetQuestions.length; i++) {
        // Check for stop signal
        if (shouldStop(checkpoint.runId)) {
            logger.info(`Run ${checkpoint.runId} stopped by user`)
            throw new Error(`Run stopped by user. Resume with the same run ID.`)
        }

        const question = targetQuestions[i]

        const status = checkpointManager.getPhaseStatus(checkpoint, question.questionId, "answer")
        if (status === "completed") {
            logger.debug(`Skipping ${question.questionId} - already answered`)
            continue
        }

        const searchStatus = checkpointManager.getPhaseStatus(checkpoint, question.questionId, "search")
        if (searchStatus !== "completed") {
            logger.warn(`Skipping ${question.questionId} - not yet searched`)
            continue
        }

        const resultFile = checkpoint.questions[question.questionId].phases.search.resultFile
        if (!resultFile || !existsSync(resultFile)) {
            logger.warn(`Skipping ${question.questionId} - result file not found`)
            continue
        }

        const startTime = Date.now()
        checkpointManager.updatePhase(checkpoint, question.questionId, "answer", {
            status: "in_progress",
            startedAt: new Date().toISOString(),
        })

        try {
            const searchData = JSON.parse(readFileSync(resultFile, "utf8"))
            const context: unknown[] = searchData.results || []
            const questionDate = checkpoint.questions[question.questionId]?.questionDate

            const prompt = buildAnswerPrompt(question.question, context, questionDate, provider)

            let text: string

            if (modelConfig.provider === "cli") {
                // Use CLI subprocess for Claude models
                text = await generateTextViaCli(prompt, modelConfig.id)
            } else {
                // Use AI SDK for API-based models
                const params: Record<string, unknown> = {
                    model: client!(modelConfig.id),
                    prompt,
                    maxTokens: modelConfig.defaultMaxTokens,
                }

                if (modelConfig.supportsTemperature) {
                    params.temperature = modelConfig.defaultTemperature
                }

                const result = await generateText(params as Parameters<typeof generateText>[0])
                text = result.text
            }

            const durationMs = Date.now() - startTime
            checkpointManager.updatePhase(checkpoint, question.questionId, "answer", {
                status: "completed",
                hypothesis: text.trim(),
                completedAt: new Date().toISOString(),
                durationMs,
            })

            logger.progress(i + 1, targetQuestions.length, `Answered ${question.questionId} (${durationMs}ms)`)
        } catch (e) {
            const error = e instanceof Error ? e.message : String(e)
            checkpointManager.updatePhase(checkpoint, question.questionId, "answer", {
                status: "failed",
                error,
            })
            logger.error(`Failed to answer ${question.questionId}: ${error}`)
            throw new Error(`Answer failed at ${question.questionId}: ${error}. Fix the issue and resume with the same run ID.`)
        }
    }

    logger.success("Answer phase complete")
}
