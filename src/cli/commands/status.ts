import { orchestrator } from "../../orchestrator"

interface StatusArgs {
  runId: string
}

export function parseStatusArgs(args: string[]): StatusArgs | null {
  let runId: string | undefined

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "-r" || arg === "--run-id") {
      runId = args[++i]
    }
  }

  if (!runId) {
    return null
  }

  return { runId }
}

export async function statusCommand(args: string[]): Promise<void> {
  const parsed = parseStatusArgs(args)

  if (!parsed) {
    console.log("Usage: bun run src/index.ts status -r <runId>")
    console.log("")
    console.log("Options:")
    console.log("  -r, --run-id   Run identifier")
    return
  }

  orchestrator.getStatus(parsed.runId)
}
