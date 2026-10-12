import type { Rpc } from "@opencode/plugin"
import { z } from "zod"

// Portable contract shared by the v2 server, terminal companion, and clients.
export const RavenRpc = {
  id: "opencode-raven",
  methods: {
    refreshMcps: {
      input: z.object({ serverName: z.string().optional() }),
      output: z.object({ refreshed: z.array(z.string()), failed: z.array(z.string()) }),
    },
    command: {
      input: z.object({ arguments: z.string() }),
      output: z.object({ text: z.string() }),
    },
  },
  events: {
    notice: {
      schema: z.object({
        kind: z.enum(["command", "toast"]),
        message: z.string(),
        title: z.string().optional(),
        sessionID: z.string().optional(),
        variant: z.enum(["info", "success", "warning", "error"]).optional(),
        duration: z.number().optional(),
      }),
    },
  },
} as const satisfies Rpc.PortableDefinition

export default RavenRpc

export function mcpRefreshArguments(raw: string): { serverName?: string } | undefined {
  const match = raw.trim().match(/^mcp\s+refresh(?:\s+(.+))?$/i)
  return match ? (match[1] ? { serverName: match[1].trim() } : {}) : undefined
}

export function mcpRefreshToast(result: { refreshed: string[]; failed: string[] }) {
  const refreshed = result.refreshed.length ? result.refreshed.join(", ") : "none"
  const failed = result.failed.length ? result.failed.join(", ") : "none"
  return {
    title: "Raven MCP", message: `Refresh complete.\nRefreshed: ${refreshed}\nFailed: ${failed}`,
    variant: result.failed.length ? "warning" as const : "success" as const, duration: 6000,
  }
}
