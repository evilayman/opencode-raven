import type { Rpc } from "@opencode/plugin"
import { z } from "zod"

export const RavenMcpServerSchema = z.object({
  name: z.string(),
  type: z.enum(["remote", "local"]),
  enabled: z.boolean(),
  status: z.enum(["disabled", "pending", "ready", "connected", "failed", "auth_required", "authorizing"]),
  description: z.string(),
  toolCount: z.number(),
  oauth: z.boolean(),
  authenticated: z.boolean(),
  lastError: z.string().optional(),
})
export type RavenMcpServer = z.infer<typeof RavenMcpServerSchema>
export const RavenMcpActionSchema = z.enum(["auth", "logout", "enable", "disable"])
export type RavenMcpAction = z.infer<typeof RavenMcpActionSchema>

// Portable contract shared by the v2 server, terminal companion, and clients.
export const RavenRpc = {
  id: "opencode-raven",
  methods: {
    listMcps: {
      input: z.object({}),
      output: z.object({ servers: z.array(RavenMcpServerSchema) }),
    },
    mcpAction: {
      input: z.object({ serverName: z.string(), action: RavenMcpActionSchema }),
      output: z.object({ text: z.string(), authorizationUrl: z.string().optional() }),
    },
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
        kind: z.enum(["command", "toast", "mcp"]),
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
