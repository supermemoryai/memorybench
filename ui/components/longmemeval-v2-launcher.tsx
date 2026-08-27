"use client"

import { useEffect, useMemo, useState } from "react"
import { SingleSelect } from "@/components/single-select"
import {
  getLongMemEvalV2Options,
  startLongMemEvalV2Preflight,
  startLongMemEvalV2Run,
  type LongMemEvalV2OptionsResponse,
  type LongMemEvalV2RunThrough,
} from "@/lib/api"
import {
  parseLongMemEvalV2QuestionIds,
  toStartLongMemEvalV2RunParams,
  validateLongMemEvalV2Launch,
  type LongMemEvalV2LaunchValues,
} from "@/lib/longmemeval-v2-form"

interface SelectOption {
  value: string
  label: string
  sublabel?: string
}

interface LongMemEvalV2LauncherProps {
  onStarted: (runId: string) => void
  modelOptions?: SelectOption[]
}

const inputClass =
  "w-full rounded border border-[#333333] bg-[#222222] px-3 py-2.5 text-sm text-text-primary placeholder-text-muted focus:border-accent focus:outline-none"

const fallbackModels: SelectOption[] = [
  { value: "gpt-5", label: "GPT-5", sublabel: "Reasoning model · benchmark default" },
  { value: "gpt-5.2", label: "GPT-5.2", sublabel: "Reasoning model" },
  { value: "gpt-5-mini", label: "GPT-5 Mini", sublabel: "Reasoning model" },
  { value: "gpt-4.1", label: "GPT-4.1", sublabel: "No reasoning control" },
  { value: "gpt-4.1-mini", label: "GPT-4.1 Mini", sublabel: "No reasoning control" },
  { value: "gpt-4o", label: "GPT-4o (Legacy)", sublabel: "No reasoning control" },
  { value: "gpt-4o-mini", label: "GPT-4o Mini (Legacy)", sublabel: "No reasoning control" },
]

const runThroughOptions: SelectOption[] = [
  { value: "plan", label: "Plan only", sublabel: "Offline validation; no API calls" },
  { value: "build", label: "Ingest memories", sublabel: "Build and index selected haystacks" },
  { value: "query", label: "Retrieve", sublabel: "Build, then save retrieval results" },
  {
    value: "evaluate",
    label: "Answer and evaluate",
    sublabel: "Save per-question scores; no aggregate report",
  },
  { value: "run", label: "Full report", sublabel: "Complete pipeline and report" },
]

const reasoningOptions: SelectOption[] = ["none", "minimal", "low", "medium", "high", "xhigh"].map(
  (value) => ({ value, label: value.charAt(0).toUpperCase() + value.slice(1) })
)

function generateRunId(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "")
  const random = Math.random().toString(36).slice(2, 6)
  return `lme-v2-${date}-${random}`
}

function supportsReasoning(model: string): boolean {
  return /^(?:gpt-5|o1|o3|o4)/i.test(model)
}

function availableHaystacks(
  options: LongMemEvalV2OptionsResponse | null,
  tier: LongMemEvalV2LaunchValues["tier"],
  domain: LongMemEvalV2LaunchValues["domain"]
): number | null {
  return options?.haystacks[tier][domain] ?? null
}

