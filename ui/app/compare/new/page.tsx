"use client"

import { useState, useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import {
  getProviders,
  getBenchmarks,
  getModels,
  startCompare,
  type SelectionMode,
  type SampleType,
  type SamplingConfig,
} from "@/lib/api"
import { SingleSelect } from "@/components/single-select"
import { MultiSelect } from "@/components/multi-select"

export default function NewComparePage() {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [providers, setProviders] = useState<{ name: string; displayName: string }[]>([])
  const [benchmarks, setBenchmarks] = useState<{ name: string; displayName: string }[]>([])
  const [models, setModels] = useState<any>({})

  const [form, setForm] = useState({
    providers: [] as string[],
    benchmark: "",
    compareId: "",
    judgeModel: "gpt-4o",
    answeringModel: "gpt-4o",
    selectionMode: "full" as SelectionMode,
    sampleType: "consecutive" as SampleType,
    perCategory: "2",
    limit: "",
  })

  const [editingCompareId, setEditingCompareId] = useState(false)
  const compareIdInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    loadOptions()
  }, [])

  useEffect(() => {
    if (editingCompareId && compareIdInputRef.current) {
      compareIdInputRef.current.focus()
      compareIdInputRef.current.select()
    }
  }, [editingCompareId])

  async function loadOptions() {
    try {
      const [providersRes, benchmarksRes, modelsRes] = await Promise.all([
        getProviders(),
        getBenchmarks(),
        getModels(),
      ])
      setProviders(providersRes.providers)
      setBenchmarks(benchmarksRes.benchmarks)
      setModels(modelsRes.models)

      if (benchmarksRes.benchmarks.length > 0) {
        setForm((f) => ({ ...f, benchmark: benchmarksRes.benchmarks[0].name }))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load options")
    } finally {
      setLoading(false)
    }
  }

  function generateCompareId() {
    const now = new Date()
    const date = now.toISOString().slice(0, 10).replace(/-/g, "")
    const time = now.toISOString().slice(11, 19).replace(/:/g, "")
    return `compare-${date}-${time}`
  }

  const displayCompareId = form.compareId || generateCompareId()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    // Validate providers
    if (form.providers.length < 2) {
      setError("Please select at least 2 providers for comparison")
      return
    }

    const compareId = form.compareId || generateCompareId()

    let sampling: SamplingConfig | undefined
    if (form.selectionMode === "full") {
      sampling = { mode: "full" }
    } else if (form.selectionMode === "sample") {
      const perCategoryValue = parseInt(form.perCategory) || 2
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

    try {
      setSubmitting(true)
      setError(null)

      await startCompare({
        providers: form.providers,
        benchmark: form.benchmark,
        compareId,
        judgeModel: form.judgeModel,
        answeringModel: form.answeringModel,
        sampling,
      })

      router.push(`/compare`)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start comparison")
      setSubmitting(false)
    }
  }

  const allModels = [...Object.values(models).flat()] as { alias: string; displayName: string }[]

  const providerOptions = providers.map((p) => ({ value: p.name, label: p.displayName }))
  const benchmarkOptions = benchmarks.map((b) => ({ value: b.name, label: b.displayName }))
  const modelOptions = allModels.map((m) => ({ value: m.alias, label: m.displayName || m.alias }))

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
        <Link href="/compare" className="hover:text-text-primary">
          Compare
        </Link>
        <span>/</span>
        <span className="text-text-primary">New Comparison</span>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div>
          <label className="block text-sm font-medium text-text-primary mb-2">Compare ID</label>
          {!editingCompareId ? (
            <button
              type="button"
              className="flex items-center gap-2 text-sm text-text-primary hover:text-accent transition-colors cursor-pointer font-mono"
              onClick={() => setEditingCompareId(true)}
            >
              <span className="lowercase">{displayCompareId}</span>
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
              ref={compareIdInputRef}
              type="text"
              value={form.compareId || displayCompareId}
              onChange={(e) => setForm({ ...form, compareId: e.target.value })}
              onBlur={() => setEditingCompareId(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === "Escape") {
                  setEditingCompareId(false)
                }
              }}
              className="w-full px-3 py-2 text-sm bg-[#222222] border border-[#444444] rounded text-text-primary placeholder-text-muted focus:outline-none focus:border-accent font-mono lowercase"
            />
          )}
          {form.providers.length > 0 && (
            <div className="text-base mt-4">
              <span className="text-text-muted">Providers:</span>{" "}
              <span className="text-text-primary font-medium">
                {form.providers
                  .map((providerId) => {
                    const provider = providers.find((p) => p.name === providerId)
                    return provider?.displayName || providerId
                  })
                  .join(", ")}
              </span>
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-text-primary mb-2">
              Providers{" "}
              {form.providers.length < 2 && (
                <span className="text-status-error text-xs">(select at least 2)</span>
              )}
            </label>
            <div className="border border-[#444444] rounded bg-[#222222]">
              <MultiSelect
                label="Select providers"
                options={providerOptions}
                selected={form.providers}
                onChange={(selected) => setForm({ ...form, providers: selected })}
                placeholder="Select at least 2 providers..."
              />
            </div>
            {form.providers.length > 0 && form.providers.length < 2 && (
              <p className="text-xs text-status-error mt-1">
                At least 2 providers are required for comparison
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-2">Benchmark</label>
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
            <label className="block text-sm font-medium text-text-primary mb-2">Judge Model</label>
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
            disabled={submitting || form.providers.length < 2 || !form.benchmark}
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
                <span>Compare</span>
              </>
            )}
          </button>
          <Link
            href="/compare"
            className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium transition-all font-display tracking-tight text-text-secondary border border-[#333333] hover:border-[#444444] hover:text-text-primary"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  )
}
