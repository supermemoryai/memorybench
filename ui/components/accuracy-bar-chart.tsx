"use client"

// Provider colors - supermemory gets blue, others get assigned colors
const PROVIDER_COLORS: Record<string, string> = {
  supermemory: "#4A9EF5", // Blue
}

const DEFAULT_COLORS = [
  "#F07167", // Coral/salmon
  "#F5B041", // Yellow/orange
  "#7DCEA0", // Green
  "#BB8FCE", // Purple
  "#85C1E9", // Light blue
]

interface AccuracyData {
  type: string
  values: { provider: string; accuracy: number | undefined }[]
}

interface AccuracyBarChartProps {
  data: AccuracyData[]
  providers: string[]
}

export function AccuracyBarChart({ data, providers }: AccuracyBarChartProps) {
  // Build color map for providers (excluding supermemory from default color assignment)
  const colorMap = new Map<string, string>()
  let colorIndex = 0
  providers.forEach((provider) => {
    const lowerProvider = provider.toLowerCase()
    if (PROVIDER_COLORS[lowerProvider]) {
      colorMap.set(provider, PROVIDER_COLORS[lowerProvider])
    } else {
      colorMap.set(provider, DEFAULT_COLORS[colorIndex % DEFAULT_COLORS.length])
      colorIndex++
    }
  })

  const chartHeight = 280
  const barWidth = 24
  const barGap = 6
  const groupGap = 60 // More space between groups
  const yAxisWidth = 35
  const xAxisHeight = 50
  const topPadding = 24
  const legendHeight = 32

  // Calculate group width based on number of providers
  const groupWidth = providers.length * (barWidth + barGap) - barGap

  // Y-axis scale (0-100)
  const yScale = (value: number) => {
    return chartHeight - (value / 100) * chartHeight
  }

  return (
    <div className="w-full h-full flex flex-col">
      {/* Legend on top right */}
      <div className="flex flex-wrap gap-4 justify-end mb-2" style={{ minHeight: legendHeight }}>
        {providers.map((provider) => (
          <div key={provider} className="flex items-center gap-2">
            <div className="w-3 h-3 rounded" style={{ backgroundColor: colorMap.get(provider) }} />
            <span className="text-xs text-text-secondary capitalize">{provider}</span>
          </div>
        ))}
      </div>

      {/* Chart */}
      <div className="flex-1 w-full">
        <svg
          width="100%"
          height={chartHeight + xAxisHeight + topPadding}
          viewBox={`0 0 ${yAxisWidth + data.length * (groupWidth + groupGap)} ${chartHeight + xAxisHeight + topPadding}`}
          preserveAspectRatio="xMidYMid meet"
          className="font-mono"
        >
          {/* Y-axis labels and dotted lines */}
          {[0, 20, 40, 60, 80, 100].map((value) => (
            <g key={value}>
              {/* Label */}
              <text
                x={yAxisWidth - 8}
                y={yScale(value) + topPadding + 4}
                textAnchor="end"
                className="fill-text-muted"
                style={{ fontSize: 11 }}
              >
                {value}
              </text>
              {/* Dotted line */}
              <line
                x1={yAxisWidth}
                y1={yScale(value) + topPadding}
                x2={yAxisWidth + data.length * (groupWidth + groupGap) - groupGap + 20}
                y2={yScale(value) + topPadding}
                stroke="#333333"
                strokeDasharray="4 4"
                strokeWidth={1}
              />
            </g>
          ))}

          {/* Bars grouped by category */}
          {data.map((category, categoryIndex) => {
            const groupX = yAxisWidth + categoryIndex * (groupWidth + groupGap) + groupGap / 2

            // Find the best (highest) accuracy for this category and its FIRST index
            const accuracies = category.values.map((v) => v.accuracy ?? 0)
            const bestAccuracy = Math.max(...accuracies)
            const firstBestIndex = accuracies.findIndex((a) => a === bestAccuracy)

            return (
              <g key={category.type}>
                {/* Bars for each provider */}
                {category.values.map((item, providerIndex) => {
                  const barX = groupX + providerIndex * (barWidth + barGap)
                  // accuracy is in 0-1 range, convert to percentage for display
                  const accuracyDecimal = item.accuracy ?? 0
                  const accuracyPercent = accuracyDecimal * 100
                  const barHeight = Math.max((accuracyPercent / 100) * chartHeight, 0)
                  const barY = yScale(accuracyPercent) + topPadding
                  const color = colorMap.get(item.provider) || DEFAULT_COLORS[0]

                  // Check if this is the best value (first occurrence only)
                  const isBest = providerIndex === firstBestIndex && bestAccuracy > 0

                  // Create path for bar with only top corners rounded
                  const radius = 6
                  const r = Math.min(radius, barWidth / 2, barHeight / 2)
                  const barPath =
                    barHeight > 0
                      ? `M ${barX} ${barY + barHeight}
                       L ${barX} ${barY + r}
                       Q ${barX} ${barY} ${barX + r} ${barY}
                       L ${barX + barWidth - r} ${barY}
                       Q ${barX + barWidth} ${barY} ${barX + barWidth} ${barY + r}
                       L ${barX + barWidth} ${barY + barHeight}
                       Z`
                      : ""

                  return (
                    <g key={item.provider}>
                      {/* Bar with only top corners rounded */}
                      {barHeight > 0 && (
                        <path
                          d={barPath}
                          fill={color}
                          style={isBest ? { filter: "brightness(1.15)" } : undefined}
                        />
                      )}
                      {/* Value label on top - white for best value */}
                      {item.accuracy !== undefined && accuracyPercent > 0 && (
                        <text
                          x={barX + barWidth / 2}
                          y={barY - 6}
                          textAnchor="middle"
                          fill={isBest ? "#ffffff" : undefined}
                          className={isBest ? "" : "fill-text-secondary"}
                          style={{ fontSize: 9 }}
                        >
                          {accuracyPercent.toFixed(1)}%
                        </text>
                      )}
                    </g>
                  )
                })}

                {/* Category label (X-axis) - multi-line support */}
                <text
                  x={groupX + groupWidth / 2}
                  y={chartHeight + topPadding + 16}
                  textAnchor="middle"
                  className="fill-text-secondary"
                  style={{ fontSize: 10 }}
                >
                  {formatCategoryLabel(category.type)}
                </text>
              </g>
            )
          })}
        </svg>
      </div>
    </div>
  )
}

function formatCategoryLabel(type: string): string {
  // Convert kebab-case to Title Case and handle multi-line
  return type
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}
