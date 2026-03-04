"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { Highlight, themes } from "prism-react-renderer"
import { getQuestion } from "@/lib/api"
import { cn } from "@/lib/utils"

export default function QuestionDetailPage() {
  const params = useParams()
  const runId = decodeURIComponent(params.runId as string)
  const questionId = decodeURIComponent(params.questionId as string)

  const [question, setQuestion] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadQuestion()
  }, [runId, questionId])

  async function loadQuestion() {
    try {
      setLoading(true)
      const data = await getQuestion(runId, questionId)
      setQuestion(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load question")
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (error || !question) {
    return (
      <div className="text-center py-12">
        <p className="text-status-error">{error || "Question not found"}</p>
        <Link href={`/runs/${encodeURIComponent(runId)}`} className="btn btn-secondary mt-4">
          Back to run
        </Link>
      </div>
    )
  }

  const isCorrect = question.phases?.evaluate?.label === "correct"
  const searchResults =
    question.searchResultsFile?.results || question.phases?.search?.results || []
  const containerTag = question.containerTag || ""

  const copyContainerTag = () => {
    navigator.clipboard.writeText(containerTag)
  }

  return (
    <div className="max-w-4xl animate-fade-in">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-text-secondary mb-4">
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
        <span className="text-text-primary font-mono">{questionId}</span>
      </div>

      {/* Header */}
      <div className="flex items-start gap-4 mb-4">
        <div
          className={cn(
            "w-10 h-10 rounded flex items-center justify-center flex-shrink-0",
            isCorrect ? "bg-status-success/20" : "bg-status-error/20"
          )}
        >
          {isCorrect ? (
            <svg
              className="w-6 h-6 text-status-success"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          ) : (
            <svg
              className="w-6 h-6 text-status-error"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          )}
        </div>
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h1 className="text-xl font-display font-semibold text-text-primary">{questionId}</h1>
            <span className="badge badge-neutral">{question.questionType}</span>
            <span className={cn("badge", isCorrect ? "badge-success" : "badge-error")}>
              {isCorrect ? "Correct" : "Incorrect"}
            </span>
          </div>
          {/* Container Tag - below header */}
          {containerTag && (
            <button
              onClick={copyContainerTag}
              className="flex items-center gap-1.5 text-xs font-mono text-text-muted hover:text-text-primary transition-colors mt-1"
              title="Click to copy"
            >
              <span className="text-accent">{containerTag}</span>
              <svg
                className="w-3 h-3"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Question */}
      <div className="card mb-4 overflow-hidden">
        <h3 className="text-xs text-text-muted uppercase tracking-wide mb-2">Question</h3>
        <p className="text-text-primary break-words">{question.question}</p>
      </div>

      {/* Answer Comparison */}
      <div className="grid grid-cols-2 gap-4 mb-4">
        <div className="card overflow-hidden min-w-0">
          <h3 className="text-xs text-text-muted uppercase tracking-wide mb-2">Ground Truth</h3>
          <p className="text-text-primary font-medium break-words">{question.groundTruth}</p>
        </div>
        <div
          className={cn(
            "card border overflow-hidden min-w-0",
            isCorrect
              ? "border-status-success/30 bg-status-success/5"
              : "border-status-error/30 bg-status-error/5"
          )}
        >
          <h3 className="text-xs text-text-muted uppercase tracking-wide mb-2">Model Answer</h3>
          <p
            className={cn(
              "font-medium break-words",
              isCorrect ? "text-status-success" : "text-status-error"
            )}
          >
            {question.phases?.answer?.hypothesis || "No answer generated"}
          </p>
        </div>
      </div>

      {/* Evaluation */}
      {question.phases?.evaluate?.explanation && (
        <div className="card mb-4 overflow-hidden">
          <h3 className="text-xs text-text-muted uppercase tracking-wide mb-2">
            Evaluation Explanation
          </h3>
          <p className="text-text-secondary break-words">{question.phases.evaluate.explanation}</p>
        </div>
      )}

      {/* Search Results */}
      <div className="card">
        <h3 className="text-xs text-text-muted uppercase tracking-wide mb-3">
          Retrieved Context ({searchResults.length} results)
        </h3>
        {searchResults.length === 0 ? (
          <p className="text-text-muted text-sm">No search results available</p>
        ) : (
          <div className="space-y-3">
            {searchResults.map((result: any, idx: number) => {
              const jsonStr = JSON.stringify(result, null, 2)
              return (
                <div
                  key={idx}
                  className="bg-[#0d0d0d] rounded border border-border overflow-hidden"
                >
                  <div className="flex items-center justify-between px-3 py-2 bg-bg-elevated border-b border-border">
                    <span className="text-xs font-mono text-accent">Result #{idx + 1}</span>
                    {result.score !== undefined && (
                      <span className="text-xs text-text-muted">
                        Score:{" "}
                        {typeof result.score === "number" ? result.score.toFixed(3) : result.score}
                      </span>
                    )}
                  </div>
                  <Highlight theme={themes.oneDark} code={jsonStr} language="json">
                    {({ style, tokens, getLineProps, getTokenProps }) => (
                      <pre
                        className="p-3 overflow-x-auto text-sm max-h-[300px] overflow-y-auto"
                        style={{ ...style, background: "transparent", margin: 0 }}
                      >
                        {tokens.map((line, i) => (
                          <div key={i} {...getLineProps({ line })}>
                            {line.map((token, key) => (
                              <span key={key} {...getTokenProps({ token })} />
                            ))}
                          </div>
                        ))}
                      </pre>
                    )}
                  </Highlight>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
