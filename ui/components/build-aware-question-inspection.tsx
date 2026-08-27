"use client"

import { useState } from "react"
import Link from "next/link"
import {
  getBuildAwareAssetUrl,
  getBuildAwareArtifact,
  type BuildAwareAssetRef,
  type BuildAwareArtifactResponse,
  type BuildAwareQuestionDetail,
} from "@/lib/api"
import { cn, formatDuration, getStatusColor } from "@/lib/utils"

type ArtifactKind = BuildAwareArtifactResponse["kind"]

interface BuildAwareQuestionInspectionProps {
  runId: string
  question: BuildAwareQuestionDetail
}

function shortHash(value: string | undefined): string {
  if (!value) return "not recorded"
  return value.length > 20 ? `${value.slice(0, 12)}…${value.slice(-6)}` : value
}

export function BuildAwareQuestionInspection({
  runId,
  question,
}: BuildAwareQuestionInspectionProps) {
  const [artifacts, setArtifacts] = useState<
    Partial<Record<ArtifactKind, BuildAwareArtifactResponse>>
  >({})
  const [artifactErrors, setArtifactErrors] = useState<Partial<Record<ArtifactKind, string>>>({})
  const [loadingArtifact, setLoadingArtifact] = useState<ArtifactKind | null>(null)

  const query = question.queryArtifact
  const reader = question.readerArtifact
  const evaluation = question.evaluationArtifact
  const sentImages =
    reader?.parts
      .filter(
        (part): part is Extract<(typeof reader.parts)[number], { type: "image" }> =>
          part.type === "image" && reader.sentAssetIds.includes(part.asset.assetId)
      )
      .map((part) => part.asset) ?? []

  async function toggleArtifact(kind: ArtifactKind) {
    if (artifacts[kind]) {
      setArtifacts((current) => {
        const next = { ...current }
        delete next[kind]
        return next
      })
      return
    }
    try {
      setLoadingArtifact(kind)
      const artifact = await getBuildAwareArtifact(runId, question.questionId, kind)
      setArtifacts((current) => ({ ...current, [kind]: artifact }))
      setArtifactErrors((current) => ({ ...current, [kind]: undefined }))
    } catch (error) {
      setArtifactErrors((current) => ({
        ...current,
        [kind]: error instanceof Error ? error.message : "Artifact could not be loaded",
      }))
    } finally {
      setLoadingArtifact(null)
    }
  }

  return (
    <div className="max-w-6xl animate-fade-in space-y-5">
      <div className="flex items-center gap-2 text-sm text-text-secondary">
        <Link href="/runs" className="hover:text-text-primary">
          Runs
        </Link>
        <span>/</span>
        <Link
          href={`/runs/${encodeURIComponent(runId)}`}
          className="hover:text-text-primary font-mono"
        >
          {runId}
        </Link>
        <span>/</span>
        <span className="text-text-primary font-mono">{question.questionId}</span>
      </div>

      <div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-display font-semibold text-text-primary">
            {question.questionId}
          </h1>
          <span className="badge badge-neutral">{question.questionType}</span>
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
        </div>
        <p className="text-sm text-text-secondary mt-2">
          Build-aware LongMemEval-V2 inspection with checkpointed retrieval, reader, and evaluator
          provenance.
        </p>
      </div>

      <section className="card border-accent/25 bg-accent/5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-wide text-text-muted">Memory Build</div>
            <div className="font-mono text-lg text-accent mt-1">{question.buildId}</div>
            <div className="text-xs font-mono text-text-muted mt-1 break-all">
              {question.buildFingerprint ??
                query?.buildFingerprint ??
                "fingerprint not recorded yet"}
            </div>
          </div>
          <span
            className={cn(
              "badge",
              question.buildReuseCount > 1 ? "badge-success" : "badge-neutral"
            )}
          >
            {question.buildReuseCount > 1
              ? `reused by ${question.buildReuseCount} questions`
              : "single-question build"}
          </span>
        </div>
        {!question.buildLinkMatchesCheckpoint && (
          <p className="text-sm text-status-error mt-3">
            Checkpoint provenance mismatch: the question-to-build link does not match this
            question&apos;s recorded build ID.
          </p>
        )}
      </section>

      <section className="grid md:grid-cols-2 gap-4">
        <div className="card">
          <div className="text-xs uppercase tracking-wide text-text-muted mb-2">Question</div>
          <p className="text-text-primary break-words">{question.question}</p>
          <div className="text-xs text-text-muted mt-3">
            Evaluation function: <span className="font-mono">{question.evalFunction}</span>
          </div>
        </div>
        <div className="card">
          <div className="text-xs uppercase tracking-wide text-text-muted mb-2">Ground truth</div>
          <p className="text-text-primary font-medium break-words">{question.groundTruth}</p>
        </div>
      </section>

      <section className="card border-accent/30 bg-accent/5">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div>
            <h2 className="text-lg font-display font-semibold text-text-primary">
              Official LongMemEval-V2 evaluation
            </h2>
            <p className="text-sm text-text-secondary">
              Only the evaluator result in this panel contributes to the official benchmark
              aggregate.
            </p>
          </div>
          <span className="badge bg-accent/15 text-accent">longmemeval-v2-official</span>
        </div>
        {evaluation ? (
          <div className="grid md:grid-cols-[180px_1fr] gap-4">
            <div>
              <div
                className={cn(
                  "text-3xl font-mono font-semibold",
                  evaluation.score === 1 ? "text-status-success" : "text-status-error"
                )}
              >
                {evaluation.score}
              </div>
              <div className="text-sm text-text-secondary mt-1">{evaluation.label}</div>
            </div>
            <div className="space-y-3 min-w-0">
              <div>
                <div className="text-xs uppercase tracking-wide text-text-muted">Model answer</div>
                <p className="text-text-primary mt-1 break-words">{evaluation.answer}</p>
              </div>
              {evaluation.rationale && (
                <div>
                  <div className="text-xs uppercase tracking-wide text-text-muted">
                    Evaluator rationale
                  </div>
                  <p className="text-text-secondary mt-1 break-words">{evaluation.rationale}</p>
                </div>
              )}
              <div className="grid sm:grid-cols-2 gap-3 text-sm">
                <Provenance label="Evaluator fingerprint" value={evaluation.evaluatorFingerprint} />
                <Provenance
                  label="Evaluator model"
                  value={evaluation.evaluatorModel ?? "deterministic evaluator"}
                />
                <Provenance label="Prompt version" value={evaluation.promptVersion} />
                <Provenance
                  label="Implementation version"
                  value={evaluation.implementationVersion}
                />
                <Provenance
                  label="Evaluation artifact cache"
                  value={question.stages.evaluate.cacheHit ? "hit" : "miss"}
                />
              </div>
              {(evaluation.request || evaluation.rawResponse !== undefined) && (
                <details className="border border-border rounded p-3">
                  <summary className="text-sm text-text-secondary cursor-pointer">
                    Evaluator request and raw response
                  </summary>
                  <pre className="text-xs text-text-muted overflow-x-auto mt-3 whitespace-pre-wrap">
                    {JSON.stringify(
                      {
                        request: evaluation.request,
                        rawResponse: evaluation.rawResponse,
                      },
                      null,
                      2
                    )}
                  </pre>
                </details>
              )}
              <button
                type="button"
                disabled={
                  !question.artifactLinks.evaluation.available || loadingArtifact === "evaluation"
                }
                onClick={() => toggleArtifact("evaluation")}
                className={cn(
                  "btn btn-secondary text-sm",
                  (!question.artifactLinks.evaluation.available ||
                    loadingArtifact === "evaluation") &&
                    "opacity-50 cursor-not-allowed"
                )}
                title={question.artifactLinks.evaluation.href}
              >
                {loadingArtifact === "evaluation"
                  ? "Loading…"
                  : artifacts.evaluation
                    ? "Hide evaluation artifact"
                    : "View evaluation artifact"}
              </button>
              <ArtifactPanel
                kind="evaluation"
                artifact={artifacts.evaluation}
                error={artifactErrors.evaluation}
                checkpointProvenance={question.artifactLinks.evaluation.provenance}
              />
            </div>
          </div>
        ) : (
          <div>
            <p className="text-sm text-text-muted">
              Evaluation is {question.stages.evaluate.status}. No score is shown.
            </p>
            {question.stages.evaluate.error && (
              <p className="text-sm text-status-error mt-2">{question.stages.evaluate.error}</p>
            )}
            {question.artifactLinks.evaluation.available && (
              <div className="mt-3">
                <button
                  type="button"
                  disabled={loadingArtifact === "evaluation"}
                  onClick={() => toggleArtifact("evaluation")}
                  className={cn(
                    "btn btn-secondary text-sm",
                    loadingArtifact === "evaluation" && "opacity-50 cursor-not-allowed"
                  )}
                  title={question.artifactLinks.evaluation.href}
                >
                  {loadingArtifact === "evaluation"
                    ? "Loading…"
                    : artifacts.evaluation
                      ? "Hide failed evaluation artifact"
                      : "View failed evaluation artifact"}
                </button>
                <ArtifactPanel
                  kind="evaluation"
                  artifact={artifacts.evaluation}
                  error={artifactErrors.evaluation}
                  checkpointProvenance={question.artifactLinks.evaluation.provenance}
                />
              </div>
            )}
          </div>
        )}
      </section>

      <section className="card">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div>
            <h2 className="text-lg font-display font-semibold text-text-primary">
              Retrieval diagnostics
            </h2>
            <p className="text-sm text-text-secondary">
              Retrieval content, latency, cache state, and provenance are MemoryBench
              diagnostics—not official benchmark metrics. Referenced screenshots are served only
              after the server verifies their allowlist entry, hash, size, and MIME type.
            </p>
          </div>
          <span className="badge badge-neutral">not an official score</span>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-5">
          <Metric
            label="query cache"
            value={
              query
                ? query.cacheHit || question.stages.query.cacheHit
                  ? "hit"
                  : "miss"
                : "not run"
            }
          />
          <Metric label="top K" value={query ? String(query.config.topK) : "—"} />
          <Metric
            label="remote search"
            value={query ? formatDuration(query.remoteDurationMs) : "—"}
          />
          <Metric label="query wall" value={query ? formatDuration(query.wallDurationMs) : "—"} />
          <Metric label="results" value={query ? String(query.normalizedResults.length) : "—"} />
        </div>

        {query && (
          <div className="grid md:grid-cols-2 gap-4 mb-5 text-sm">
            <Provenance label="Query fingerprint" value={query.queryFingerprint} />
            <Provenance label="Build fingerprint" value={query.buildFingerprint} />
            <Provenance
              label="Search mode"
              value={`${query.config.searchMode} · threshold ${query.config.threshold} · rerank ${query.config.rerank ? "on" : "off"} · rewrite ${query.config.rewriteQuery ? "on" : "off"}`}
            />
            <Provenance
              label="Metadata filter"
              value={JSON.stringify(query.config.metadataFilter)}
            />
          </div>
        )}

        <div className="flex flex-wrap gap-2 mb-4">
          {(["query-raw", "query-normalized"] as ArtifactKind[]).map((kind) => {
            const link = question.artifactLinks[kind]
            return (
              <button
                key={kind}
                type="button"
                disabled={!link.available || loadingArtifact === kind}
                onClick={() => toggleArtifact(kind)}
                className={cn(
                  "btn btn-secondary text-sm",
                  (!link.available || loadingArtifact === kind) && "opacity-50 cursor-not-allowed"
                )}
                title={link.href}
              >
                {loadingArtifact === kind
                  ? "Loading…"
                  : artifacts[kind]
                    ? `Hide ${kind === "query-raw" ? "raw provider response" : "normalized artifact"}`
                    : `View ${kind === "query-raw" ? "raw provider response" : "normalized artifact"}`}
              </button>
            )
          })}
        </div>

        {(["query-raw", "query-normalized"] as ArtifactKind[]).map((kind) => (
          <ArtifactPanel
            key={kind}
            kind={kind}
            artifact={artifacts[kind]}
            error={artifactErrors[kind]}
            checkpointProvenance={question.artifactLinks[kind].provenance}
          />
        ))}

        <div className="space-y-3">
          {query?.normalizedResults.map((result) => (
            <div
              key={`${result.rank}-${result.providerResultId ?? result.text}`}
              className="border border-border rounded p-3"
            >
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <span className="font-mono text-sm text-accent">#{result.rank}</span>
                <span className="badge badge-neutral">{result.kind}</span>
                {result.score !== undefined && (
                  <span className="text-xs font-mono text-text-muted">
                    score {result.score.toFixed(4)}
                  </span>
                )}
                <span
                  className={cn(
                    "text-xs",
                    result.provenanceValid ? "text-status-success" : "text-status-error"
                  )}
                >
                  provenance {result.provenanceValid ? "valid" : "invalid"}
                </span>
              </div>
              <p className="text-sm text-text-primary whitespace-pre-wrap break-words">
                {result.text}
              </p>
              <div className="mt-2 text-xs font-mono text-text-muted break-all">
                documents: {result.documentIds.join(", ") || "none"}
                {result.trajectoryId ? ` · trajectory: ${result.trajectoryId}` : ""}
                {result.stateIndex !== undefined ? ` · state: ${result.stateIndex}` : ""}
              </div>
              {result.screenshotRefs.length > 0 && (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {result.screenshotRefs.map((asset, assetIndex) => (
                    <VerifiedScreenshot
                      key={`${result.rank}-${asset.assetId}`}
                      runId={runId}
                      questionId={question.questionId}
                      asset={asset}
                      orderLabel={`Result #${result.rank} · evidence ${assetIndex + 1}`}
                      alt={`Retrieved screenshot ${assetIndex + 1} for LongMemEval-V2 result ${result.rank}, asset ${asset.assetId}`}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}
          {!query?.normalizedResults.length && (
            <p className="text-sm text-text-muted">No normalized retrieval results recorded.</p>
          )}
        </div>
      </section>

      <section className="card">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div>
            <h2 className="text-lg font-display font-semibold text-text-primary">
              Reader provenance
            </h2>
            <p className="text-sm text-text-secondary">
              Exact reader model, prompt fingerprint, answer, omissions, and image inputs recorded
              for this question.
            </p>
          </div>
          <span
            className={cn(
              "badge",
              reader?.cacheHit || question.stages.read.cacheHit ? "badge-success" : "badge-neutral"
            )}
          >
            reader cache{" "}
            {reader
              ? reader.cacheHit || question.stages.read.cacheHit
                ? "hit"
                : "miss"
              : "not run"}
          </span>
        </div>
        {reader ? (
          <div className="space-y-4">
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
              <Provenance label="Model" value={reader.model} />
              <Provenance
                label="Reasoning effort"
                value={reader.reasoningEffort ?? "not recorded"}
              />
              <Provenance label="Reader fingerprint" value={reader.readerFingerprint} />
              <Provenance label="Duration" value={formatDuration(reader.durationMs)} />
            </div>
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <div className="text-xs uppercase tracking-wide text-text-muted">Parsed answer</div>
                <p className="text-text-primary mt-1 break-words">{reader.parsedAnswer}</p>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-text-muted">
                  Reader response
                </div>
                <p className="text-text-secondary mt-1 break-words">{reader.responseText}</p>
              </div>
            </div>
            <div className="text-xs text-text-muted">
              {reader.parts.length} message parts · {reader.omittedItems} omitted items
              {reader.usage ? ` · usage ${JSON.stringify(reader.usage)}` : ""}
            </div>
            <details className="border border-border rounded p-3">
              <summary className="text-sm text-text-secondary cursor-pointer">
                Reader system prompt
              </summary>
              <pre className="text-xs text-text-muted whitespace-pre-wrap mt-3 break-words">
                {reader.systemPrompt}
              </pre>
            </details>
            <button
              type="button"
              disabled={!question.artifactLinks.reader.available || loadingArtifact === "reader"}
              onClick={() => toggleArtifact("reader")}
              className={cn(
                "btn btn-secondary text-sm",
                (!question.artifactLinks.reader.available || loadingArtifact === "reader") &&
                  "opacity-50 cursor-not-allowed"
              )}
              title={question.artifactLinks.reader.href}
            >
              {loadingArtifact === "reader"
                ? "Loading…"
                : artifacts.reader
                  ? "Hide reader artifact"
                  : "View reader artifact"}
            </button>
            <ArtifactPanel
              kind="reader"
              artifact={artifacts.reader}
              error={artifactErrors.reader}
              checkpointProvenance={question.artifactLinks.reader.provenance}
            />
          </div>
        ) : (
          <div>
            <p className="text-sm text-text-muted">
              Reader stage is {question.stages.read.status}. No reader artifact exists.
            </p>
            {question.stages.read.error && (
              <p className="text-sm text-status-error mt-2">{question.stages.read.error}</p>
            )}
          </div>
        )}
      </section>

      <section className="card">
        <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
          <div>
            <h2 className="text-lg font-display font-semibold text-text-primary">
              Screenshots sent to the reader
            </h2>
            <p className="text-sm text-text-secondary">
              Only assets in the reader&apos;s sent-asset list appear here. Each image is loaded
              from the hash-verified asset endpoint.
            </p>
          </div>
          <span className="badge badge-neutral">{sentImages.length} sent</span>
        </div>
        {sentImages.length ? (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {sentImages.map((asset, index) => (
                <VerifiedScreenshot
                  key={asset.assetId}
                  runId={runId}
                  questionId={question.questionId}
                  asset={asset}
                  orderLabel={`Reader evidence ${index + 1}`}
                  alt={`${asset.kind === "question-image" ? "Question image" : "Trajectory screenshot"} sent as reader evidence ${index + 1}, asset ${asset.assetId}`}
                />
              ))}
            </div>
            <div className="border border-border rounded overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-bg-elevated text-text-muted">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Order</th>
                    <th className="px-3 py-2 text-left font-medium">Asset ID</th>
                    <th className="px-3 py-2 text-left font-medium">SHA-256</th>
                    <th className="px-3 py-2 text-left font-medium">MIME</th>
                    <th className="px-3 py-2 text-right font-medium">Bytes</th>
                    <th className="px-3 py-2 text-left font-medium">Artifact path</th>
                  </tr>
                </thead>
                <tbody>
                  {sentImages.map((asset, index) => (
                    <tr key={asset.assetId} className="border-t border-border">
                      <td className="px-3 py-2 font-mono text-text-secondary">{index + 1}</td>
                      <td className="px-3 py-2 font-mono text-accent">{asset.assetId}</td>
                      <td className="px-3 py-2 font-mono text-text-secondary" title={asset.sha256}>
                        {shortHash(asset.sha256)}
                      </td>
                      <td className="px-3 py-2">{asset.mimeType}</td>
                      <td className="px-3 py-2 text-right font-mono">
                        {asset.byteLength.toLocaleString()}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-text-muted">
                        {asset.relativePath}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <p className="text-sm text-text-muted">
            No screenshot assets were sent for this reader request.
          </p>
        )}
      </section>
    </div>
  )
}

function VerifiedScreenshot({
  runId,
  questionId,
  asset,
  orderLabel,
  alt,
}: {
  runId: string
  questionId: string
  asset: BuildAwareAssetRef
  orderLabel: string
  alt: string
}) {
  const [failed, setFailed] = useState(false)
  const assetUrl = getBuildAwareAssetUrl(runId, questionId, asset.assetId)

  return (
    <figure className="overflow-hidden rounded border border-border bg-bg-primary">
      {failed ? (
        <div className="flex min-h-36 items-center justify-center p-4 text-center text-sm text-status-error">
          Screenshot could not be loaded or failed server-side integrity verification.
        </div>
      ) : (
        <a href={assetUrl} target="_blank" rel="noreferrer" className="block bg-black/20">
          <img
            src={assetUrl}
            alt={alt}
            loading="lazy"
            onError={() => setFailed(true)}
            className="max-h-96 w-full object-contain"
          />
        </a>
      )}
      <figcaption className="space-y-1 border-t border-border p-2 text-xs">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium text-text-secondary">{orderLabel}</span>
          <span className="badge badge-neutral">{asset.kind}</span>
        </div>
        <div className="break-all font-mono text-accent">{asset.assetId}</div>
        <div className="break-all font-mono text-text-muted" title={asset.sha256}>
          sha256 {shortHash(asset.sha256)} · {asset.byteLength.toLocaleString()} bytes
        </div>
      </figcaption>
    </figure>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-bg-primary border border-border rounded p-3">
      <div className="text-xs uppercase tracking-wide text-text-muted">{label}</div>
      <div className="text-lg font-mono text-text-primary mt-1">{value}</div>
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

function ArtifactPanel({
  kind,
  artifact,
  error,
  checkpointProvenance,
}: {
  kind: ArtifactKind
  artifact?: BuildAwareArtifactResponse
  error?: string
  checkpointProvenance: BuildAwareQuestionDetail["artifactLinks"][ArtifactKind]["provenance"]
}) {
  if (!artifact && !error) return null
  return (
    <div className="border border-border rounded mb-4 overflow-hidden">
      <div className="px-3 py-2 bg-bg-elevated border-b border-border flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-mono text-accent">{kind}</span>
        <span className="text-xs font-mono text-text-muted">
          {"relativePath" in checkpointProvenance
            ? `${checkpointProvenance.relativePath} · ${shortHash(checkpointProvenance.sha256)} · ${checkpointProvenance.byteLength?.toLocaleString() ?? "?"} bytes`
            : "embedded in checkpoint"}
        </span>
      </div>
      {error ? (
        <p className="p-3 text-sm text-status-error">{error}</p>
      ) : (
        <pre className="p-3 text-xs text-text-secondary overflow-auto max-h-[480px] whitespace-pre-wrap">
          {JSON.stringify(artifact?.data, null, 2)}
        </pre>
      )}
    </div>
  )
}
