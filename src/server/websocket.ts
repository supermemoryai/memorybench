import type { ServerWebSocket } from "bun"

interface ClientInfo {
  subscribedRuns: Set<string>
}

export class WebSocketManager {
  private clients: Map<ServerWebSocket<unknown>, ClientInfo> = new Map()

  addClient(ws: ServerWebSocket<unknown>): void {
    this.clients.set(ws, { subscribedRuns: new Set() })
  }

  removeClient(ws: ServerWebSocket<unknown>): void {
    this.clients.delete(ws)
  }

  handleMessage(ws: ServerWebSocket<unknown>, message: string | Buffer): void {
    try {
      const data = JSON.parse(message.toString())
      const client = this.clients.get(ws)
      if (!client) return

      switch (data.type) {
        case "subscribe":
          if (data.runId) {
            client.subscribedRuns.add(data.runId)
            ws.send(
              JSON.stringify({
                type: "subscribed",
                runId: data.runId,
              })
            )
          }
          break

        case "unsubscribe":
          if (data.runId) {
            client.subscribedRuns.delete(data.runId)
            ws.send(
              JSON.stringify({
                type: "unsubscribed",
                runId: data.runId,
              })
            )
          }
          break

        case "ping":
          ws.send(JSON.stringify({ type: "pong" }))
          break
      }
    } catch (e) {
      // Ignore invalid messages
    }
  }

  // Broadcast to all clients subscribed to a specific run
  broadcastToRun(runId: string, message: object): void {
    const payload = JSON.stringify(message)
    for (const [ws, client] of this.clients) {
      if (client.subscribedRuns.has(runId)) {
        try {
          ws.send(payload)
        } catch (e) {
          // Client disconnected, will be cleaned up
        }
      }
    }
  }

  // Broadcast to all connected clients
  broadcast(message: object): void {
    const payload = JSON.stringify(message)
    for (const [ws] of this.clients) {
      try {
        ws.send(payload)
      } catch (e) {
        // Client disconnected
      }
    }
  }

  // Get count of connected clients
  getClientCount(): number {
    return this.clients.size
  }
}
