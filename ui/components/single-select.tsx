"use client"

import { useState, useRef, useEffect } from "react"
import { createPortal } from "react-dom"
import { cn } from "@/lib/utils"

interface Option {
  value: string
  label: string
  sublabel?: string
}

interface SingleSelectProps {
  label: string
  options: Option[]
  selected: string
  onChange: (selected: string) => void
  placeholder?: string
  wide?: boolean
  dropUp?: boolean
}

export function SingleSelect({
  label,
  options,
  selected,
  onChange,
  placeholder,
  wide,
  dropUp,
}: SingleSelectProps) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ top: 0, left: 0, width: 0, bottom: 0 })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect()
      const minWidth = wide ? 400 : 200
      setPosition({
        top: rect.bottom + 4,
        left: rect.left,
        width: Math.max(rect.width, minWidth),
        bottom: window.innerHeight - rect.top + 4,
      })
    }
  }, [open, wide])

  // Click outside handler
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node
      if (
        triggerRef.current &&
        !triggerRef.current.contains(target) &&
        dropdownRef.current &&
        !dropdownRef.current.contains(target)
      ) {
        setOpen(false)
      }
    }

    if (open) {
      document.addEventListener("mousedown", handleClickOutside)
    }
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [open])

  const selectOption = (value: string) => {
    onChange(value)
    setOpen(false)
  }

  const displayText = selected
    ? options.find((o) => o.value === selected)?.label || selected
    : placeholder || label

  return (
    <>
      {/* Trigger button */}
      <button
        ref={triggerRef}
        type="button"
        className={cn(
          "flex items-center justify-between gap-2 px-3 py-2.5 text-sm w-full cursor-pointer rounded",
          "bg-[#222222] border border-[#333333] text-text-secondary hover:text-text-primary hover:border-[#444444] transition-colors",
          selected && "text-text-primary"
        )}
        onClick={(e) => {
          e.stopPropagation()
          setOpen(!open)
        }}
      >
        <span className="truncate">{displayText}</span>
        <svg
          className={cn("w-4 h-4 flex-shrink-0 transition-transform", open && "rotate-180")}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown - rendered via portal */}
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={dropdownRef}
            className="fixed z-[9999] bg-[#0b0b0e] border border-[#333333] rounded overflow-hidden"
            style={{
              ...(dropUp ? { bottom: position.bottom } : { top: position.top }),
              left: position.left,
              width: position.width,
              boxShadow: "0 4px 16px rgba(34, 34, 34, 0.5)",
            }}
          >
            {/* Options list */}
            <div className="max-h-64 overflow-y-auto">
              {options.length === 0 ? (
                <div className="px-3 py-2 text-sm text-text-muted">No options</div>
              ) : (
                options.map((option) => {
                  const isSelected = selected === option.value
                  return (
                    <button
                      key={option.value}
                      type="button"
                      className={cn(
                        "w-full flex items-center gap-2 px-3 text-sm text-left transition-colors cursor-pointer",
                        "text-text-secondary hover:bg-[#222222] hover:text-text-primary",
                        isSelected && "text-text-primary bg-[#1a1a1a]",
                        option.sublabel ? "py-2" : "py-2"
                      )}
                      onClick={() => selectOption(option.value)}
                    >
                      {/* Radio indicator */}
                      <div
                        className={cn(
                          "w-4 h-4 rounded-full border flex items-center justify-center flex-shrink-0",
                          isSelected ? "border-accent" : "border-[#444444]"
                        )}
                      >
                        {isSelected && <div className="w-2 h-2 rounded-full bg-accent" />}
                      </div>

                      {/* Label and sublabel */}
                      <div className="flex-1 min-w-0">
                        <span className="block truncate">{option.label}</span>
                        {option.sublabel && (
                          <span className="block text-xs text-text-muted truncate">
                            {option.sublabel}
                          </span>
                        )}
                      </div>
                    </button>
                  )
                })
              )}
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
