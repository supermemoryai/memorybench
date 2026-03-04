import { startServer } from "../../server"

function parseArgs(args: string[]): { port: number; open: boolean } {
  let port = 3001
  let open = true

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "-p" || arg === "--port") {
      const value = args[++i]
      if (value) port = parseInt(value, 10)
    } else if (arg === "--no-open") {
      open = false
    }
  }

  return { port, open }
}

export async function serveCommand(args: string[]): Promise<void> {
  const options = parseArgs(args)

  if (isNaN(options.port) || options.port < 1 || options.port > 65535) {
    console.error("Error: Invalid port number")
    process.exit(1)
  }

  await startServer(options)
}
