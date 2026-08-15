/**
 * Run and comparison IDs are interpolated straight into filesystem paths and then
 * handed to rmSync/readFileSync, so they must never be able to escape their base
 * directory. Route patterns like /api/runs/([^/]+) do not protect us: the URL
 * pathname keeps %2F encoded, so the segment matches and only becomes a separator
 * later, in decodeURIComponent.
 *
 * Every generated ID (run-20260101-120000, provider-benchmark-20260101-ab12,
 * compare-20260101-120000, <compareId>-<provider>) fits this charset.
 */
// Leading character must be alphanumeric: that rules out the dot-only IDs ("." resolves
// to the base directory itself, so rmSync would take every run with it) and IDs starting
// with "-", which read as flags if an ID ever reaches a shell.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function isSafeId(id: string): boolean {
  // "." is in the charset, so ".." would otherwise pass and still climb.
  return SAFE_ID.test(id) && !id.includes("..")
}

/** Lets the API layer answer 400 instead of 500 without re-validating per route. */
export class UnsafeIdError extends Error {}

export function assertSafeId(id: string, kind = "id"): string {
  if (!isSafeId(id)) {
    throw new UnsafeIdError(
      `Invalid ${kind}: ${JSON.stringify(id)}. Only letters, digits, ".", "_" and "-" are allowed.`
    )
  }
  return id
}