export function LongMemEvalV2Launcher({
  onStarted,
  modelOptions = fallbackModels,
}: LongMemEvalV2LauncherProps) {
  const supportedModels = useMemo(() => {
    const allowed = new Set(fallbackModels.map((model) => model.value))
    const discovered = modelOptions.filter((model) => allowed.has(model.value))
    return discovered.length > 1 ? discovered : fallbackModels
  }, [modelOptions])
  const [values, setValues] = useState<LongMemEvalV2LaunchValues>(() => ({
    runId: generateRunId(),
    provider: "supermemory",
    datasetPath: "",
    tier: "small",
    allowMedium: false,
    domain: "all",
    selectionMode: "all-haystacks",
    haystackLimit: 1,
    questionIds: "",
    canary: false,
    topK: 20,
    evidenceTopK: 20,
    readerModel: "gpt-5",
    evaluatorModel: "gpt-5",
    reasoningEffort: "high",
    evaluatorReasoningEffort: "high",
    buildConcurrency: 2,
    questionConcurrency: 5,
    trajectoryConcurrency: 4,
    maxInFlightRequests: 20,
    indexingTimeoutMinutes: 30,
    maxTrajectoryAttempts: 4,
    strictIngestion: false,
    runThrough: "plan",
    allowFullRun: false,
    forceBuild: false,
    freshQuery: false,
  }))
  const [options, setOptions] = useState<LongMemEvalV2OptionsResponse | null>(null)
  const [optionsLoading, setOptionsLoading] = useState(true)
  const [optionsError, setOptionsError] = useState<string | null>(null)
  const [showSetup, setShowSetup] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [preflightSubmitting, setPreflightSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getLongMemEvalV2Options()
      .then((response) => {
        if (cancelled) return
        const preparedDataset = response.datasets.find((dataset) => dataset.prepared)
        setOptions(response)
        setValues((current) => ({
          ...current,
          datasetPath:
            response.defaults.datasetPath ?? preparedDataset?.path ?? current.datasetPath,
          provider: response.defaults.provider,
          tier: response.defaults.tier,
          domain: response.defaults.domain,
          topK: response.defaults.topK,
          evidenceTopK: response.defaults.evidenceTopK,
          readerModel: response.defaults.readerModel,
          evaluatorModel: response.defaults.evaluatorModel,
          reasoningEffort: response.defaults.reasoningEffort,
          evaluatorReasoningEffort: response.defaults.reasoningEffort,
          buildConcurrency: response.defaults.buildConcurrency,
          questionConcurrency: response.defaults.questionConcurrency,
          trajectoryConcurrency: response.defaults.trajectoryConcurrency,
          maxInFlightRequests: response.defaults.maxInFlightRequests,
          indexingTimeoutMinutes: response.defaults.indexingTimeoutMs / 60_000,
          maxTrajectoryAttempts: response.defaults.maxTrajectoryAttempts,
          strictIngestion: response.defaults.strictIngestion,
        }))
      })
      .catch((cause) => {
        if (!cancelled) {
          setOptionsError(
            cause instanceof Error ? cause.message : "Could not inspect local prerequisites"
          )
        }
      })
      .finally(() => {
        if (!cancelled) setOptionsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const questionCount =
    values.selectionMode === "questions"
      ? parseLongMemEvalV2QuestionIds(values.questionIds).length
      : 0
  const haystackCount = availableHaystacks(options, values.tier, values.domain)
  const requestedHaystacks =
    values.selectionMode === "haystack-limit" ? values.haystackLimit : haystackCount
  const isFullScopeLiveRun =
    values.selectionMode === "all-haystacks" && values.runThrough !== "plan"
  const selectedDataset = options?.datasets.find(
    (dataset) => dataset.path === values.datasetPath.trim()
  )
  const selectedProvider = options?.providers.find((provider) => provider.name === values.provider)
  const preflightCoversTopK =
    options?.preflight.status === "passing" && (options.preflight.testedTopK ?? 0) >= values.topK
  const capability = values.canary
    ? selectedProvider?.capabilities.query
    : values.runThrough === "plan"
      ? selectedProvider?.capabilities.plan
      : values.runThrough === "build"
        ? selectedProvider?.capabilities.build
        : values.runThrough === "query"
          ? selectedProvider?.capabilities.query
          : values.runThrough === "evaluate"
            ? selectedProvider?.capabilities.evaluate
            : selectedProvider?.capabilities.report
  const liveStageBlocked =
    values.runThrough !== "plan" &&
    (capability !== true ||
      selectedDataset?.prepared === false ||
      (selectedProvider?.requiresPreflight && !preflightCoversTopK))
  const setupReady =
    Boolean(selectedDataset?.prepared) &&
    Boolean(selectedProvider?.configured) &&
    Boolean(options?.credentials.openAIConfigured) &&
    (!selectedProvider?.requiresPreflight || preflightCoversTopK)

  function updateDatasetSlice(next: Partial<Pick<LongMemEvalV2LaunchValues, "tier" | "domain">>) {
    setValues((current) => {
      const tier = next.tier ?? current.tier
      const domain = next.domain ?? current.domain
      const count = availableHaystacks(options, tier, domain)
      return {
        ...current,
        ...next,
        allowMedium: tier === "medium" ? current.allowMedium : false,
        haystackLimit: count ? Math.min(current.haystackLimit, count) : current.haystackLimit,
        allowFullRun: false,
      }
    })
  }

  async function handlePreflight() {
    if (preflightSubmitting || options?.preflightActivity.status === "running") return
    try {
      setPreflightSubmitting(true)
      setOptionsError(null)
      await startLongMemEvalV2Preflight(values.topK)
      for (let attempt = 0; attempt < 240; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, attempt === 0 ? 500 : 2_000))
        const next = await getLongMemEvalV2Options()
        setOptions(next)
        if (next.preflightActivity.status === "passed") return
        if (next.preflightActivity.status === "failed") {
          throw new Error(next.preflightActivity.error)
        }
      }
      throw new Error("Preflight did not finish within the bounded eight-minute UI wait")
    } catch (cause) {
      setOptionsError(cause instanceof Error ? cause.message : "Supermemory preflight failed")
    } finally {
      setPreflightSubmitting(false)
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    const validationError = validateLongMemEvalV2Launch(values)
    if (validationError) {
      setError(validationError)
      return
    }
    if (
      values.selectionMode === "haystack-limit" &&
      haystackCount !== null &&
      values.haystackLimit > haystackCount
    ) {
      setError(
        `Only ${haystackCount} exact haystack${haystackCount === 1 ? " is" : "s are"} available`
      )
      return
    }
    if (liveStageBlocked) {
      setError("Live prerequisites are not ready. Open Setup details or use Plan only.")
      return
    }
    try {
      setSubmitting(true)
      setError(null)
      const response = await startLongMemEvalV2Run(toStartLongMemEvalV2RunParams(values))
      onStarted(response.runId || values.runId.trim())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to start LongMemEval-V2 run")
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="rounded border border-accent/25 bg-accent/5 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="font-display text-lg font-semibold text-text-primary">
                LongMemEval-V2
              </h2>
              <span className="badge bg-accent/15 text-accent">build-aware</span>
            </div>
            <p className="mt-1 max-w-2xl text-sm text-text-secondary">
              Choose the haystacks, models, and stopping point. MemoryBench reuses each exact
              ingested haystack across all of its questions.
            </p>
          </div>
          <span className="text-xs text-text-muted">
            {selectedProvider?.displayName ?? values.provider} memory layer
          </span>
        </div>
      </div>

      <section className="space-y-3 rounded border border-[#333333] p-4">
        <SectionTitle
          number="1"
          title="Choose the memory provider"
          description="Only adapters with safe build isolation can run live."
        />
        <SingleSelect
          label="Memory provider"
          options={(options?.providers ?? []).map((provider) => ({
            value: provider.name,
            label: provider.displayName,
            sublabel: provider.note,
          }))}
          selected={values.provider}
          onChange={(provider) =>
            setValues((current) => ({
              ...current,
              provider: provider as LongMemEvalV2LaunchValues["provider"],
              runThrough:
                options?.providers.find((candidate) => candidate.name === provider)
                  ?.adapterAvailable === false
                  ? "plan"
                  : current.runThrough,
              allowFullRun: false,
              forceBuild: false,
              freshQuery: false,
            }))
          }
          wide
        />
        {selectedProvider && (
          <div
            className={`rounded border px-3 py-2 text-xs ${
              selectedProvider.adapterAvailable
                ? "border-border text-text-secondary"
                : "border-status-warning/30 bg-status-warning/5 text-status-warning"
            }`}
          >
            {selectedProvider.note} Search: {selectedProvider.searchMode}; reranking{" "}
            {selectedProvider.rerank ? "on" : "off"}.
          </div>
        )}
      </section>

      <div className="rounded border border-[#333333]">
        <button
          type="button"
          onClick={() => setShowSetup((visible) => !visible)}
          className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
          aria-expanded={showSetup}
        >
          <span>
            <span className="block text-sm font-medium text-text-primary">
              {optionsLoading
                ? "Checking setup…"
                : setupReady
                  ? "Setup ready"
                  : "Setup needs attention"}
            </span>
            <span className="block text-xs text-text-muted">
              Dataset, server keys, screenshots, and live-service preflight
            </span>
          </span>
          <span className={setupReady ? "badge badge-success" : "badge badge-warning"}>
            {setupReady ? "Ready" : "Details"}
          </span>
        </button>
        {showSetup && (
          <div className="space-y-4 border-t border-[#333333] p-4">
            {options && (
              <div className="grid gap-2 sm:grid-cols-4">
                <PrerequisiteBadge label="Dataset" ready={Boolean(selectedDataset?.prepared)} />
                <PrerequisiteBadge
                  label={`${selectedProvider?.displayName ?? "Provider"} setup`}
                  ready={Boolean(selectedProvider?.configured)}
                />
                <PrerequisiteBadge
                  label="OpenAI key"
                  ready={options.credentials.openAIConfigured}
                />
                <PrerequisiteBadge
                  label={selectedProvider?.requiresPreflight ? "Preflight" : "No preflight needed"}
                  ready={!selectedProvider?.requiresPreflight || preflightCoversTopK}
                />
              </div>
            )}
            <div>
              <label className="mb-2 block text-sm font-medium text-text-primary">
                Prepared dataset
              </label>
              {options?.datasets.map((dataset) => (
                <button
                  key={dataset.path}
                  type="button"
                  onClick={() =>
                    setValues((current) => ({ ...current, datasetPath: dataset.path }))
                  }
                  className={`mb-2 flex w-full items-center justify-between gap-3 rounded border px-3 py-2 text-left text-xs ${
                    values.datasetPath === dataset.path
                      ? "border-accent bg-accent/5"
                      : "border-border hover:border-[#444444]"
                  }`}
                >
                  <span className="min-w-0 truncate font-mono text-text-secondary">
                    {dataset.path}
                  </span>
                  <span
                    className={dataset.prepared ? "badge badge-success" : "badge badge-warning"}
                  >
                    {dataset.prepared ? "prepared" : "incomplete"}
                  </span>
                </button>
              ))}
              <input
                className={`${inputClass} font-mono`}
                value={values.datasetPath}
                onChange={(event) =>
                  setValues((current) => ({ ...current, datasetPath: event.target.value }))
                }
                aria-label="Prepared dataset path"
                spellCheck={false}
              />
            </div>
            {selectedProvider?.requiresPreflight && (
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={handlePreflight}
                  disabled={preflightSubmitting || options?.preflightActivity.status === "running"}
                  className="btn btn-secondary text-sm disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {preflightSubmitting || options?.preflightActivity.status === "running"
                    ? "Running bounded preflight…"
                    : `Run live preflight (Top K ${values.topK})`}
                </button>
                <span className="text-xs text-text-muted">
                  Synthetic probes only; exact probe document IDs are deleted.
                </span>
              </div>
            )}
            {(optionsError || options?.preflightActivity.status === "failed") && (
              <p className="text-xs text-status-error">
                {optionsError ??
                  (options?.preflightActivity.status === "failed"
                    ? options.preflightActivity.error
                    : "")}
              </p>
            )}
          </div>
        )}
      </div>

      <div>
        <label className="mb-2 block text-sm font-medium text-text-primary" htmlFor="lme-run-id">
          Run ID
        </label>
        <input
          id="lme-run-id"
          className={`${inputClass} font-mono`}
          value={values.runId}
          onChange={(event) => setValues((current) => ({ ...current, runId: event.target.value }))}
          autoComplete="off"
        />
      </div>

      <section className="space-y-4 rounded border border-[#333333] p-4">
        <SectionTitle
          number="2"
          title="Choose the data"
          description="Every selected haystack stays complete."
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-2 block text-sm font-medium text-text-primary">Dataset tier</label>
            <SingleSelect
              label="Dataset tier"
              options={[
                { value: "small", label: "Small", sublabel: "2 exact haystacks" },
                { value: "medium", label: "Medium", sublabel: "447 exact haystacks · high cost" },
              ]}
              selected={values.tier}
              onChange={(tier) =>
                updateDatasetSlice({ tier: tier as LongMemEvalV2LaunchValues["tier"] })
              }
            />
          </div>
          <div>
            <label className="mb-2 block text-sm font-medium text-text-primary">Domain</label>
            <SingleSelect
              label="Domain"
              options={[
                { value: "all", label: "All domains" },
                { value: "web", label: "Web" },
                { value: "enterprise", label: "Enterprise" },
              ]}
              selected={values.domain}
              onChange={(domain) =>
                updateDatasetSlice({ domain: domain as LongMemEvalV2LaunchValues["domain"] })
              }
            />
          </div>
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-text-primary">Selection</label>
          <div className="flex flex-wrap gap-2">
            {(
              [
                ["all-haystacks", "All haystacks"],
                ["haystack-limit", "Limit haystacks"],
                ["questions", "Specific questions"],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() =>
                  setValues((current) => ({
                    ...current,
                    selectionMode: mode,
                    canary: mode === "questions" ? current.canary : false,
                    allowFullRun: false,
                  }))
                }
                className={`rounded border px-3 py-2 text-sm transition-colors ${
                  values.selectionMode === mode
                    ? "border-accent bg-accent/10 text-text-primary"
                    : "border-[#333333] text-text-secondary hover:border-[#444444]"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {values.selectionMode === "haystack-limit" && (
          <div className="rounded bg-bg-elevated/60 p-3">
            <label
              className="mb-2 block text-sm font-medium text-text-primary"
              htmlFor="lme-haystacks"
            >
              Complete haystacks to select
            </label>
            <div className="flex items-center gap-3">
              <input
                id="lme-haystacks"
                type="number"
                min="1"
                max={haystackCount ?? undefined}
                className={`${inputClass} w-28`}
                value={values.haystackLimit}
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    haystackLimit: Number(event.target.value),
                  }))
                }
              />
              <span className="text-sm text-text-secondary">
                of {haystackCount ?? "?"} available
              </span>
            </div>
            <p className="mt-2 text-xs text-text-muted">
              Uses the first N exact haystacks in pinned dataset order. Every chosen haystack keeps
              all of its trajectories and all linked questions.
            </p>
          </div>
        )}

        {values.selectionMode === "questions" && (
          <div>
            <label
              className="mb-2 block text-sm font-medium text-text-primary"
              htmlFor="lme-question-ids"
            >
              Question IDs
            </label>
            <textarea
              id="lme-question-ids"
              className={`${inputClass} min-h-20 resize-y font-mono`}
              value={values.questionIds}
              onChange={(event) =>
                setValues((current) => ({ ...current, questionIds: event.target.value }))
              }
              placeholder="One or more IDs, separated by commas or new lines"
              spellCheck={false}
            />
            <p className="mt-1 text-xs text-text-muted">
              {questionCount} selected. Each question still receives its complete exact haystack.
            </p>
          </div>
        )}

        <div className="rounded border border-border bg-bg-primary/40 px-3 py-2 text-sm text-text-secondary">
          {values.selectionMode === "questions"
            ? `${questionCount} specific question${questionCount === 1 ? "" : "s"}`
            : `${requestedHaystacks ?? "?"} exact haystack${requestedHaystacks === 1 ? "" : "s"}`}
          {values.tier === "small" && values.selectionMode !== "questions"
            ? " · 100 trajectories per haystack"
            : ""}
        </div>

        {values.tier === "medium" && (
          <label className="flex items-start gap-3 rounded border border-status-warning/30 bg-status-warning/5 p-3">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-[#267bf1]"
              checked={values.allowMedium}
              onChange={(event) =>
                setValues((current) => ({ ...current, allowMedium: event.target.checked }))
              }
            />
            <span className="text-sm text-status-warning">
              I understand the medium tier can create many builds and substantial provider cost.
            </span>
          </label>
        )}
      </section>

      <section className="space-y-4 rounded border border-[#333333] p-4">
        <SectionTitle
          number="3"
          title="Choose models and stopping point"
          description="Models affect cache identity and cost."
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-2 block text-sm font-medium text-text-primary">Reader model</label>
            <SingleSelect
              label="Reader model"
              options={supportedModels}
              selected={values.readerModel}
              onChange={(readerModel) =>
                setValues((current) => ({
                  ...current,
                  readerModel,
                  reasoningEffort: supportsReasoning(readerModel)
                    ? current.reasoningEffort === "none"
                      ? "high"
                      : current.reasoningEffort
                    : "none",
                }))
              }
              wide
            />
          </div>
          <div>
            <label className="mb-2 block text-sm font-medium text-text-primary">
              Evaluator model
            </label>
            <SingleSelect
              label="Evaluator model"
              options={supportedModels}
              selected={values.evaluatorModel}
              onChange={(evaluatorModel) =>
                setValues((current) => ({
                  ...current,
                  evaluatorModel,
                  evaluatorReasoningEffort: supportsReasoning(evaluatorModel)
                    ? current.evaluatorReasoningEffort === "none"
                      ? "high"
                      : current.evaluatorReasoningEffort
                    : "none",
                }))
              }
              wide
            />
          </div>
        </div>
        <div>
          <label className="mb-2 block text-sm font-medium text-text-primary">Run until</label>
          <SingleSelect
            label="Run until"
            options={runThroughOptions.filter(
              (option) => !values.canary || option.value === "query"
            )}
            selected={values.canary ? "query" : values.runThrough}
            onChange={(runThrough) =>
              setValues((current) => ({
                ...current,
                runThrough: runThrough as LongMemEvalV2RunThrough,
                allowFullRun: false,
              }))
            }
            wide
            dropUp
          />
        </div>
      </section>

      <div className="rounded border border-[#333333]">
        <button
          type="button"
          onClick={() => setShowAdvanced((visible) => !visible)}
          className="flex w-full items-center justify-between px-4 py-3 text-sm text-text-secondary hover:text-text-primary"
          aria-expanded={showAdvanced}
        >
          <span>Advanced settings</span>
          <span>{showAdvanced ? "Hide" : "Show"}</span>
        </button>
        {showAdvanced && (
          <div className="space-y-5 border-t border-[#333333] p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <ModelReasoning
                label="Reader reasoning"
                model={values.readerModel}
                value={values.reasoningEffort}
                onChange={(reasoningEffort) =>
                  setValues((current) => ({
                    ...current,
                    reasoningEffort:
                      reasoningEffort as LongMemEvalV2LaunchValues["reasoningEffort"],
                  }))
                }
              />
              <ModelReasoning
                label="Evaluator reasoning"
                model={values.evaluatorModel}
                value={values.evaluatorReasoningEffort}
                onChange={(evaluatorReasoningEffort) =>
                  setValues((current) => ({
                    ...current,
                    evaluatorReasoningEffort:
                      evaluatorReasoningEffort as LongMemEvalV2LaunchValues["evaluatorReasoningEffort"],
                  }))
                }
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <NumberField
                id="lme-top-k"
                label="Retrieval Top K"
                value={values.topK}
                onChange={(topK) => setValues((current) => ({ ...current, topK }))}
              />
              <NumberField
                id="lme-evidence-top-k"
                label="Evidence Top K"
                value={values.evidenceTopK}
                onChange={(evidenceTopK) => setValues((current) => ({ ...current, evidenceTopK }))}
              />
              <NumberField
                id="lme-build-concurrency"
                label="Parallel builds"
                value={values.buildConcurrency}
                onChange={(buildConcurrency) =>
                  setValues((current) => ({ ...current, buildConcurrency }))
                }
              />
              <NumberField
                id="lme-question-concurrency"
                label="Parallel questions"
                value={values.questionConcurrency}
                onChange={(questionConcurrency) =>
                  setValues((current) => ({ ...current, questionConcurrency }))
                }
              />
              <NumberField
                id="lme-trajectory-concurrency"
                label="Parallel trajectories per haystack"
                value={values.trajectoryConcurrency}
                onChange={(trajectoryConcurrency) =>
                  setValues((current) => ({ ...current, trajectoryConcurrency }))
                }
              />
              <NumberField
                id="lme-max-in-flight"
                label="Maximum provider requests in flight"
                value={values.maxInFlightRequests}
                onChange={(maxInFlightRequests) =>
                  setValues((current) => ({ ...current, maxInFlightRequests }))
                }
              />
              <NumberField
                id="lme-indexing-timeout"
                label="Per-trajectory timeout (minutes)"
                value={values.indexingTimeoutMinutes}
                onChange={(indexingTimeoutMinutes) =>
                  setValues((current) => ({ ...current, indexingTimeoutMinutes }))
                }
              />
              <NumberField
                id="lme-max-attempts"
                label="Maximum trajectory attempts"
                value={values.maxTrajectoryAttempts}
                onChange={(maxTrajectoryAttempts) =>
                  setValues((current) => ({ ...current, maxTrajectoryAttempts }))
                }
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <CheckSetting
                label="One-trajectory canary"
                description="Requires one question and stops after retrieval."
                checked={values.canary}
                onChange={(canary) =>
                  setValues((current) => ({
                    ...current,
                    canary,
                    selectionMode: canary ? "questions" : current.selectionMode,
                    runThrough: canary ? "query" : current.runThrough,
                    allowFullRun: false,
                  }))
                }
              />
              <CheckSetting
                label="Strict ingestion"
                description="Fail on timeout instead of recording a degraded build."
                checked={values.strictIngestion}
                onChange={(strictIngestion) =>
                  setValues((current) => ({ ...current, strictIngestion }))
                }
              />
              <CheckSetting
                label="Force rebuild"
                description="Clear and rebuild only the exact selected MemoryBuild."
                checked={values.forceBuild}
                onChange={(forceBuild) => setValues((current) => ({ ...current, forceBuild }))}
              />
              <CheckSetting
                label="Fresh retrieval"
                description="Bypass the query cache."
                checked={values.freshQuery}
                onChange={(freshQuery) => setValues((current) => ({ ...current, freshQuery }))}
              />
            </div>
            <p className="text-xs text-text-muted">
              Default ingestion is bounded: repeatedly failing trajectories are stopped after the
              configured attempts/deadline and recorded instead of stalling forever.
            </p>
          </div>
        )}
      </div>

      {isFullScopeLiveRun && (
        <label className="flex items-start gap-3 rounded border border-status-warning/30 bg-status-warning/5 p-3">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-[#267bf1]"
            checked={values.allowFullRun}
            onChange={(event) =>
              setValues((current) => ({ ...current, allowFullRun: event.target.checked }))
            }
          />
          <span>
            <span className="block text-sm font-medium text-status-warning">
              Confirm the complete selected tier/domain
            </span>
            <span className="block text-xs text-text-secondary">
              Choose “Limit haystacks” for a bounded live run. Continuing with all haystacks can
              ingest, search, answer, and evaluate the complete selection.
            </span>
          </span>
        </label>
      )}

      {error && (
        <div className="rounded border border-status-error/20 bg-status-error/10 p-3 text-sm text-status-error">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 pt-1">
        <button
          type="submit"
          disabled={submitting || optionsLoading || liveStageBlocked}
          className="flex items-center justify-center gap-1.5 rounded border border-transparent px-4 py-2 text-sm font-medium text-white transition-all hover:border-white/30 disabled:cursor-not-allowed disabled:opacity-50"
          style={{
            background: "linear-gradient(135deg, rgb(38, 123, 241) 40%, rgb(21, 70, 139) 100%)",
            boxShadow:
              "rgba(255, 255, 255, 0.25) 2px 2px 8px 0px inset, rgba(0, 0, 0, 0.15) -2px -2px 7px 0px inset",
          }}
        >
          {submitting
            ? "Starting…"
            : values.runThrough === "plan"
              ? "Validate plan"
              : "Start LongMemEval-V2"}
        </button>
        <span className="text-xs text-text-muted">
          {liveStageBlocked && !optionsLoading
            ? "Live prerequisites need attention."
            : "Credentials stay on the server."}
        </span>
      </div>
    </form>
  )
}

function SectionTitle({
  number,
  title,
  description,
}: {
  number: string
  title: string
  description: string
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent/15 text-xs font-medium text-accent">
        {number}
      </span>
      <span>
        <span className="block text-sm font-medium text-text-primary">{title}</span>
        <span className="block text-xs text-text-muted">{description}</span>
      </span>
    </div>
  )
}

function PrerequisiteBadge({ label, ready }: { label: string; ready: boolean }) {
  return (
    <div
      className={`rounded border px-2 py-1.5 text-xs ${
        ready
          ? "border-status-success/30 bg-status-success/5 text-status-success"
          : "border-status-warning/30 bg-status-warning/5 text-status-warning"
      }`}
    >
      {ready ? "Ready" : "Missing"}: {label}
    </div>
  )
}

function NumberField({
  id,
  label,
  value,
  onChange,
}: {
  id: string
  label: string
  value: number
  onChange: (value: number) => void
}) {
  return (
    <div>
      <label className="mb-2 block text-sm font-medium text-text-primary" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="number"
        min="1"
        className={inputClass}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  )
}

function ModelReasoning({
  label,
  model,
  value,
  onChange,
}: {
  label: string
  model: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div>
      <label className="mb-2 block text-sm font-medium text-text-primary">{label}</label>
      {supportsReasoning(model) ? (
        <SingleSelect
          label={label}
          options={reasoningOptions}
          selected={value}
          onChange={onChange}
        />
      ) : (
        <div className={`${inputClass} text-text-muted`}>Not used by {model}</div>
      )}
    </div>
  )
}

function CheckSetting({
  label,
  description,
  checked,
  onChange,
}: {
  label: string
  description: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex items-start gap-3 rounded border border-border p-3">
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 accent-[#267bf1]"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        <span className="block text-sm text-text-primary">{label}</span>
        <span className="block text-xs text-text-muted">{description}</span>
      </span>
    </label>
  )
}
