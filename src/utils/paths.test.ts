import { test, expect } from "bun:test"
import { join } from "path"
import { isSafeId, assertSafeId, UnsafeIdError } from "./paths"

// The attack: /api/runs/([^/]+) matches a segment containing %2F, because URL keeps it
// encoded in the pathname. decodeURIComponent then turns it into real separators.
const TRAVERSALS = [
  "../../secrets",
  "..%2F..%2Fsecrets", // pre-decode form, in case a caller forgets to decode
  "..",
  ".",
  "../",
  "a/../../b",
  "..\\..\\windows", // backslashes are separators on win32
  "/etc/passwd",
  "C:\\Windows",
  "run-1/../..",
  "",
]

const VALID = [
  "run-20260101-120000",
  "supermemory-locomo-20260101-ab12",
  "compare-20260101-120000",
  "compare-20260101-120000-mem0",
  "run_1.2",
]

test("rejects every traversal vector", () => {
  for (const id of TRAVERSALS) {
    expect(isSafeId(id)).toBe(false)
    expect(() => assertSafeId(id, "run ID")).toThrow(UnsafeIdError)
  }
})

test("accepts the IDs the CLI, UI and batch runner generate", () => {
  for (const id of VALID) {
    expect(isSafeId(id)).toBe(true)
    expect(assertSafeId(id)).toBe(id)
  }
})

test("no accepted ID can escape its base directory", () => {
  // The property that actually matters, asserted on the joined path rather than the regex.
  for (const id of VALID) {
    expect(join("./data/runs", id).replace(/\\/g, "/")).toBe(`data/runs/${id}`)
  }
})
