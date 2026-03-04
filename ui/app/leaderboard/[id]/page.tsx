"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { Highlight, themes } from "prism-react-renderer"
import { getLeaderboardEntry, type LeaderboardEntry } from "@/lib/api"
import { cn } from "@/lib/utils"
import {
  StatsGrid,
  AccuracyByType,
  LatencyTable,
  RetrievalMetrics,
  EvaluationList,
  type EvaluationResult,
} from "@/components/benchmark-results"

type Tab = "overview" | "results" | "code"

export default function LeaderboardEntryPage() {
  const params = useParams()
  const id = parseInt(params.id as string)

  const [entry, setEntry] = useState<LeaderboardEntry | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<Tab>("overview")
  const [activeCodeFile, setActiveCodeFile] = useState<string>("index.ts")

  useEffect(() => {
    loadEntry()
  }, [id])

  async function loadEntry() {
    try {
      setLoading(true)
      const data = await getLeaderboardEntry(id)
      setEntry(data)
      setError(null)

      if (data.providerCode) {
        try {
          const files = JSON.parse(data.providerCode)
          const fileNames = Object.keys(files)
          if (fileNames.length > 0) {
            setActiveCodeFile(fileNames[0])
          }
        } catch {
          // Not JSON, just raw code
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load entry")
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

  if (error || !entry) {
    return (
      <div className="text-center py-12">
        <p className="text-status-error">{error || "Entry not found"}</p>
        <Link href="/leaderboard" className="btn btn-secondary mt-4">
          Back to Leaderboard
        </Link>
      </div>
    )
  }

  let codeFiles: Record<string, string> = {}
  try {
    codeFiles = JSON.parse(entry.providerCode)
  } catch {
    codeFiles = { "index.ts": entry.providerCode }
  }

  const codeFileNames = Object.keys(codeFiles)
  const evaluations: EvaluationResult[] = entry.evaluations || []

  const addedDate = new Date(entry.addedAt)
  const formattedDate = `${addedDate.getFullYear()}-${String(addedDate.getMonth() + 1).padStart(2, "0")}-${String(addedDate.getDate()).padStart(2, "0")}`

  const tabs: Tab[] = ["overview", "results", "code"]

  const statsCards = [
    {
      label: "accuracy",
      value: `${(entry.accuracy * 100).toFixed(1)}%`,
      subtext: `${entry.correctCount}/${entry.totalQuestions} correct`,
    },
    {
      label: "questions",
      value: entry.totalQuestions,
    },
    {
      label: "judge model",
      value: entry.judgeModel,
      mono: true,
    },
    {
      label: "answering model",
      value: entry.answeringModel,
      mono: true,
    },
  ]

  return (
    <div className="animate-fade-in">
      <div className="flex items-center gap-2 text-sm text-text-secondary mb-4">
        <Link href="/leaderboard" className="hover:text-text-primary">
          Leaderboard
        </Link>
        <span>/</span>
        <span className="text-text-primary font-mono">{entry.version}</span>
      </div>

      <div className="mb-6">
        <h1 className="text-2xl font-display font-semibold text-text-primary flex items-center gap-3">
          <span className="capitalize">{entry.provider}</span>
          <span className="text-text-muted font-normal">/</span>
          <span className="font-mono text-lg text-text-secondary">{entry.version}</span>
        </h1>
        <div className="flex items-center gap-4 mt-2 text-sm text-text-secondary">
          <span>
            <span className="text-text-muted">benchmark:</span>{" "}
            <span className="capitalize">{entry.benchmark}</span>
          </span>
          <span>
            <span className="text-text-muted">original run:</span>{" "}
            <span className="font-mono">{entry.runId}</span>
          </span>
          <span>
            <span className="text-text-muted">added:</span> {formattedDate}
          </span>
        </div>
        {entry.notes && (
          <div className="mt-3 text-sm text-text-secondary bg-bg-elevated p-3 rounded border border-border">
            <span className="text-text-muted">notes:</span> {entry.notes}
          </div>
        )}
      </div>

      <div className="flex gap-1 border-b border-border mb-6">
        {tabs.map((tab) => (
          <button
            key={tab}
            className={cn(
              "px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px cursor-pointer",
              activeTab === tab
                ? "text-accent border-accent"
                : "text-text-secondary border-transparent hover:text-text-primary"
            )}
            onClick={() => setActiveTab(tab)}
          >
            {tab === "overview" && "Overview"}
            {tab === "results" && `Results (${evaluations.length})`}
            {tab === "code" && "Code"}
          </button>
        ))}
      </div>

      {activeTab === "overview" && (
        <div className="space-y-6">
          <StatsGrid cards={statsCards} />
          <AccuracyByType byQuestionType={entry.byQuestionType} />
          <LatencyTable latency={entry.latencyStats} />
          <RetrievalMetrics retrieval={entry.retrieval} byQuestionType={entry.byQuestionType} />
        </div>
      )}

      {activeTab === "results" && <EvaluationList evaluations={evaluations} />}

      {activeTab === "code" && (
        <CodeTab
          codeFiles={codeFiles}
          codeFileNames={codeFileNames}
          activeCodeFile={activeCodeFile}
          setActiveCodeFile={setActiveCodeFile}
        />
      )}
    </div>
  )
}

function CodeTab({
  codeFiles,
  codeFileNames,
  activeCodeFile,
  setActiveCodeFile,
}: {
  codeFiles: Record<string, string>
  codeFileNames: string[]
  activeCodeFile: string
  setActiveCodeFile: (file: string) => void
}) {
  const code = codeFiles[activeCodeFile] || "// No code available"

  return (
    <div className="pr-6">
      {codeFileNames.length > 1 && (
        <div className="flex gap-0 mb-4">
          {codeFileNames.map((fileName, index) => {
            const isSelected = activeCodeFile === fileName
            const isFirst = index === 0
            const isLast = index === codeFileNames.length - 1
            return (
              <button
                key={fileName}
                type="button"
                onClick={() => setActiveCodeFile(fileName)}
                className={cn(
                  "px-3 py-1.5 text-sm font-medium font-mono transition-colors border-t border-b border-r",
                  isFirst && "border-l rounded-l",
                  isLast && "rounded-r"
                )}
                style={{
                  backgroundColor: isSelected ? "rgb(34, 34, 34)" : "transparent",
                  borderColor: isSelected ? "rgb(34, 34, 34)" : "#444444",
                  color: isSelected ? "#ffffff" : "#888888",
                }}
              >
                {fileName}
              </button>
            )
          })}
        </div>
      )}

      <div className="bg-[#0d0d0d] rounded border border-border overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2 bg-bg-elevated border-b border-border">
          <span className="text-sm font-mono text-text-muted">{activeCodeFile}</span>
          <button
            className="text-xs text-text-muted hover:text-text-primary transition-colors cursor-pointer"
            onClick={() => navigator.clipboard.writeText(code)}
          >
            copy
          </button>
        </div>
        <Highlight theme={themes.oneDark} code={code} language="typescript">
          {({ style, tokens, getLineProps, getTokenProps }) => (
            <pre
              className="p-4 overflow-x-auto text-sm max-h-[600px] overflow-y-auto"
              style={{ ...style, background: "transparent", margin: 0 }}
            >
              {tokens.map((line, i) => (
                <div key={i} {...getLineProps({ line })}>
                  <span className="inline-block w-8 text-text-muted select-none text-right mr-4 text-xs">
                    {i + 1}
                  </span>
                  {line.map((token, key) => (
                    <span key={key} {...getTokenProps({ token })} />
                  ))}
                </div>
              ))}
            </pre>
          )}
        </Highlight>
      </div>
    </div>
  )
}
