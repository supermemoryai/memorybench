# Judges

LLM-as-judge implementations. Each judge implements the `Judge` interface.

## Interface

```typescript
interface Judge {
    name: string
    initialize(config: JudgeConfig): Promise<void>
    evaluate(input: JudgeInput): Promise<JudgeResult>
    getPromptForQuestionType(questionType: string, providerPrompts?: ProviderPrompts): string
    getModel(): LanguageModel
}
```

## Adding a Judge

1. Create `src/judges/myjudge.ts`
2. Implement `Judge` interface
3. Register in `src/judges/index.ts`
4. Add to `JudgeName` type in `src/types/judge.ts`
5. Add default model in `src/utils/models.ts` (`DEFAULT_JUDGE_MODELS`)

**Required returns:**
- `initialize()` - Set up client with API key and model
- `evaluate()` - Return `{ score: 0|1, label: "correct"|"incorrect", explanation: string }`
- `getPromptForQuestionType()` - Return prompt string for question type
- `getModel()` - Return the initialized LanguageModel

**Use these helpers from `./base.ts`:**
- `buildJudgePrompt(input)` - Builds full prompt from JudgeInput
- `parseJudgeResponse(text)` - Extracts JudgeResult from LLM response

## Models

Add model config in `src/utils/models.ts`:

```typescript
interface ModelConfig {
    id: string
    provider: "openai" | "anthropic" | "google"
    displayName: string
    supportsTemperature: boolean
    defaultTemperature: number
    defaultMaxTokens: number
}
```

`defaultMaxTokens` is passed to the AI SDK as `maxOutputTokens`, which the SDK maps to each
provider's own parameter — there is no per-provider parameter name to configure. Give
reasoning/thinking models a roomy value: their reasoning tokens are billed against the same
ceiling, so a tight cap can be spent before any visible answer is produced.

## Provider-Specific Prompts

Providers can override judge prompts. See [providers/README.md](../providers/README.md#custom-prompts).

## Existing Judges

| Judge | SDK | Default Model |
|-------|-----|---------------|
| `openai` | `@ai-sdk/openai` | gpt-4o |
| `anthropic` | `@ai-sdk/anthropic` | sonnet-4 |
| `google` | `@ai-sdk/google` | gemini-2.5-flash |
