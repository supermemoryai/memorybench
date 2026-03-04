"use client"

import { useState, useRef, useEffect } from "react"
import { createPortal } from "react-dom"
import Link from "next/link"
import { cn } from "@/lib/utils"

interface RunActionsMenuProps {
  runId: string
  provider: string
  benchmark: string
  status: string
  onAddToLeaderboard: (data: { version?: string; notes?: string }) => Promise<void>
  onDelete: () => void
  onTerminate?: () => void
  onContinue?: () => void
}

export function RunActionsMenu({
  runId,
  provider,
  benchmark,
  status,
  onAddToLeaderboard,
  onDelete,
  onTerminate,
  onContinue,
}: RunActionsMenuProps) {
  const [open, setOpen] = useState(false)
  const [showLeaderboardPopover, setShowLeaderboardPopover] = useState(false)
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const [popoverPosition, setPopoverPosition] = useState({ top: 0, left: 0 })

  const triggerRef = useRef<HTMLButtonElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  const isCompleted = status === "completed"
  const isRunning = status === "running" || status === "pending"
  const isStopping = status === "stopping"
  const isFailed = status === "failed"
  const isPartial = status === "partial"
  const canContinue = isFailed || isPartial

  // Calculate dropdown position
  useEffect(() => {
    if (open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect()
      const dropdownWidth = 192

      setPosition({
        top: rect.bottom + 4,
        left: rect.right - dropdownWidth,
      })
    }
  }, [open])

  // Calculate popover position
  useEffect(() => {
    if (showLeaderboardPopover && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect()
      const popoverWidth = 320

      setPopoverPosition({
        top: rect.bottom + 4,
        left: Math.max(16, rect.right - popoverWidth),
      })
    }
  }, [showLeaderboardPopover])

  // Click outside handler
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node

      // Handle dropdown
      if (open && triggerRef.current && dropdownRef.current) {
        if (!triggerRef.current.contains(target) && !dropdownRef.current.contains(target)) {
          setOpen(false)
        }
      }

      // Handle popover
      if (showLeaderboardPopover && popoverRef.current) {
        if (!popoverRef.current.contains(target)) {
          setShowLeaderboardPopover(false)
        }
      }
    }

    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [open, showLeaderboardPopover])

  const handleOpenLeaderboard = () => {
    setOpen(false)
    setShowLeaderboardPopover(true)
  }

  return (
    <>
      <button
        ref={triggerRef}
        className="p-1.5 text-text-muted hover:text-text-primary rounded hover:bg-[#222222] transition-colors cursor-pointer"
        onClick={(e) => {
          e.stopPropagation()
          setOpen(!open)
        }}
      >
        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
          <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
        </svg>
      </button>

      {/* Dropdown menu */}
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={dropdownRef}
            className="fixed z-[9999] w-48 bg-[#0b0b0e] border border-[#333333] rounded overflow-hidden"
            style={{
              top: position.top,
              left: position.left,
              boxShadow: "0 4px 16px rgba(34, 34, 34, 0.5)",
            }}
          >
            <div className="py-1">
              <Link
                href={`/runs/${encodeURIComponent(runId)}`}
                className="w-full px-3 py-2 text-sm text-left transition-colors flex items-center gap-2 cursor-pointer text-text-secondary hover:bg-[#222222] hover:text-text-primary"
                onClick={() => setOpen(false)}
              >
                view details
              </Link>

              <button
                className={cn(
                  "w-full px-3 py-2 text-sm text-left transition-colors flex items-center gap-2 cursor-pointer",
                  !isCompleted
                    ? "text-text-muted cursor-not-allowed"
                    : "text-text-secondary hover:bg-[#222222] hover:text-text-primary"
                )}
                disabled={!isCompleted}
                onClick={handleOpenLeaderboard}
              >
                add to leaderboard
              </button>

              {canContinue && (
                <>
                  <div className="border-t border-[#333333] my-1" />
                  <button
                    className="w-full px-3 py-2 text-sm text-left transition-colors flex items-center gap-2 cursor-pointer text-accent hover:bg-[#222222]"
                    onClick={() => {
                      onContinue?.()
                      setOpen(false)
                    }}
                  >
                    continue
                  </button>
                </>
              )}

              <div className="border-t border-[#333333] my-1" />

              {isRunning || isStopping ? (
                <button
                  className={cn(
                    "w-full px-3 py-2 text-sm text-left transition-colors flex items-center gap-2 cursor-pointer",
                    isStopping
                      ? "text-text-muted cursor-not-allowed"
                      : "text-status-error hover:bg-[#222222]"
                  )}
                  disabled={isStopping}
                  onClick={() => {
                    onTerminate?.()
                    setOpen(false)
                  }}
                >
                  {isStopping ? "stopping..." : "terminate"}
                </button>
              ) : (
                <button
                  className="w-full px-3 py-2 text-sm text-left transition-colors flex items-center gap-2 cursor-pointer text-status-error hover:bg-[#222222]"
                  onClick={() => {
                    onDelete()
                    setOpen(false)
                  }}
                >
                  delete
                </button>
              )}
            </div>
          </div>,
          document.body
        )}

      {/* Leaderboard popover */}
      {showLeaderboardPopover &&
        typeof document !== "undefined" &&
        createPortal(
          <LeaderboardPopover
            ref={popoverRef}
            position={popoverPosition}
            provider={provider}
            benchmark={benchmark}
            onSubmit={async (data) => {
              await onAddToLeaderboard(data)
              setShowLeaderboardPopover(false)
            }}
            onClose={() => setShowLeaderboardPopover(false)}
          />,
          document.body
        )}
    </>
  )
}

