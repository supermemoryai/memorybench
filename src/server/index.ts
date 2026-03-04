import { handleRunsRoutes } from "./routes/runs"
import { handleBenchmarksRoutes } from "./routes/benchmarks"
import { handleLeaderboardRoutes } from "./routes/leaderboard"
import { handleCompareRoutes } from "./routes/compare"
import { WebSocketManager } from "./websocket"
import { logger } from "../utils/logger"
import { join } from "path"
import { Subprocess } from "bun"

export interface ServerOptions {
  port: number
  open?: boolean
}

let uiProcess: Subprocess | null = null

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
}

export const wsManager = new WebSocketManager()

export async function startServer(options: ServerOptions): Promise<void> {
  const { port, open = true } = options

  const server = Bun.serve({
    port,

    async fetch(req, server) {
      const url = new URL(req.url)

      // Handle CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, { headers: CORS_HEADERS })
      }

      // WebSocket upgrade
      if (url.pathname === "/ws") {
        const upgraded = server.upgrade(req)
        if (upgraded) return undefined
        return new Response("WebSocket upgrade failed", { status: 400 })
      }

      // API routes
      try {
        let response: Response | null = null

        if (url.pathname.startsWith("/api/runs")) {
          response = await handleRunsRoutes(req, url)
        } else if (url.pathname.startsWith("/api/compare")) {
          response = await handleCompareRoutes(req, url)
        } else if (
          url.pathname.startsWith("/api/benchmarks") ||
          url.pathname.startsWith("/api/providers") ||
          url.pathname === "/api/models" ||
          url.pathname === "/api/downloads"
        ) {
          response = await handleBenchmarksRoutes(req, url)
        } else if (url.pathname.startsWith("/api/leaderboard")) {
          response = await handleLeaderboardRoutes(req, url)
        }

        if (response) {
          // Add CORS headers to response
          const headers = new Headers(response.headers)
          Object.entries(CORS_HEADERS).forEach(([key, value]) => {
            headers.set(key, value)
          })
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          })
        }

        // 404 for unknown routes
        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : "Internal server error"
        return new Response(JSON.stringify({ error: message }), {
          status: 500,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        })
      }
    },

    websocket: {
      open(ws) {
        wsManager.addClient(ws)
      },
      message(ws, message) {
        wsManager.handleMessage(ws, message)
      },
      close(ws) {
        wsManager.removeClient(ws)
      },
    },
  })

  logger.success(`MemoryBench API server running at http://localhost:${port}`)
  logger.info(`WebSocket available at ws://localhost:${port}/ws`)

  // Start UI dev server (capture output to detect port)
  const uiDir = join(process.cwd(), "ui")

  uiProcess = Bun.spawn(["bun", "run", "dev"], {
    cwd: uiDir,
    stdout: "pipe",
    stderr: "inherit",
    env: {
      ...process.env,
      NEXT_PUBLIC_API_URL: `http://localhost:${port}`,
    },
  })

  // Handle cleanup on exit
  const cleanup = () => {
    if (uiProcess) {
      logger.info("Shutting down UI server...")
      uiProcess.kill()
      uiProcess = null
    }
    process.exit(0)
  }

  process.on("SIGINT", cleanup)
  process.on("SIGTERM", cleanup)

  // Read stdout to detect the actual port Next.js uses
  if (uiProcess.stdout && typeof uiProcess.stdout !== "number") {
    const reader = (uiProcess.stdout as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let foundPort = false

    const readOutput = async () => {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const text = decoder.decode(value)

        // Look for the port in Next.js output (e.g., "Local: http://localhost:3000")
        const portMatch = text.match(/localhost:(\d+)/)
        if (portMatch && !foundPort) {
          foundPort = true
          const uiPort = portMatch[1]
          logger.success(`UI ready at http://localhost:${uiPort}`)

          if (open) {
            const openCommand =
              process.platform === "darwin"
                ? "open"
                : process.platform === "win32"
                  ? "start"
                  : "xdg-open"
            Bun.spawn([openCommand, `http://localhost:${uiPort}`])
          }
        }
      }
    }
    readOutput().catch(() => {})
  }
}
