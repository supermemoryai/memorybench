import { describe, expect, test } from "bun:test"
import { resolve } from "path"

const PROJECT_ROOT = resolve(import.meta.dir, "..")

async function runCli(args: string[]) {
  const child = Bun.spawn([process.execPath, "run", "src/index.ts", ...args], {
    cwd: PROJECT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

describe("CLI process status", () => {
  test("returns a nonzero exit status when BEAM preparation arguments are invalid", async () => {
    const result = await runCli(["beam", "prepare", "--tiers", "invalid"])

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("Invalid BEAM tier")
  })

  test("returns a nonzero exit status for an invalid comparison provider", async () => {
    const result = await runCli([
      "compare",
      "--providers",
      "not-a-provider",
      "--benchmark",
      "locomo",
    ])

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("Invalid provider")
  })

  test("returns a nonzero exit status when list-questions cannot validate BEAM data", async () => {
    const result = await runCli([
      "list-questions",
      "--benchmark",
      "beam-1m",
      "--data-path",
      "/tmp/memorybench-definitely-missing-beam",
      "--dataset-revision",
      "a".repeat(64),
    ])

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("run the BEAM prepare command")
  })

  test("returns a nonzero exit status for an unknown list-questions benchmark", async () => {
    const result = await runCli(["list-questions", "--benchmark", "not-a-benchmark"])

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("Invalid benchmark")
  })
})
