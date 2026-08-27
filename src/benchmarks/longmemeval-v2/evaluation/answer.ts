/**
 * LongMemEval-V2 asks readers to put their final answer in the last
 * `\boxed{...}` expression. The parser deliberately mirrors the reference
 * Python implementation, including nested braces and its fallback behavior.
 */
export function extractBoxedAnswer(text: string): string {
  const marker = "\\boxed{"
  const markerIndex = text.lastIndexOf(marker)
  if (markerIndex === -1) return text.trim()

  let index = markerIndex + marker.length
  let depth = 1
  let parsed = ""
  while (index < text.length && depth > 0) {
    const character = text[index]
    if (character === "{") {
      depth += 1
      parsed += character
    } else if (character === "}") {
      depth -= 1
      if (depth === 0) break
      parsed += character
    } else {
      parsed += character
    }
    index += 1
  }

  const trimmed = parsed.trim()
  return trimmed.length > 0 ? trimmed : text.trim()
}

export function isUnknownAnswer(answer: string): boolean {
  return answer.trim().toLowerCase() === "unknown"
}
