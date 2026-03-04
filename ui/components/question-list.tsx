"use client"

import { useState, useMemo } from "react"
import Link from "next/link"
import { cn } from "@/lib/utils"
import { MultiSelect } from "./multi-select"
import type { QuestionCheckpoint, QuestionTypeRegistry } from "@/lib/api"

interface QuestionListProps {
  runId: string
  questions: QuestionCheckpoint[]
  questionTypeRegistry?: QuestionTypeRegistry | null
}

export function QuestionList({ runId, questions, questionTypeRegistry }: QuestionListProps) {
  const [search, setSearch] = useState("")
  const [selectedTypes, setSelectedTypes] = useState<string[]>([])
  const [showFailuresOnly, setShowFailuresOnly] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  // Get unique question types with counts
  const questionTypes = useMemo(() => {
    const counts: Record<string, number> = {}
    questions.forEach((q) => {
      counts[q.questionType] = (counts[q.questionType] || 0) + 1
    })
    return Object.entries(counts).map(([value, count]) => ({
      value,
      label: questionTypeRegistry?.[value]?.alias || value.replace(/[-_]/g, " "),
      count,
    }))
  }, [questions, questionTypeRegistry])

  // Count failures
  const failureCount = useMemo(() => {
    return questions.filter((q) => q.phases.evaluate.label === "incorrect").length
  }, [questions])

  // Filter questions
  const filtered = useMemo(() => {
    return questions.filter((q) => {
      // Failures filter
      if (showFailuresOnly && q.phases.evaluate.label !== "incorrect") {
        return false
      }

      // Search filter
      if (search) {
        const searchLower = search.toLowerCase()
        const matchesSearch =
          q.questionId.toLowerCase().includes(searchLower) ||
          q.question.toLowerCase().includes(searchLower) ||
          q.groundTruth.toLowerCase().includes(searchLower)
        if (!matchesSearch) return false
      }

      // Type filter
      if (selectedTypes.length > 0 && !selectedTypes.includes(q.questionType)) {
        return false
      }

      return true
    })
  }, [questions, search, selectedTypes, showFailuresOnly])

  const hasActiveFilters = search || selectedTypes.length > 0 || showFailuresOnly

  if (questions.length === 0) {
    return <div className="text-center py-8 text-text-secondary">No questions found</div>
  }

  return (
    <div>
      {/* Filter Bar */}
      <div className="mb-4">
        {/* Header row */}
        <div className="flex items-center justify-between text-sm px-1 mb-2">
          <span className="text-text-secondary">
            Showing {filtered.length} of {questions.length}{" "}
            {questions.length === 1 ? "question" : "questions"}
          </span>
          <button
            type="button"
            className={cn(
              "text-text-muted hover:text-text-primary transition-colors cursor-pointer",
              !hasActiveFilters && "opacity-50"
            )}
            onClick={() => {
              setSearch("")
              setSelectedTypes([])
              setShowFailuresOnly(false)
            }}
          >
            Clear filters
          </button>
        </div>

        {/* Filter bar */}
        <div className="inline-flex border border-[#333333] rounded">
          {/* Search input */}
          <div className="w-[200px] border-r border-[#333333]">
            <div className="relative h-[40px] flex items-center">
              <svg
                className="absolute left-3 w-4 h-4 text-text-muted"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
              <input
                type="text"
                placeholder="Search questions..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full h-full pl-9 pr-3 text-sm bg-transparent text-text-primary placeholder-text-muted focus:outline-none cursor-text"
              />
            </div>
          </div>

          {/* Type filter */}
          <div className="w-[180px] border-r border-[#333333]">
            <MultiSelect
              label="Select question types"
              options={questionTypes}
              selected={selectedTypes}
              onChange={setSelectedTypes}
              placeholder="All types"
            />
          </div>

          {/* Failures toggle */}
          <button
            type="button"
            className={cn(
              "w-[120px] h-[40px] flex items-center justify-center gap-2 text-sm transition-colors cursor-pointer",
              showFailuresOnly
                ? "bg-status-error/10 text-status-error"
                : "text-text-muted hover:text-text-primary"
            )}
            onClick={() => setShowFailuresOnly(!showFailuresOnly)}
          >
            <span>Failures</span>
            <span
              className={cn(
                "text-xs px-1.5 py-0.5 rounded",
                showFailuresOnly ? "bg-status-error/20" : "bg-bg-elevated"
              )}
            >
              {failureCount}
            </span>
          </button>
        </div>
      </div>

      {/* Questions - Table style */}
      {filtered.length === 0 ? (
        <div className="text-center py-8 text-text-secondary">
          {showFailuresOnly ? "No failures found" : "No questions match your filters"}
        </div>
      ) : (
        <div className="border border-border rounded overflow-hidden">
          {filtered.map((q, idx) => {
            const isCorrect = q.phases.evaluate.label === "correct"
            const isExpanded = expanded === q.questionId
            const isLast = idx === filtered.length - 1

            return (
              <div
                key={q.questionId}
                className={cn(
                  "bg-bg-secondary cursor-pointer transition-colors hover:bg-bg-elevated",
                  !isLast && !isExpanded && "border-b border-border"
                )}
              >
                {/* Row */}
                <div
                  className="px-4 py-3 flex items-center gap-3"
                  onClick={() => setExpanded(isExpanded ? null : q.questionId)}
                >
                  {/* Status indicator */}
                  <div
                    className={cn(
                      "w-2 h-2 rounded-full flex-shrink-0",
                      isCorrect ? "bg-status-success" : "bg-status-error"
                    )}
                  />

                  {/* Question ID */}
                  <span className="font-mono text-sm text-text-secondary w-[140px] flex-shrink-0">
                    {q.questionId}
                  </span>

                  {/* Type badge */}
                  <span
                    className="text-xs px-2 py-0.5 rounded bg-bg-primary text-text-muted flex-shrink-0 cursor-default"
                    title={q.questionType}
                  >
                    {questionTypeRegistry?.[q.questionType]?.alias ||
                      q.questionType.replace(/[-_]/g, " ")}
                  </span>

                  {/* Question text */}
                  <span className="text-sm text-text-primary flex-1 min-w-0 truncate">
                    {q.question}
                  </span>

                  {/* Status label */}
                  <span
                    className={cn(
                      "text-sm font-medium flex-shrink-0",
                      isCorrect ? "text-status-success" : "text-status-error"
                    )}
                  >
                    {isCorrect ? "correct" : "incorrect"}
                  </span>

                  {/* Expand icon */}
                  <svg
                    className={cn(
                      "w-4 h-4 text-text-muted transition-transform flex-shrink-0",
                      isExpanded && "rotate-180"
                    )}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </div>

                {/* Expanded content */}
                {isExpanded && (
                  <div
                    className={cn(
                      "px-4 py-4 space-y-4 bg-bg-primary border-t border-border overflow-hidden",
                      !isLast && "border-b border-border"
                    )}
                  >
                    {/* Question */}
                    <div className="min-w-0">
                      <div className="text-xs text-text-muted uppercase tracking-wide mb-1">
                        Question
                      </div>
                      <div className="text-sm text-text-primary break-words">{q.question}</div>
                    </div>

                    <div className="grid grid-cols-2 gap-4 min-w-0">
                      <div className="min-w-0">
                        <div className="text-xs text-text-muted uppercase tracking-wide mb-1">
                          Ground Truth
                        </div>
                        <div className="text-sm text-text-primary font-mono bg-bg-elevated p-2 rounded break-words">
                          {q.groundTruth}
                        </div>
                      </div>
                      <div className="min-w-0">
                        <div className="text-xs text-text-muted uppercase tracking-wide mb-1">
                          Model Answer
                        </div>
                        <div className="text-sm text-text-primary font-mono bg-bg-elevated p-2 rounded break-words">
                          {q.phases.answer.hypothesis || "—"}
                        </div>
                      </div>
                    </div>

                    {q.phases.evaluate.explanation && (
                      <div className="min-w-0">
                        <div className="text-xs text-text-muted uppercase tracking-wide mb-1">
                          Explanation
                        </div>
                        <div className="text-sm text-text-secondary break-words">
                          {q.phases.evaluate.explanation}
                        </div>
                      </div>
                    )}

                    <div className="flex justify-end">
                      <Link
                        href={`/runs/${encodeURIComponent(runId)}/questions/${encodeURIComponent(q.questionId)}`}
                        className="text-sm text-accent hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        View full details →
                      </Link>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
