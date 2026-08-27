"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import {
  getBuildAwareRunQuestions,
  getLongMemEvalV2RunStatus,
  resumeLongMemEvalV2Run,
  stopLongMemEvalV2Run,
  type BuildAwareReport,
  type BuildAwareQuestionSummary,
  type BuildAwareRunDetail,
  type LongMemEvalV2RunStatusResponse,
  type PaginatedResponse,
} from "@/lib/api"
import {
  requiresFullScopeResumeConfirmation,
  type LongMemEvalV2ResumeTarget,
} from "@/lib/longmemeval-v2-form"
import { cn, formatDate, formatDuration, getStatusColor } from "@/lib/utils"

interface BuildAwareRunInspectionProps {
  run: BuildAwareRunDetail
  report: BuildAwareReport | null
  onRefresh?: () => Promise<void>
}

function percent(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${(value * 100).toFixed(1)}%`
}

function average(values: number[] | undefined): number | null {
  if (!values?.length) return null
  return values.reduce((total, value) => total + value, 0) / values.length
}

function stageLabel(status: string): string {
  return status.replace(/_/g, " ")
}

function nextStage(
  stage: BuildAwareRunDetail["currentStage"],
  canary: boolean
): BuildAwareRunDetail["currentStage"] | null {
  const next: Partial<
    Record<BuildAwareRunDetail["currentStage"], BuildAwareRunDetail["currentStage"]>
  > = {
    plan: "build",
    build: "query",
    query: "read",
    read: "evaluate",
    evaluate: "report",
  }
  const target = next[stage] ?? null
  return canary && target && !["build", "query"].includes(target) ? null : target
}

export function BuildAwareRunInspection({ run, report, onRefresh }: BuildAwareRunInspectionProps) {
  const [runtime, setRuntime] = useState<LongMemEvalV2RunStatusResponse | null>(null)
  const [controlAction, setControlAction] = useState<"stop" | "resume" | null>(null)
  const [controlError, setControlError] = useState<string | null>(null)
  const [allowFullContinuation, setAllowFullContinuation] = useState(false)
  const [resumeForceBuild, setResumeForceBuild] = useState(false)
  const [resumeFreshQuery, setResumeFreshQuery] = useState(false)
  const [questionPage, setQuestionPage] = useState(1)
  const [questionPageData, setQuestionPageData] =
    useState<PaginatedResponse<BuildAwareQuestionSummary> | null>(null)
  const [questionsLoading, setQuestionsLoading] = useState(true)
  const [questionsError, setQuestionsError] = useState<string | null>(null)
  const lastStatusSignature = useRef("")
  const official = report?.official ?? run.inspection.metricNamespaces.official
  const diagnostics = report?.diagnostics ?? run.inspection.metricNamespaces.diagnostics
  const questions =
    questionPageData?.questions ??
    (Object.values(run.questions ?? {}) as BuildAwareQuestionSummary[])
  const checkpointStatus = runtime?.checkpoint?.status ?? run.status
  const checkpointStage = runtime?.checkpoint?.currentStage ?? run.currentStage
  const lifecycleEvents = runtime?.control?.events ?? []
  const isActive = runtime?.active ?? ["pending", "running"].includes(run.status)
  const isStopping = runtime?.stopping ?? false
  const canResume =
    !isActive && !isStopping && ["failed", "partial", "blocked"].includes(checkpointStatus)
  const continuationStage =
    checkpointStatus === "completed"
      ? nextStage(checkpointStage, run.config.mode === "one-trajectory-canary")
      : null
  const canContinue = !isActive && !isStopping && continuationStage !== null
  const priorTarget = [...lifecycleEvents]
    .reverse()
    .find(
      (event) =>
        (event.action === "start" || event.action === "resume") && event.through !== undefined
    )?.through
  const resumeTarget: LongMemEvalV2ResumeTarget | null = canContinue
    ? continuationStage
    : canResume
      ? (priorTarget ?? checkpointStage)
      : null
  const needsFullContinuationConfirmation = requiresFullScopeResumeConfirmation(
    run.config,
    resumeTarget
  )

  const refreshRuntime = useCallback(async () => {
    try {
      const next = await getLongMemEvalV2RunStatus(run.runId)
      const signature = `${next.active}:${next.stopping}:${next.checkpoint?.status ?? "none"}:${next.checkpoint?.currentStage ?? "none"}:${next.checkpoint?.updatedAt ?? "none"}`
      const changed =
        lastStatusSignature.current !== "" && lastStatusSignature.current !== signature
      lastStatusSignature.current = signature
      setRuntime(next)
      if (changed) await onRefresh?.()
    } catch (error) {
      setControlError(error instanceof Error ? error.message : "Could not read run lifecycle")
    }
  }, [onRefresh, run.runId])

  const refreshQuestions = useCallback(async () => {
    try {
      setQuestionsLoading(true)
      const next = await getBuildAwareRunQuestions(run.runId, { page: questionPage, limit: 25 })
      setQuestionPageData(next)
      setQuestionsError(null)
    } catch (error) {
      setQuestionsError(error instanceof Error ? error.message : "Could not load questions")
    } finally {
      setQuestionsLoading(false)
    }
  }, [questionPage, run.runId, run.updatedAt])

  useEffect(() => {
    void refreshRuntime()
    const interval = window.setInterval(() => void refreshRuntime(), 2_000)
    return () => window.clearInterval(interval)
  }, [refreshRuntime])

  useEffect(() => {
    void refreshQuestions()
  }, [refreshQuestions])

  useEffect(() => {
    setAllowFullContinuation(false)
  }, [resumeTarget, run.runId])

  async function handleStop() {
    if (controlAction || !isActive || isStopping) return
    try {
      setControlAction("stop")
      setControlError(null)
      await stopLongMemEvalV2Run(run.runId)
      await refreshRuntime()
      await onRefresh?.()
    } catch (error) {
      setControlError(error instanceof Error ? error.message : "Failed to stop run")
    } finally {
      setControlAction(null)
    }
  }

  async function handleResume() {
    if (
      controlAction ||
      (!canResume && !canContinue) ||
      (needsFullContinuationConfirmation && !allowFullContinuation)
    )
      return
    try {
      setControlAction("resume")
      setControlError(null)
      await resumeLongMemEvalV2Run(run.runId, {
        ...(continuationStage ? { runThrough: continuationStage } : {}),
        ...(needsFullContinuationConfirmation ? { allowFullRun: true } : {}),
        forceBuild: resumeForceBuild,
        freshQuery: resumeFreshQuery,
      })
      setAllowFullContinuation(false)
      setResumeForceBuild(false)
      setResumeFreshQuery(false)
      await refreshRuntime()
      await onRefresh?.()
    } catch (error) {
      setControlError(error instanceof Error ? error.message : "Failed to resume run")
    } finally {
      setControlAction(null)
    }
  }

  return (
    <div className="animate-fade-in space-y-6">
      <div className="flex items-center gap-2 text-sm text-text-secondary">
        <Link href="/runs" className="hover:text-text-primary">
          Runs
        </Link>
        <span>/</span>
        <span className="text-text-primary font-mono">{run.runId}</span>
      </div>

      <div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-display font-semibold text-text-primary">{run.runId}</h1>
          <span className={cn("badge text-sm", getStatusColor(checkpointStatus))}>
            {stageLabel(checkpointStatus)}
          </span>
          <span className="badge bg-accent/10 text-accent">shared memory build</span>
          <span className="badge badge-neutral">{run.config.mode}</span>
          {isActive && (
            <button
              type="button"
              onClick={handleStop}
              disabled={controlAction !== null || isStopping}
              className="rounded bg-status-error/10 px-3 py-1 text-sm text-status-error hover:bg-status-error/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isStopping || controlAction === "stop" ? "Stopping…" : "Stop"}
            </button>
          )}
          {(canResume || canContinue) && (
            <button
              type="button"
              onClick={handleResume}
              disabled={
                controlAction !== null ||
                (needsFullContinuationConfirmation && !allowFullContinuation)
              }
              className="rounded bg-accent/10 px-3 py-1 text-sm text-accent hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {controlAction === "resume"
                ? canContinue
                  ? "Continuing…"
                  : "Resuming…"
                : canContinue
                  ? `Continue to ${stageLabel(continuationStage!)}`
                  : `Resume ${stageLabel(checkpointStage)}`}
            </button>
          )}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm text-text-secondary">
          <span>
            <span className="text-text-muted">Provider:</span> {run.config.provider}
          </span>
          <span>
            <span className="text-text-muted">Benchmark:</span> LongMemEval-V2
          </span>
          <span>
            <span className="text-text-muted">Stage:</span> {checkpointStage}
          </span>
          <span>
            <span className="text-text-muted">Runtime:</span>{" "}
            {isStopping ? "stopping" : isActive ? "active" : "inactive"}
          </span>
          <span>
            <span className="text-text-muted">Created:</span> {formatDate(run.createdAt)}
          </span>
        </div>
      </div>

      {(canResume || canContinue) && needsFullContinuationConfirmation && (
        <div className="card border-status-warning/30 bg-status-warning/5">
          <div className="text-xs uppercase tracking-wide text-status-warning mb-1">
            Full-tier continuation requires confirmation
          </div>
          <p className="text-sm text-text-secondary">
            This run has no question, haystack, limit, or per-category selector. Continuing through{" "}
            <span className="font-mono text-text-primary">{resumeTarget}</span> can process the
            complete {run.config.tier}/{run.config.domain} selection ({run.targetQuestionIds.length}{" "}
            planned questions) and may ingest its full memory build.
          </p>
          <label className="mt-3 flex items-start gap-2 text-sm text-text-primary">
            <input
              type="checkbox"
              checked={allowFullContinuation}
              onChange={(event) => setAllowFullContinuation(event.target.checked)}
              className="mt-0.5"
            />
            <span>I understand and allow this full-tier continuation.</span>
          </label>
        </div>
      )}

      {(canResume || canContinue) && (
        <div className="card">
          <div className="text-sm font-medium text-text-primary mb-2">Resume options</div>
          <div className="grid gap-2 sm:grid-cols-2 text-sm text-text-secondary">
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5 accent-[#267bf1]"
                checked={resumeForceBuild}
                onChange={(event) => setResumeForceBuild(event.target.checked)}
              />
              <span>Force a clean rebuild (also forces fresh retrieval).</span>
            </label>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5 accent-[#267bf1]"
                checked={resumeFreshQuery}
                onChange={(event) => setResumeFreshQuery(event.target.checked)}
              />
              <span>Ignore cached retrieval artifacts.</span>
            </label>
          </div>
        </div>
      )}

      {controlError && (
        <div className="card border-status-error/30 bg-status-error/5 text-sm text-status-error">
          {controlError}
        </div>
      )}

      {lifecycleEvents.length > 0 && (
        <details className="card">
          <summary className="cursor-pointer text-sm font-medium text-text-primary">
            Lifecycle history ({lifecycleEvents.length})
          </summary>
          <div className="mt-3 overflow-x-auto rounded border border-border">
            <table className="w-full text-xs">
              <thead className="bg-bg-elevated text-text-muted">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Action</th>
                  <th className="px-3 py-2 text-left font-medium">Through</th>
                  <th className="px-3 py-2 text-left font-medium">Time</th>
                  <th className="px-3 py-2 text-left font-medium">Message</th>
                </tr>
              </thead>
              <tbody>
                {lifecycleEvents
                  .slice(-10)
                  .reverse()
                  .map((event, index) => (
                    <tr
                      key={`${event.at}-${event.action}-${index}`}
                      className="border-t border-border"
                    >
                      <td className="px-3 py-2 font-mono text-accent">{event.action}</td>
                      <td className="px-3 py-2 font-mono text-text-secondary">
                        {event.through ?? "—"}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-text-secondary">
                        {formatDate(event.at)}
                      </td>
                      <td className="px-3 py-2 text-text-muted">
                        {[
                          event.message,
                          event.provider ? `provider ${event.provider}` : undefined,
                          event.forceBuild ? "force rebuild" : undefined,
                          event.freshQuery ? "fresh retrieval" : undefined,
                        ]
                          .filter(Boolean)
                          .join(" · ") || "—"}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {(runtime?.checkpoint?.error || run.error) && (
        <div className="card border-status-error/30 bg-status-error/5">
          <div className="text-xs uppercase tracking-wide text-status-error mb-1">Run error</div>
          <p className="text-sm text-text-secondary break-words">
            {runtime?.checkpoint?.error ?? run.error}
          </p>
        </div>
      )}

      {report?.officiallyComparable === false && (
        <div className="card border-status-warning/30 bg-status-warning/5">
          <div className="text-xs uppercase tracking-wide text-status-warning mb-1">
            Degraded build — not an official comparison
          </div>
          <p className="text-sm text-text-secondary">
            Ingestion continued after bounded failures or indexing timeouts. Any score remains
            diagnostic because the exact haystack was incomplete.
          </p>
          {(report.ineligibilityReasons?.length ?? 0) > 0 && (
            <ul className="mt-2 list-disc pl-5 text-xs text-text-muted">
              {report.ineligibilityReasons!.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {(run.storageRoots.artifacts !== "available" || run.storageRoots.builds !== "available") && (
        <div className="card border-status-warning/30 bg-status-warning/5">
          <div className="text-xs uppercase tracking-wide text-status-warning mb-1">
            Partial local provenance
          </div>
          <p className="text-sm text-text-secondary">
            Artifact root: {run.storageRoots.artifacts}; build root: {run.storageRoots.builds}.
            Checkpoint-embedded data remains visible, but unavailable roots are never followed
            outside the server&apos;s allowlisted directories.
          </p>
        </div>
      )}

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-display font-semibold text-text-primary">
            Memory Build reuse
          </h2>
          <p className="text-sm text-text-secondary">
            Questions sharing a build query one ingested haystack. Reuse counts below come from
            checkpoint question-to-build links.
          </p>
        </div>
        <div className="border border-border rounded overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-bg-elevated text-text-muted">
              <tr>
                <th className="text-left font-medium px-4 py-2">Build ID</th>
                <th className="text-left font-medium px-4 py-2">Fingerprint</th>
                <th className="text-left font-medium px-4 py-2">Plan</th>
                <th className="text-left font-medium px-4 py-2">Question sharing</th>
                <th className="text-left font-medium px-4 py-2">Ingestion</th>
                <th className="text-left font-medium px-4 py-2">Build state</th>
              </tr>
            </thead>
            <tbody>
              {run.inspection.builds.map((build) => (
                <tr key={build.buildId} className="border-t border-border">
                  <td className="px-4 py-3 font-mono text-accent">{build.buildId}</td>
                  <td
                    className="px-4 py-3 font-mono text-text-secondary max-w-[260px] truncate"
                    title={build.buildFingerprint}
                  >
                    {build.buildFingerprint ?? "not recorded yet"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-text-secondary">{build.domain ?? "unknown domain"}</div>
                    <div className="text-xs text-text-muted mt-1">
                      {build.trajectoryCount ?? "?"} trajectories · {build.documentCount ?? "?"}{" "}
                      documents
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {build.reused ? (
                      <span className="badge badge-success">
                        shared by {build.reuseCount} questions
                      </span>
                    ) : (
                      <span className="badge badge-neutral">1 question</span>
                    )}
                    {build.questionLinkMismatches.length > 0 && (
                      <div className="text-xs text-status-error mt-1">
                        {build.questionLinkMismatches.length} checkpoint link mismatch
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {build.priorBuildReuse === undefined ? (
                      <span className="text-xs text-text-muted">not reported yet</span>
                    ) : build.priorBuildReuse ? (
                      <span className="badge badge-success">checkpoint reused</span>
                    ) : (
                      <span className="badge badge-neutral">built for this run</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {build.stateStore.available ? (
                      <div>
                        <span
                          className={cn(
                            "badge",
                            getStatusColor(build.stateStore.status ?? "completed")
                          )}
                        >
                          {build.stateStore.status ?? "readable"}
                        </span>
                        {build.stateStore.documents && (
                          <div className="text-xs text-text-muted mt-1">
                            documents ·{" "}
                            {Object.entries(build.stateStore.documents)
                              .map(([status, count]) => `${status}: ${count}`)
                              .join(" · ")}
                          </div>
                        )}
                        {build.stateStore.trajectories && (
                          <div className="text-xs text-text-muted mt-1">
                            trajectories ·{" "}
                            {Object.entries(build.stateStore.trajectories)
                              .map(([status, count]) => `${status}: ${count}`)
                              .join(" · ")}
                          </div>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-text-muted" title={build.stateStore.reason}>
                        checkpoint summary only
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card border-accent/30 bg-accent/5">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div>
            <h2 className="text-lg font-display font-semibold text-text-primary">
              Official LongMemEval-V2 metrics
            </h2>
            <p className="text-sm text-text-secondary">
              This is the official benchmark protocol namespace. Failed, pending, and blocked
              questions remain in the full-set denominator.
            </p>
          </div>
          <span className="badge bg-accent/15 text-accent">longmemeval-v2-official</span>
        </div>
        {official ? (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <Metric
                label="full-set accuracy"
                value={percent(official.overall.overall_full_set)}
              />
              <Metric
                label="non-abstention"
                value={percent(official.overall.overall_non_abstention_only)}
              />
              <Metric
                label="abstention"
                value={percent(official.overall.overall_abstention_only)}
              />
              <Metric
                label="execution"
                value={`${official.execution.completed ?? 0}/${official.overall.count_all_questions}`}
                detail="completed / selected"
              />
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-3">
              {Object.entries(official.non_abstention_by_category).map(([category, breakdown]) => (
                <Metric
                  key={category}
                  label={category}
                  value={percent(breakdown.pct_correct)}
                  detail={`${breakdown.count} questions`}
                />
              ))}
            </div>
          </>
        ) : (
          <p className="text-sm text-text-muted">
            No official report exists yet. Checkpoint progress is not presented as a benchmark
            score.
          </p>
        )}
      </section>

      <section className="card">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div>
            <h2 className="text-lg font-display font-semibold text-text-primary">
              MemoryBench diagnostics
            </h2>
            <p className="text-sm text-text-secondary">
              Operational evidence for cache, retrieval latency, and screenshots. These values are
              not official LongMemEval-V2 scores.
            </p>
          </div>
          <span className="badge badge-neutral">not an official score</span>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <Metric
            label="query cache hits"
            value={String(diagnostics?.queryCacheHits ?? run.summary.query.cacheHits)}
          />
          <Metric
            label="reader cache hits"
            value={String(diagnostics?.readerCacheHits ?? run.summary.read.cacheHits)}
          />
          <Metric
            label="remote search mean"
            value={
              average(diagnostics?.remoteSearchLatencyMs) === null
                ? "—"
                : formatDuration(average(diagnostics?.remoteSearchLatencyMs)!)
            }
          />
          <Metric
            label="query wall mean"
            value={
              average(diagnostics?.queryWallLatencyMs) === null
                ? "—"
                : formatDuration(average(diagnostics?.queryWallLatencyMs)!)
            }
          />
          <Metric label="screenshots sent" value={String(diagnostics?.contextImagesSent ?? 0)} />
        </div>
      </section>

      <section className="card">
        <h2 className="text-lg font-display font-semibold text-text-primary mb-3">
          Run provenance
        </h2>
        <div className="grid md:grid-cols-2 gap-x-8 gap-y-3 text-sm">
          <Provenance label="Run config fingerprint" value={run.configFingerprint} />
          <Provenance
            label="Dataset fingerprint"
            value={run.datasetFingerprint ?? "not recorded yet"}
          />
          <Provenance label="Dataset revision" value={run.config.datasetRevision} />
          <Provenance label="Dataset slice" value={`${run.config.tier} · ${run.config.domain}`} />
          <Provenance
            label="Haystack selection"
            value={
              run.config.haystackLimit
                ? `first ${run.config.haystackLimit} exact haystack${run.config.haystackLimit === 1 ? "" : "s"}`
                : `${run.buildIds.length} planned exact haystack${run.buildIds.length === 1 ? "" : "s"}`
            }
          />
          <Provenance
            label="Retrieval"
            value={`${run.config.retrieval.searchMode} · top ${run.config.retrieval.topK} · rerank ${run.config.retrieval.rerank ? "on" : "off"}`}
          />
          <Provenance
            label="Live-service preflight"
            value={
              run.preflightGate
                ? `passed ${formatDate(run.preflightGate.generatedAt)} · tested top ${run.preflightGate.testedTopK}`
                : run.config.provider === "supermemory"
                  ? "not recorded (plan-only or blocked before build)"
                  : "not required for this local provider adapter"
            }
          />
          <Provenance
            label="Preflight fingerprint"
            value={run.preflightGate?.reportFingerprint ?? "not recorded"}
          />
          <Provenance
            label="Reader"
            value={`${run.config.reader.model} · ${run.config.reader.reasoningEffort}`}
          />
          <Provenance
            label="Evaluator"
            value={`${run.config.evaluator.model} · ${run.config.evaluator.reasoningEffort}`}
          />
          <Provenance
            label="Screenshot policy"
            value={`max ${run.config.reader.maxImages} images · ${run.config.reader.maxImageBytes.toLocaleString()} bytes each`}
          />
          <Provenance
            label="Execution concurrency"
            value={`${run.config.execution.buildConcurrency} builds · ${run.config.build.trajectoryConcurrency} trajectories/build · ${run.config.build.maxInFlightRequests} provider requests · ${run.config.execution.questionConcurrency} questions`}
          />
          <Provenance
            label="Ingestion bounds"
            value={`${Math.round(run.config.build.indexingTimeoutMs / 60_000)} min/trajectory · ${run.config.build.maxTrajectoryAttempts} attempts · ${run.config.build.continueOnIndexingTimeout ? "skip after timeout" : "strict timeout"}`}
          />
        </div>
      </section>

      <section>
        <div className="flex items-end justify-between gap-3 mb-3">
          <div>
            <h2 className="text-lg font-display font-semibold text-text-primary">Questions</h2>
            <p className="text-sm text-text-secondary">
              {run.summary.evaluate.completed}/{run.summary.total} officially evaluated
            </p>
          </div>
        </div>
        {questionsError && (
          <div className="mb-3 rounded border border-status-error/30 bg-status-error/5 p-3 text-sm text-status-error">
            {questionsError}
          </div>
        )}
        <div className="border border-border rounded overflow-hidden">
          {questionsLoading && questions.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-text-secondary">
              Loading questions…
            </div>
          )}
          {questions.map((question, index) => {
            const evaluation = question.evaluationArtifact
            return (
              <Link
                key={question.questionId}
                href={`/runs/${encodeURIComponent(run.runId)}/questions/${encodeURIComponent(
                  question.questionId
                )}`}
                className={cn(
                  "flex items-center gap-3 px-4 py-3 bg-bg-secondary hover:bg-bg-elevated transition-colors",
                  index < questions.length - 1 && "border-b border-border"
                )}
              >
                <span
                  className={cn(
                    "w-2 h-2 rounded-full",
                    evaluation?.label === "correct"
                      ? "bg-status-success"
                      : evaluation?.label === "incorrect"
                        ? "bg-status-error"
                        : "bg-text-muted"
                  )}
                />
                <span className="font-mono text-sm text-accent w-[150px] truncate">
                  {question.questionId}
                </span>
                <span className="badge badge-neutral">{question.questionType}</span>
                <span className="text-sm text-text-primary truncate flex-1">
                  {question.question}
                </span>
                <span className="text-xs text-text-muted font-mono">{question.buildId}</span>
                <span
                  className={cn(
                    "badge",
                    evaluation?.label === "correct"
                      ? "badge-success"
                      : evaluation?.label === "incorrect"
                        ? "badge-error"
                        : getStatusColor(question.stages.evaluate.status)
                  )}
                >
                  {evaluation?.label ?? question.stages.evaluate.status}
                </span>
              </Link>
            )
          })}
        </div>
        {questionPageData && questionPageData.pagination.totalPages > 1 && (
          <div className="mt-3 flex items-center justify-between gap-3 text-sm">
            <span className="text-text-secondary">
              Page {questionPageData.pagination.page} of {questionPageData.pagination.totalPages} ·{" "}
              {questionPageData.pagination.total} questions
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setQuestionPage((page) => Math.max(1, page - 1))}
                disabled={questionPageData.pagination.page <= 1 || questionsLoading}
                className="btn btn-secondary disabled:cursor-not-allowed disabled:opacity-50"
              >
                Previous
              </button>
              <button
                type="button"
                onClick={() =>
                  setQuestionPage((page) =>
                    Math.min(questionPageData.pagination.totalPages, page + 1)
                  )
                }
                disabled={
                  questionPageData.pagination.page >= questionPageData.pagination.totalPages ||
                  questionsLoading
                }
                className="btn btn-secondary disabled:cursor-not-allowed disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="bg-bg-primary/60 border border-border rounded p-3">
      <div className="text-xs uppercase tracking-wide text-text-muted">{label}</div>
      <div className="text-xl font-mono font-semibold text-text-primary mt-1">{value}</div>
      {detail && <div className="text-xs text-text-secondary mt-1">{detail}</div>}
    </div>
  )
}

function Provenance({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs uppercase tracking-wide text-text-muted">{label}</div>
      <div className="font-mono text-text-secondary break-all mt-0.5">{value}</div>
    </div>
  )
}