// Separate popover component for adding to leaderboard
import { forwardRef } from "react"

interface LeaderboardPopoverProps {
  position: { top: number; left: number }
  provider: string
  benchmark: string
  onSubmit: (data: { version?: string; notes?: string }) => Promise<void>
  onClose: () => void
}

const LeaderboardPopover = forwardRef<HTMLDivElement, LeaderboardPopoverProps>(
  ({ position, provider, benchmark, onSubmit, onClose }, ref) => {
    const [editingVersion, setEditingVersion] = useState(false)
    const [version, setVersion] = useState("")
    const [notes, setNotes] = useState("")
    const [isSubmitting, setIsSubmitting] = useState(false)

    const versionInputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
      if (editingVersion && versionInputRef.current) {
        versionInputRef.current.focus()
      }
    }, [editingVersion])

    const handleSubmit = async () => {
      try {
        setIsSubmitting(true)
        await onSubmit({
          version: version.trim() || undefined,
          notes: notes.trim() || undefined,
        })
      } catch (e) {
        alert(e instanceof Error ? e.message : "failed to add to leaderboard")
      } finally {
        setIsSubmitting(false)
      }
    }

    return (
      <div
        ref={ref}
        className="fixed z-[9999] w-80 bg-[#0b0b0e] border border-[#333333] rounded overflow-hidden"
        style={{
          top: position.top,
          left: position.left,
          boxShadow: "0 4px 16px rgba(34, 34, 34, 0.5)",
        }}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-[#333333] flex items-center justify-between">
          <span className="text-sm text-text-primary">add to leaderboard</span>
          <button
            className="text-text-muted hover:text-text-primary transition-colors cursor-pointer"
            onClick={onClose}
          >
            <svg
              className="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* Provider / Benchmark */}
          <div className="text-xs text-text-muted">
            <span className="lowercase">{provider}</span>
            <span className="mx-1">/</span>
            <span className="lowercase">{benchmark}</span>
          </div>

          {/* Version */}
          <div className="space-y-1.5">
            <label className="text-xs text-text-muted">version</label>
            {!editingVersion ? (
              <button
                className="flex items-center gap-2 text-sm text-text-primary hover:text-accent transition-colors cursor-pointer"
                onClick={() => setEditingVersion(true)}
              >
                <span className="font-medium lowercase">{version || "baseline"}</span>
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
                ref={versionInputRef}
                type="text"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                onBlur={() => setEditingVersion(false)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === "Escape") {
                    setEditingVersion(false)
                  }
                }}
                placeholder="baseline"
                className="w-full px-2 py-1.5 text-sm bg-[#222222] border border-[#444444] rounded text-text-primary placeholder-text-muted focus:outline-none focus:border-accent lowercase"
              />
            )}
          </div>

          {/* Notes */}
          <div className="space-y-1.5">
            <label className="text-xs text-text-muted">notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="optional"
              rows={3}
              className="w-full px-2 py-1.5 text-sm bg-[#222222] border border-[#444444] rounded text-text-primary placeholder-text-muted focus:outline-none focus:border-accent resize-none lowercase"
            />
          </div>

          {/* Submit button */}
          <button
            className="w-full flex items-center justify-center gap-1.5 py-2 rounded text-sm font-medium transition-all font-display tracking-tight text-white border border-transparent hover:border-white/30 cursor-pointer disabled:opacity-50"
            style={{
              background: "linear-gradient(135deg, rgb(38, 123, 241) 40%, rgb(21, 70, 139) 100%)",
              boxShadow:
                "rgba(255, 255, 255, 0.25) 2px 2px 8px 0px inset, rgba(0, 0, 0, 0.15) -2px -2px 7px 0px inset",
            }}
            onClick={handleSubmit}
            disabled={isSubmitting}
          >
            {isSubmitting ? (
              "adding..."
            ) : (
              <>
                <span className="text-lg leading-none">+</span>
                <span>Add to Leaderboard</span>
              </>
            )}
          </button>
        </div>
      </div>
    )
  }
)

LeaderboardPopover.displayName = "LeaderboardPopover"
