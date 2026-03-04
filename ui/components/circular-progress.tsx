"use client"

interface CircularProgressProps {
  progress: number // 0 to 1
  size?: number
  strokeWidth?: number
  showPercentage?: boolean
}

export function CircularProgress({
  progress,
  size = 20,
  strokeWidth = 2.5,
  showPercentage = false,
}: CircularProgressProps) {
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference - progress * circumference

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="transform -rotate-90"
    >
      {/* Background circle */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        className="text-[#333333]"
      />

      {/* Progress circle - using the lighter blue from gradient (top-left color) */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="rgb(38, 123, 241)"
        strokeWidth={strokeWidth}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        className="transition-all duration-300"
      />

      {/* Optional percentage text */}
      {showPercentage && (
        <text
          x="50%"
          y="50%"
          textAnchor="middle"
          dominantBaseline="middle"
          className="fill-text-primary text-[8px] font-mono transform rotate-90"
          style={{ transformOrigin: "center" }}
        >
          {Math.round(progress * 100)}
        </text>
      )}
    </svg>
  )
}
