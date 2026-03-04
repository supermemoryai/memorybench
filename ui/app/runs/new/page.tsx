"use client"

import { useState, useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import {
  getProviders,
  getBenchmarks,
  getModels,
  startRun,
  getCompletedRuns,
  type RunSummary,
  type PhaseId,
  PHASE_ORDER,
  type SelectionMode,
  type SampleType,
  type SamplingConfig,
  type Provider,
} from "@/lib/api"
import { SingleSelect } from "@/components/single-select"

type Tab = "new" | "advanced"

export default function NewRunPage() {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState<Tab>("new")
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [providers, setProviders] = useState<Provider[]>([])
  const [benchmarks, setBenchmarks] = useState<{ name: string; displayName: string }[]>([])
  const [models, setModels] = useState<any>({})
  const [completedRuns, setCompletedRuns] = useState<RunSummary[]>([])

  const [form, setForm] = useState({
    provider: "",
    benchmark: "",
    runId: "",
    judgeModel: "gpt-4o",
    answeringModel: "gpt-4o",
    selectionMode: "full" as SelectionMode,
    sampleType: "consecutive" as SampleType,
    perCategory: "2",
    limit: "",
    concurrency: {
      default: undefined as number | undefined,
      ingest: undefined as number | undefined,
      indexing: undefined as number | undefined,
      search: undefined as number | undefined,
      answer: undefined as number | undefined,
      evaluate: undefined as number | undefined,
    },
  })

  const [advancedForm, setAdvancedForm] = useState({
    sourceRunId: "",
    newRunId: "",
    fromPhase: "search" as PhaseId,
  })

  const [editingRunId, setEditingRunId] = useState(false)
  const [editingAdvancedRunId, setEditingAdvancedRunId] = useState(false)
  const [editingJudgeModel, setEditingJudgeModel] = useState(false)
  const [editingAnsweringModel, setEditingAnsweringModel] = useState(false)
  const [editingConcurrency, setEditingConcurrency] = useState(false)
  const [showAdvancedConcurrencyNew, setShowAdvancedConcurrencyNew] = useState(false)
  const [showAdvancedConcurrencyAdvanced, setShowAdvancedConcurrencyAdvanced] = useState(false)
  const [editingPhase, setEditingPhase] = useState<string | null>(null)
  const runIdInputRef = useRef<HTMLInputElement>(null)
  const advancedRunIdInputRef = useRef<HTMLInputElement>(null)
  const concurrencyInputRef = useRef<HTMLInputElement>(null)
  const phaseInputRefs = useRef<Record<string, HTMLInputElement | null>>({})

  useEffect(() => {
    if (editingConcurrency && concurrencyInputRef.current) {
      concurrencyInputRef.current.focus()
      concurrencyInputRef.current.select()
    }
  }, [editingConcurrency])

  useEffect(() => {
    if (editingPhase && phaseInputRefs.current[editingPhase]) {
      phaseInputRefs.current[editingPhase]?.focus()
      phaseInputRefs.current[editingPhase]?.select()
    }
  }, [editingPhase])

  useEffect(() => {
    loadOptions()
  }, [])

  useEffect(() => {
    if (editingRunId && runIdInputRef.current) {
      runIdInputRef.current.focus()
      runIdInputRef.current.select()
    }
  }, [editingRunId])

  useEffect(() => {
    if (editingAdvancedRunId && advancedRunIdInputRef.current) {
      advancedRunIdInputRef.current.focus()
      advancedRunIdInputRef.current.select()
    }
  }, [editingAdvancedRunId])

  const selectedSourceRun = completedRuns.find((r) => r.runId === advancedForm.sourceRunId)

  useEffect(() => {
    if (advancedForm.sourceRunId && selectedSourceRun) {
      const sourceProvider = providers.find((p) => p.name === selectedSourceRun.provider)
      setForm((f) => ({
        ...f,
        judgeModel: selectedSourceRun.judge,
        answeringModel: selectedSourceRun.answeringModel,
        concurrency: {
          default: sourceProvider?.concurrency?.default ?? 1,
          ingest: sourceProvider?.concurrency?.ingest,
          indexing: sourceProvider?.concurrency?.indexing,
          search: sourceProvider?.concurrency?.search,
          answer: sourceProvider?.concurrency?.answer,
          evaluate: sourceProvider?.concurrency?.evaluate,
        },
      }))
      const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, "")
      const random = Math.random().toString(36).slice(2, 6)
      setAdvancedForm((prev) => ({
        ...prev,
        newRunId: `${selectedSourceRun.provider}-${selectedSourceRun.benchmark}-${timestamp}-${random}`,
      }))
      setEditingJudgeModel(false)
      setEditingAnsweringModel(false)
    }
  }, [advancedForm.sourceRunId, selectedSourceRun, providers])

  useEffect(() => {
    setEditingJudgeModel(false)
    setEditingAnsweringModel(false)
    if (selectedSourceRun) {
      const canChangeJudge = ["indexing", "search", "answer", "evaluate"].includes(
        advancedForm.fromPhase
      )
      const canChangeAnswering = ["indexing", "search", "answer"].includes(advancedForm.fromPhase)
      if (!canChangeJudge) {
        setForm((f) => ({ ...f, judgeModel: selectedSourceRun.judge }))
      }
      if (!canChangeAnswering) {
        setForm((f) => ({ ...f, answeringModel: selectedSourceRun.answeringModel }))
      }
    }
  }, [advancedForm.fromPhase, selectedSourceRun])

  const canChangeJudgeModel = ["indexing", "search", "answer", "evaluate"].includes(
    advancedForm.fromPhase
  )
  const canChangeAnsweringModel = ["indexing", "search", "answer"].includes(advancedForm.fromPhase)

  const selectedProvider = providers.find((p) => p.name === form.provider)

  useEffect(() => {
    if (selectedProvider) {
      setForm((f) => ({
        ...f,
        concurrency: {
          default: selectedProvider.concurrency?.default ?? 1,
          ingest: selectedProvider.concurrency?.ingest,
          indexing: selectedProvider.concurrency?.indexing,
          search: selectedProvider.concurrency?.search,
          answer: selectedProvider.concurrency?.answer,
          evaluate: selectedProvider.concurrency?.evaluate,
        },
      }))
    }
  }, [form.provider, providers])

  async function loadOptions() {
    try {
      const [providersRes, benchmarksRes, modelsRes, runsRes] = await Promise.all([
        getProviders(),
        getBenchmarks(),
        getModels(),
        getCompletedRuns(),
      ])
      setProviders(providersRes.providers)
      setBenchmarks(benchmarksRes.benchmarks)
      setModels(modelsRes.models)
      setCompletedRuns(runsRes)

      if (providersRes.providers.length > 0) {
        const firstProvider = providersRes.providers[0]
        const defaultConcurrency = firstProvider.concurrency?.default ?? 1
        setForm((f) => ({
          ...f,
          provider: firstProvider.name,
          concurrency: {
            default: defaultConcurrency,
            ingest: firstProvider.concurrency?.ingest,
            indexing: firstProvider.concurrency?.indexing,
            search: firstProvider.concurrency?.search,
            answer: firstProvider.concurrency?.answer,
            evaluate: firstProvider.concurrency?.evaluate,
          },
        }))
      }
      if (benchmarksRes.benchmarks.length > 0) {
        setForm((f) => ({ ...f, benchmark: benchmarksRes.benchmarks[0].name }))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load options")
    } finally {
      setLoading(false)
    }
  }

  function generateRunId() {
    const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, "")
    const random = Math.random().toString(36).slice(2, 6)
    return `${form.provider}-${form.benchmark}-${timestamp}-${random}`
  }

  const displayRunId = form.runId || (form.provider && form.benchmark ? generateRunId() : "run-id")

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    if (activeTab === "advanced") {
      if (!advancedForm.sourceRunId || !selectedSourceRun) {
        setError("Please select a source run")
        return
      }
      if (!advancedForm.newRunId) {
        setError("Please enter a new run ID")
        return
      }
    }

    const runId = activeTab === "advanced" ? advancedForm.newRunId : form.runId || generateRunId()
    const fromPhase = activeTab === "advanced" ? advancedForm.fromPhase : undefined
    const sourceRunId = activeTab === "advanced" ? advancedForm.sourceRunId : undefined

    const provider =
      activeTab === "advanced" && selectedSourceRun ? selectedSourceRun.provider : form.provider
    const benchmark =
      activeTab === "advanced" && selectedSourceRun ? selectedSourceRun.benchmark : form.benchmark
    const judgeModel =
      activeTab === "advanced" && !canChangeJudgeModel && selectedSourceRun
        ? selectedSourceRun.judge
        : form.judgeModel
    const answeringModel =
      activeTab === "advanced" && !canChangeAnsweringModel && selectedSourceRun
        ? selectedSourceRun.answeringModel
        : form.answeringModel

    let sampling: SamplingConfig | undefined
    if (activeTab === "new") {
      console.log("Form state:", {
        selectionMode: form.selectionMode,
        perCategory: form.perCategory,
        sampleType: form.sampleType,
      })
      if (form.selectionMode === "full") {
        sampling = { mode: "full" }
      } else if (form.selectionMode === "sample") {
        const perCategoryValue = parseInt(form.perCategory) || 2 // Default to 2 if not set
        sampling = {
          mode: "sample",
          sampleType: form.sampleType,
          perCategory: perCategoryValue,
        }
      } else if (form.selectionMode === "limit" && form.limit) {
        sampling = {
          mode: "limit",
          limit: parseInt(form.limit),
        }
      }
    }
    console.log("Submitting with sampling config:", sampling)

    // Only send concurrency if not all defaults (1)
    const hasNonDefaultConcurrency =
      (form.concurrency.default !== undefined && form.concurrency.default !== 1) ||
      form.concurrency.ingest !== undefined ||
      form.concurrency.indexing !== undefined ||
      form.concurrency.search !== undefined ||
      form.concurrency.answer !== undefined ||
      form.concurrency.evaluate !== undefined

    const concurrency = hasNonDefaultConcurrency
      ? {
          ...(form.concurrency.default !== undefined && { default: form.concurrency.default }),
          ...(form.concurrency.ingest !== undefined && { ingest: form.concurrency.ingest }),
          ...(form.concurrency.indexing !== undefined && { indexing: form.concurrency.indexing }),
          ...(form.concurrency.search !== undefined && { search: form.concurrency.search }),
          ...(form.concurrency.answer !== undefined && { answer: form.concurrency.answer }),
          ...(form.concurrency.evaluate !== undefined && { evaluate: form.concurrency.evaluate }),
        }
      : undefined

    try {
      setSubmitting(true)
      setError(null)

      await startRun({
        provider,
        benchmark,
        runId,
        judgeModel,
        answeringModel,
        sampling,
        concurrency,
        force: activeTab === "new",
        fromPhase,
        sourceRunId,
      })

      router.push(`/runs/${encodeURIComponent(runId)}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start run")
      setSubmitting(false)
    }
  }

  const allModels = [...Object.values(models).flat()] as { alias: string; displayName: string }[]

  const providerOptions = providers.map((p) => ({ value: p.name, label: p.displayName }))
  const benchmarkOptions = benchmarks.map((b) => ({ value: b.name, label: b.displayName }))
  const modelOptions = allModels.map((m) => ({ value: m.alias, label: m.displayName || m.alias }))

  const runOptions = completedRuns.map((r) => ({
    value: r.runId,
    label: r.runId,
    sublabel: `${r.provider} · ${r.benchmark}${r.summary.total ? ` · ${r.summary.total}q` : ""}${r.accuracy !== null ? ` · ${(r.accuracy * 100).toFixed(0)}%` : ""}`,
  }))

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="max-w-2xl animate-fade-in">
      <div className="flex items-center gap-2 text-sm text-text-secondary mb-4">
        <Link href="/runs" className="hover:text-text-primary">
          Runs
        </Link>
        <span>/</span>
        <span className="text-text-primary">{activeTab === "new" ? "New Run" : "Advanced"}</span>
      </div>

      <div className="flex gap-0 mb-6">
        <button
          type="button"
          onClick={() => {
            setActiveTab("new")
            setAdvancedForm({ sourceRunId: "", newRunId: "", fromPhase: "search" })
            if (selectedProvider) {
              setForm((f) => ({
                ...f,
                concurrency: {
                  default: selectedProvider.concurrency?.default ?? 1,
                  ingest: selectedProvider.concurrency?.ingest,
                  indexing: selectedProvider.concurrency?.indexing,
                  search: selectedProvider.concurrency?.search,
                  answer: selectedProvider.concurrency?.answer,
                  evaluate: selectedProvider.concurrency?.evaluate,
                },
              }))
            }
          }}
          className="px-4 py-2 text-sm font-medium transition-colors rounded-l border"
          style={{
            fontFamily: "'Space Grotesk', sans-serif",
            backgroundColor: activeTab === "new" ? "rgb(34, 34, 34)" : "transparent",
            borderColor: activeTab === "new" ? "rgb(34, 34, 34)" : "#444444",
            color: activeTab === "new" ? "#ffffff" : "#888888",
          }}
        >
          New Run
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("advanced")}
          className="px-4 py-2 text-sm font-medium transition-colors rounded-r border-t border-r border-b"
          style={{
            fontFamily: "'Space Grotesk', sans-serif",
            backgroundColor: activeTab === "advanced" ? "rgb(34, 34, 34)" : "transparent",
            borderColor: activeTab === "advanced" ? "rgb(34, 34, 34)" : "#444444",
            color: activeTab === "advanced" ? "#ffffff" : "#888888",
          }}
        >
          Advanced
        </button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {activeTab === "advanced" && (
          <>
            <p className="text-sm text-text-secondary">
              Create a new run using data from a completed run. The new run will copy checkpoint
              data up to the selected phase.
            </p>

            <div>
              <label className="block text-sm font-medium text-text-primary mb-2">Source Run</label>
              <SingleSelect
                label="Select a completed run"
                options={runOptions}
                selected={advancedForm.sourceRunId}
                onChange={(value) => setAdvancedForm({ ...advancedForm, sourceRunId: value })}
                placeholder="Choose a source run..."
                wide
              />
            </div>

            {advancedForm.sourceRunId && (
              <>
                <div>
                  <label className="block text-sm font-medium text-text-primary mb-2">
                    New Run ID
                  </label>
                  {!editingAdvancedRunId ? (
                    <button
                      type="button"
                      className="flex items-center gap-2 text-sm text-text-primary hover:text-accent transition-colors cursor-pointer font-mono"
                      onClick={() => setEditingAdvancedRunId(true)}
                    >
                      <span className="lowercase">{advancedForm.newRunId}</span>
                      <svg
                        className="w-3.5 h-3.5 text-text-muted"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                        />
                      </svg>
                    </button>
                  ) : (
                    <input
                      ref={advancedRunIdInputRef}
                      type="text"
                      value={advancedForm.newRunId}
                      onChange={(e) =>
                        setAdvancedForm({ ...advancedForm, newRunId: e.target.value })
                      }
                      onBlur={() => setEditingAdvancedRunId(false)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === "Escape") {
                          setEditingAdvancedRunId(false)
                        }
                      }}
                      className="w-full px-3 py-2 text-sm bg-[#222222] border border-[#444444] rounded text-text-primary placeholder-text-muted focus:outline-none focus:border-accent font-mono lowercase"
                    />
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-text-primary mb-2">
                    Start From Phase
                  </label>
                  <div className="flex gap-0">
                    {PHASE_ORDER.map((phase) => {
                      const isSelected = advancedForm.fromPhase === phase
                      const isDisabled = phase === "ingest"
                      return (
                        <button
                          key={phase}
                          type="button"
                          onClick={() => {
                            if (!isDisabled) {
                              setAdvancedForm({ ...advancedForm, fromPhase: phase })
                            }
                          }}
                          disabled={isDisabled}
                          className="px-3 py-1.5 text-sm font-medium transition-colors border-t border-b border-r first:border-l first:rounded-l last:rounded-r"
                          style={{
                            fontFamily: "'Space Grotesk', sans-serif",
                            backgroundColor:
                              isSelected && !isDisabled ? "rgb(34, 34, 34)" : "transparent",
                            borderColor: isSelected && !isDisabled ? "rgb(34, 34, 34)" : "#444444",
                            color: isDisabled ? "#555555" : isSelected ? "#ffffff" : "#888888",
                            cursor: isDisabled ? "not-allowed" : "pointer",
                            opacity: isDisabled ? 0.5 : 1,
                          }}
                        >
                          {phase.charAt(0).toUpperCase() + phase.slice(1)}
                        </button>
                      )
                    })}
                  </div>
                  <p className="text-xs text-text-muted mt-2">
                    Will copy data up to this phase from source run, then execute this phase and
                    subsequent phases
                  </p>
                </div>

                <div className="mt-6 space-y-4">
                  <p className="text-sm text-text-muted">Source run settings</p>
                  <div className="grid grid-cols-2 gap-x-8 gap-y-2">
                    <div className="text-base">
                      <span className="text-text-muted">Provider:</span>{" "}
                      <span className="text-text-primary font-medium">
                        {selectedSourceRun?.provider}
                      </span>
                    </div>
                    <div className="text-base">
                      <span className="text-text-muted">Benchmark:</span>{" "}
                      <span className="text-text-primary font-medium">
                        {selectedSourceRun?.benchmark}
                      </span>
                    </div>
                    <div className="text-base flex items-center gap-1">
                      <span className="text-text-muted">Judge:</span>{" "}
                      {canChangeJudgeModel ? (
                        <button
                          type="button"
                          onClick={() => setEditingJudgeModel(!editingJudgeModel)}
                          className="flex items-center gap-2 text-text-primary font-medium hover:text-accent transition-colors cursor-pointer"
                        >
                          <span>{form.judgeModel}</span>
                          <svg
                            className="w-3.5 h-3.5 text-text-muted"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                            />
                          </svg>
                        </button>
                      ) : (
                        <span className="text-text-primary font-medium">{form.judgeModel}</span>
                      )}
                    </div>
                    <div className="text-base flex items-center gap-1">
                      <span className="text-text-muted">Answering:</span>{" "}
                      {canChangeAnsweringModel ? (
                        <button
                          type="button"
                          onClick={() => setEditingAnsweringModel(!editingAnsweringModel)}
                          className="flex items-center gap-2 text-text-primary font-medium hover:text-accent transition-colors cursor-pointer"
                        >
                          <span>{form.answeringModel}</span>
                          <svg
                            className="w-3.5 h-3.5 text-text-muted"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                            />
                          </svg>
                        </button>
                      ) : (
                        <span className="text-text-primary font-medium">{form.answeringModel}</span>
                      )}
                    </div>
                  </div>

                  {(editingJudgeModel || editingAnsweringModel) && (
                    <div className="grid grid-cols-2 gap-4 pt-2">
                      {editingJudgeModel && canChangeJudgeModel && (
                        <div>
                          <label className="block text-sm font-medium text-text-primary mb-2">
                            Judge Model
                          </label>
                          <SingleSelect
                            label="Select model"
                            options={modelOptions}
                            selected={form.judgeModel}
                            onChange={(value) => {
                              setForm({ ...form, judgeModel: value })
                              setEditingJudgeModel(false)
                            }}
                            placeholder="Select model"
                            dropUp
                          />
                        </div>
                      )}
                      {editingAnsweringModel && canChangeAnsweringModel && (
                        <div>
                          <label className="block text-sm font-medium text-text-primary mb-2">
                            Answering Model
                          </label>
                          <SingleSelect
                            label="Select model"
                            options={modelOptions}
                            selected={form.answeringModel}
                            onChange={(value) => {
                              setForm({ ...form, answeringModel: value })
                              setEditingAnsweringModel(false)
                            }}
                            placeholder="Select model"
                            dropUp
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="mt-6 pt-4 border-t border-[#333333]">
                  <div className="flex items-center justify-between h-8">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-text-primary">
                        Concurrent requests{!showAdvancedConcurrencyAdvanced && ":"}
                      </span>
                      {!showAdvancedConcurrencyAdvanced &&
                        (editingConcurrency ? (
                          <input
                            ref={concurrencyInputRef}
                            type="number"
                            className="w-16 px-2 py-0.5 text-sm bg-[#222222] border border-[#444444] rounded text-text-primary focus:outline-none focus:border-accent"
                            value={form.concurrency.default ?? ""}
                            onChange={(e) =>
                              setForm({
                                ...form,
                                concurrency: {
                                  ...form.concurrency,
                                  default: e.target.value ? parseInt(e.target.value) : undefined,
                                },
                              })
                            }
                            onBlur={() => setEditingConcurrency(false)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === "Escape") {
                                setEditingConcurrency(false)
                              }
                            }}
                            min="1"
                          />
                        ) : (
                          <button
                            type="button"
                            className="flex items-center gap-2 text-sm text-text-primary hover:text-accent transition-colors cursor-pointer"
                            onClick={() => setEditingConcurrency(true)}
                          >
                            <span className="font-medium">{form.concurrency.default ?? 1}</span>
                            <svg
                              className="w-3.5 h-3.5 text-text-muted"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                              strokeWidth={2}
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                              />
                            </svg>
                          </button>
                        ))}
                    </div>

                    <button
                      type="button"
                      onClick={() =>
                        setShowAdvancedConcurrencyAdvanced(!showAdvancedConcurrencyAdvanced)
                      }
                      className="flex items-center gap-1 text-sm text-text-muted hover:text-text-primary transition-colors"
                    >
                      <span>Advanced</span>
                      <svg
                        className={`w-4 h-4 transition-transform ${showAdvancedConcurrencyAdvanced ? "rotate-180" : ""}`}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M19 9l-7 7-7-7"
                        />
                      </svg>
                    </button>
                  </div>

                  {showAdvancedConcurrencyAdvanced && (
                    <div className="mt-1 space-y-2">
                      <p className="text-xs text-text-muted mb-2">
                        Override source run concurrency settings
                      </p>
                      {(["ingest", "indexing", "search", "answer", "evaluate"] as const).map(
                        (phase) => (
                          <div key={phase} className="flex items-center gap-3 h-7">
                            <span className="text-sm text-text-secondary capitalize w-20">
                              {phase}:
                            </span>
                            {editingPhase === phase ? (
                              <input
                                ref={(el) => {
                                  phaseInputRefs.current[phase] = el
                                }}
                                type="number"
                                className="w-16 px-2 py-0.5 text-sm bg-[#222222] border border-[#444444] rounded text-text-primary focus:outline-none focus:border-accent"
                                value={form.concurrency[phase] ?? ""}
                                onChange={(e) =>
                                  setForm({
                                    ...form,
                                    concurrency: {
                                      ...form.concurrency,
                                      [phase]: e.target.value
                                        ? parseInt(e.target.value)
                                        : undefined,
                                    },
                                  })
                                }
                                onBlur={() => setEditingPhase(null)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" || e.key === "Escape") {
                                    setEditingPhase(null)
                                  }
                                }}
                                placeholder={String(form.concurrency.default ?? 1)}
                                min="1"
                              />
                            ) : (
                              <button
                                type="button"
                                className="flex items-center gap-2 text-sm text-text-primary hover:text-accent transition-colors cursor-pointer"
                                onClick={() => setEditingPhase(phase)}
                              >
                                <span
                                  className={
                                    form.concurrency[phase] !== undefined
                                      ? "font-medium"
                                      : "text-text-muted"
                                  }
                                >
                                  {form.concurrency[phase] ?? form.concurrency.default}
                                </span>
                                <svg
                                  className="w-3.5 h-3.5 text-text-muted"
                                  fill="none"
                                  viewBox="0 0 24 24"
                                  stroke="currentColor"
                                  strokeWidth={2}
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                                  />
                                </svg>
                              </button>
                            )}
                          </div>
                        )
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
          </>
        )}

        {activeTab === "new" && (
          <>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-2">Run ID</label>
              {!editingRunId ? (
                <button
                  type="button"
                  className="flex items-center gap-2 text-sm text-text-primary hover:text-accent transition-colors cursor-pointer font-mono"
                  onClick={() => setEditingRunId(true)}
                >
                  <span className="lowercase">{displayRunId}</span>
                  <svg
                    className="w-3.5 h-3.5 text-text-muted"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                    />
                  </svg>
                </button>
              ) : (
                <input
                  ref={runIdInputRef}
                  type="text"
                  value={form.runId || displayRunId}
                  onChange={(e) => setForm({ ...form, runId: e.target.value })}
                  onBlur={() => setEditingRunId(false)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === "Escape") {
                      setEditingRunId(false)
                    }
                  }}
                  className="w-full px-3 py-2 text-sm bg-[#222222] border border-[#444444] rounded text-text-primary placeholder-text-muted focus:outline-none focus:border-accent font-mono lowercase"
                />
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-text-primary mb-2">Provider</label>
                <SingleSelect
                  label="Select provider"
                  options={providerOptions}
                  selected={form.provider}
                  onChange={(value) => setForm({ ...form, provider: value })}
                  placeholder="Select provider"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-text-primary mb-2">
                  Benchmark
                </label>
                <SingleSelect
                  label="Select benchmark"
                  options={benchmarkOptions}
                  selected={form.benchmark}
                  onChange={(value) => setForm({ ...form, benchmark: value })}
                  placeholder="Select benchmark"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-text-primary mb-2">
                  Judge Model
                </label>
                <SingleSelect
                  label="Select model"
                  options={modelOptions}
                  selected={form.judgeModel}
                  onChange={(value) => setForm({ ...form, judgeModel: value })}
                  placeholder="Select model"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-text-primary mb-2">
                  Answering Model
                </label>
                <SingleSelect
                  label="Select model"
                  options={modelOptions}
                  selected={form.answeringModel}
                  onChange={(value) => setForm({ ...form, answeringModel: value })}
                  placeholder="Select model"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-text-primary mb-2">
                Question Selection
              </label>
              <div className="flex gap-0 mb-4">
                {(["full", "sample", "limit"] as SelectionMode[]).map((mode) => {
                  const isSelected = form.selectionMode === mode
                  const labels = { full: "Full", sample: "Sample", limit: "Limit" }
                  return (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setForm({ ...form, selectionMode: mode })}
                      className="px-3 py-1.5 text-sm font-medium transition-colors border-t border-b border-r first:border-l first:rounded-l last:rounded-r"
                      style={{
                        fontFamily: "'Space Grotesk', sans-serif",
                        backgroundColor: isSelected ? "rgb(34, 34, 34)" : "transparent",
                        borderColor: isSelected ? "rgb(34, 34, 34)" : "#444444",
                        color: isSelected ? "#ffffff" : "#888888",
                      }}
                    >
                      {labels[mode]}
                    </button>
                  )
                })}
              </div>

              {form.selectionMode === "sample" && (
                <div className="flex items-center gap-3">
                  <input
                    type="number"
                    className="w-16 px-3 py-1.5 text-sm bg-[#222222] border border-[#444444] rounded text-text-primary placeholder-text-muted focus:outline-none focus:border-accent"
                    value={form.perCategory}
                    onChange={(e) => setForm({ ...form, perCategory: e.target.value })}
                    placeholder="2"
                    min="1"
                  />
                  <span className="text-sm text-text-secondary mr-8">per category</span>
                  <div className="flex gap-0">
                    {(["consecutive", "random"] as SampleType[]).map((type) => {
                      const isSelected = form.sampleType === type
                      return (
                        <button
                          key={type}
                          type="button"
                          onClick={() => setForm({ ...form, sampleType: type })}
                          className="px-3 py-1.5 text-sm font-medium transition-colors border-t border-b border-r first:border-l first:rounded-l last:rounded-r"
                          style={{
                            fontFamily: "'Space Grotesk', sans-serif",
                            backgroundColor: isSelected ? "rgb(34, 34, 34)" : "transparent",
                            borderColor: isSelected ? "rgb(34, 34, 34)" : "#444444",
                            color: isSelected ? "#ffffff" : "#888888",
                          }}
                        >
                          {type.charAt(0).toUpperCase() + type.slice(1)}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              {form.selectionMode === "limit" && (
                <div>
                  <label className="block text-sm text-text-secondary mb-2">Question Limit</label>
                  <input
                    type="number"
                    className="input w-32"
                    value={form.limit}
                    onChange={(e) => setForm({ ...form, limit: e.target.value })}
                    placeholder="e.g. 100"
                    min="1"
                  />
                </div>
              )}
            </div>

            <div>
              <div className="flex items-center justify-between h-8">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text-primary">
                    Concurrent requests{!showAdvancedConcurrencyNew && ":"}
                  </span>
                  {!showAdvancedConcurrencyNew &&
                    (editingConcurrency ? (
                      <input
                        ref={concurrencyInputRef}
                        type="number"
                        className="w-16 px-2 py-0.5 text-sm bg-[#222222] border border-[#444444] rounded text-text-primary focus:outline-none focus:border-accent"
                        value={form.concurrency.default ?? ""}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            concurrency: {
                              ...form.concurrency,
                              default: e.target.value ? parseInt(e.target.value) : undefined,
                            },
                          })
                        }
                        onBlur={() => setEditingConcurrency(false)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === "Escape") {
                            setEditingConcurrency(false)
                          }
                        }}
                        min="1"
                      />
                    ) : (
                      <button
                        type="button"
                        className="flex items-center gap-2 text-sm text-text-primary hover:text-accent transition-colors cursor-pointer"
                        onClick={() => setEditingConcurrency(true)}
                      >
                        <span className="font-medium">{form.concurrency.default ?? 1}</span>
                        <svg
                          className="w-3.5 h-3.5 text-text-muted"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                          />
                        </svg>
                      </button>
                    ))}
                </div>

                <button
                  type="button"
                  onClick={() => setShowAdvancedConcurrencyNew(!showAdvancedConcurrencyNew)}
                  className="flex items-center gap-1 text-sm text-text-muted hover:text-text-primary transition-colors"
                >
                  <span>Advanced</span>
                  <svg
                    className={`w-4 h-4 transition-transform ${showAdvancedConcurrencyNew ? "rotate-180" : ""}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M19 9l-7 7-7-7"
                    />
                  </svg>
                </button>
              </div>

              {showAdvancedConcurrencyNew && (
                <div className="space-y-2">
                  <p className="text-xs text-text-muted mb-2">
                    Process multiple items simultaneously for faster execution
                  </p>
                  {(["ingest", "indexing", "search", "answer", "evaluate"] as const).map(
                    (phase) => (
                      <div key={phase} className="flex items-center gap-3 h-7">
                        <span className="text-sm text-text-secondary capitalize w-20">
                          {phase}:
                        </span>
                        {editingPhase === phase ? (
                          <input
                            ref={(el) => {
                              phaseInputRefs.current[phase] = el
                            }}
                            type="number"
                            className="w-16 px-2 py-0.5 text-sm bg-[#222222] border border-[#444444] rounded text-text-primary focus:outline-none focus:border-accent"
                            value={form.concurrency[phase] ?? ""}
                            onChange={(e) =>
                              setForm({
                                ...form,
                                concurrency: {
                                  ...form.concurrency,
                                  [phase]: e.target.value ? parseInt(e.target.value) : undefined,
                                },
                              })
                            }
                            onBlur={() => setEditingPhase(null)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === "Escape") {
                                setEditingPhase(null)
                              }
                            }}
                            placeholder={String(form.concurrency.default ?? 1)}
                            min="1"
                          />
                        ) : (
                          <button
                            type="button"
                            className="flex items-center gap-2 text-sm text-text-primary hover:text-accent transition-colors cursor-pointer"
                            onClick={() => setEditingPhase(phase)}
                          >
                            <span
                              className={
                                form.concurrency[phase] !== undefined
                                  ? "font-medium"
                                  : "text-text-muted"
                              }
                            >
                              {form.concurrency[phase] ?? form.concurrency.default}
                            </span>
                            <svg
                              className="w-3.5 h-3.5 text-text-muted"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                              strokeWidth={2}
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                              />
                            </svg>
                          </button>
                        )}
                      </div>
                    )
                  )}
                </div>
              )}
            </div>
          </>
        )}

        {error && (
          <div className="p-3 bg-status-error/10 border border-status-error/20 rounded text-status-error text-sm">
            {error}
          </div>
        )}

        <div className="flex gap-3 pt-4">
          <button
            type="submit"
            className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium transition-all font-display tracking-tight text-white border border-transparent hover:border-white/30 disabled:opacity-50"
            style={{
              background: "linear-gradient(135deg, rgb(38, 123, 241) 40%, rgb(21, 70, 139) 100%)",
              boxShadow:
                "rgba(255, 255, 255, 0.25) 2px 2px 8px 0px inset, rgba(0, 0, 0, 0.15) -2px -2px 7px 0px inset",
            }}
            disabled={submitting || (activeTab === "advanced" && !advancedForm.sourceRunId)}
          >
            {submitting ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                <span>Starting...</span>
              </>
            ) : (
              <>
                <svg
                  className="w-4 h-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653z"
                  />
                </svg>
                <span>{activeTab === "advanced" ? "Continue Run" : "Start Run"}</span>
              </>
            )}
          </button>
          <Link
            href="/runs"
            className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium transition-all font-display tracking-tight text-text-secondary border border-[#333333] hover:border-[#444444] hover:text-text-primary"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  )
}
