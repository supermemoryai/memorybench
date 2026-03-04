"use client"

import { useState, ReactNode } from "react"

interface TooltipProps {
  content: ReactNode
  children: ReactNode
  className?: string
}

export function Tooltip({ content, children, className = "" }: TooltipProps) {
  const [show, setShow] = useState(false)

  return (
    <div
      className={`relative ${className}`}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      {show && (
        <div
          className="absolute z-50 left-0 bottom-full mb-1 px-2 py-1 text-xs text-text-secondary bg-bg-primary border border-border whitespace-nowrap"
          style={{ boxShadow: "0 2px 8px rgba(52, 52, 52, 0.5)" }}
        >
          {content}
        </div>
      )}
    </div>
  )
}
