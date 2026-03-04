"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"
import { Tooltip } from "@/components/tooltip"

interface PhaseProgressProps {
  summary: {
    total: number
    ingested: number
    indexed: number
    searched: number
    answered: number
    evaluated: number
    indexingEpisodes?: {
      total: number
      completed: number
      failed: number
    }
  }
}

const phases = [
  { key: "ingested", label: "Ingest" },
  { key: "indexed", label: "Index" },
  { key: "searched", label: "Search" },
  { key: "answered", label: "Answer" },
  { key: "evaluated", label: "Evaluate" },
] as const

export function PhaseProgress({ summary }: PhaseProgressProps) {
  const [lockedEpisodes, setLockedEpisodes] = useState(false)
  const [isHovering, setIsHovering] = useState(false)
  const [justClicked, setJustClicked] = useState(false)

  return (
    <div className="card">
      <style jsx>{`
        @keyframes shimmer {
          0% {
            background-position: -200% 0;
          }
          100% {
            background-position: 200% 0;
          }
        }
        .shimmer-bar {
          background: linear-gradient(
            90deg,
            #3b82f6 0%,
            #60a5fa 25%,
            #93c5fd 50%,
            #60a5fa 75%,
            #3b82f6 100%
          );
          background-size: 200% 100%;
          animation: shimmer 2s linear infinite;
        }
      `}</style>
      <h3 className="text-sm font-medium text-text-primary mb-4">Pipeline Progress</h3>
      <div className="flex items-center gap-2">
        {phases.map((phase) => {
          const count = summary[phase.key]
          const progress = (count / summary.total) * 100
          const isComplete = count === summary.total
          const isInProgress = count > 0 && count < summary.total
          const isPending = count === 0

          const episodes = summary.indexingEpisodes
          const canToggleEpisodes =
            phase.key === "indexed" && episodes && episodes.total > 0 && !isComplete

          const shouldPreview = isHovering && !justClicked
          const isShowingEpisodes =
            canToggleEpisodes && (shouldPreview ? !lockedEpisodes : lockedEpisodes)

          const displayLabel = isShowingEpisodes ? "Episodes Indexed" : phase.label
          const displayCount = isShowingEpisodes ? episodes.completed : count
          const displayTotal = isShowingEpisodes ? episodes.total : summary.total
          const displayProgress = isShowingEpisodes
            ? (episodes.completed / episodes.total) * 100
            : progress

          if (canToggleEpisodes) {
            const content = (
              <div
                className="flex-1 cursor-pointer"
                onMouseEnter={() => setIsHovering(true)}
                onMouseLeave={() => {
                  setIsHovering(false)
                  setJustClicked(false)
                }}
                onClick={() => {
                  setLockedEpisodes(!lockedEpisodes)
                  setJustClicked(true)
                }}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs text-text-secondary">{displayLabel}</span>
                  <span className="text-xs font-mono text-text-muted">
                    {displayCount}/{displayTotal}
                    {isShowingEpisodes && episodes.failed > 0 && (
                      <span className="text-status-error ml-1">({episodes.failed} failed)</span>
                    )}
                  </span>
                </div>
                <div className="h-2 bg-bg-elevated overflow-hidden">
                  <div
                    className={cn(
                      "h-full transition-all duration-300",
                      isShowingEpisodes && "shimmer-bar",
                      !isShowingEpisodes && isComplete && "bg-status-success",
                      !isShowingEpisodes && isInProgress && "bg-accent",
                      !isShowingEpisodes && isPending && "bg-transparent"
                    )}
                    style={{ width: `${displayProgress}%` }}
                  />
                </div>
              </div>
            )

            return (
              <Tooltip key={phase.key} className="flex-1" content="Click to toggle">
                {content}
              </Tooltip>
            )
          }

          return (
            <div key={phase.key} className="flex-1">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs text-text-secondary">{phase.label}</span>
                <span className="text-xs font-mono text-text-muted">
                  {count}/{summary.total}
                </span>
              </div>
              <div className="h-2 bg-bg-elevated overflow-hidden">
                <div
                  className={cn(
                    "h-full transition-all duration-500",
                    isComplete && "bg-status-success",
                    isInProgress && "bg-accent",
                    isPending && "bg-transparent"
                  )}
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
