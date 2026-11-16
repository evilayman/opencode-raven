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

export const RavenIntegrationSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["mcp", "cli"]),
  transport: z.enum(["http", "stdio", "cli"]),
  enabled: z.boolean(),
  status: z.enum(["disabled", "pending", "ready", "connected", "available", "failed", "auth_required", "authorizing"]),
  description: z.string(),
  toolCount: z.number().optional(),
  oauth: z.boolean().optional(),
  authenticated: z.boolean().optional(),
  executable: z.string().optional(),
  cwd: z.string().optional(),
  lastError: z.string().optional(),
})
export type RavenIntegration = z.infer<typeof RavenIntegrationSchema>
export const RavenIntegrationListSchema = z.object({ integrations: z.array(RavenIntegrationSchema) })

// Portable contract shared by the v2 server, terminal companion, and clients.
export const RavenRpc = {
  id: "opencode-raven",
  methods: {
    listIntegrations: {
      input: z.object({}),
      output: RavenIntegrationListSchema,
    },
    integrationAction: {
      input: z.object({ id: z.string(), action: RavenMcpActionSchema }),
      output: z.object({ text: z.string(), authorizationUrl: z.string().optional() }),
    },
    refreshIntegrations: {
      input: z.object({ id: z.string().optional() }),
      output: RavenIntegrationListSchema,
    },
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
        kind: z.enum(["command", "toast", "integrations"]),
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

export function integrationRefreshArguments(raw: string): { id?: string } | undefined {
  const match = raw.trim().match(/^(integrations|mcp)\s+refresh(?:\s+(.+))?$/i)
  if (!match) return undefined
  const name = match[2]?.trim()
  return name ? { id: match[1].toLowerCase() === "mcp" ? `mcp:${name}` : name } : {}
}

export function integrationType(item: RavenIntegration): string {
  return item.kind === "cli" ? "CLI" : item.transport === "stdio" ? "MCP · STDIO" : "MCP · HTTP"
}

export const integrationStatus: Record<RavenIntegration["status"], string> = {
  connected: "Connected", ready: "Ready · on demand", available: "Available",
  pending: "Not checked", failed: "Failed", auth_required: "Sign-in required",
  authorizing: "Signing in…", disabled: "Disabled",
}

export function integrationNeedsAttention(item: RavenIntegration): boolean {
  return item.enabled && (item.status === "failed" || item.status === "auth_required")
}

export function integrationRefreshingToast(id?: string) {
  return {
    title: "Raven", message: id ? `Refreshing ${shortText(id, 60)}…` : "Refreshing integrations…",
    variant: "info" as const, duration: 3000,
  }
}

// Only transport/plugin failures use this. Unhealthy integrations are data in
// the normal response, not exceptions that prevent the other results arriving.
export function integrationRefreshErrorToast(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  const reason = /failed to encode|expected JSON value|malformedresponse/i.test(message) ? "Raven's refresh response could not be encoded."
    : /unknown.*(?:rpc|method)|(?:rpc|method).*not found|not registered/i.test(message) ? "Raven's refresh handler is unavailable. Run /reload."
    : /timeout|timed out|aborted/i.test(message) ? "Raven's refresh request timed out or was interrupted."
    : /disconnect|ECONNREFUSED|failed to fetch|network/i.test(message) ? "Lost contact with the OpenCode service during refresh."
    : "Raven encountered an unexpected refresh error."
  return {
    title: "Raven · refresh error", message: `${reason}\nCheck OpenCode logs; retry /raven integrations refresh.`,
    variant: "error" as const, duration: 6000,
  }
}

function integrationFailureReason(item: RavenIntegration): string {
  if (item.status === "auth_required") return "sign-in required"
  const error = item.lastError ?? ""
  if (/Missing environment variable /i.test(error)) return "required environment variable is missing"
  if (/working directory is not a directory/i.test(error)) return "working directory is not a directory"
  if (/Working directory or CLI/i.test(error)) return "working directory or CLI configuration unavailable"
  if (/Invalid CLI definitions|configuration.*unavailable/i.test(error)) return "CLI configuration is invalid"
  if (/executable not found/i.test(error)) return "executable not found or not directly runnable"
  if (/credentials/i.test(error)) return "credentials unavailable"
  if (/401|unauthorized|authentication/i.test(error)) return "authentication failed"
  if (/403|forbidden/i.test(error)) return "access denied"
  if (/ENOENT/i.test(error) && item.transport === "stdio") return "server executable not found"
  if (/ECONNREFUSED|connection refused/i.test(error)) return "connection refused"
  if (/ENOTFOUND|EAI_AGAIN/i.test(error)) return "server address could not be resolved"
  if (/timeout|timed out/i.test(error)) return "connection timed out"
  const httpStatus = error.match(/\bHTTP[ :]+([45]\d\d)\b/i)
  if (httpStatus) return `server returned HTTP ${httpStatus[1]}`
  if (item.transport === "stdio" && /connection closed|exited/i.test(error)) return "server exited or closed the connection"
  return item.kind === "cli" ? "executable or working directory unavailable" : "connection failed"
}

function shortText(text: string, limit: number): string {
  const value = text.replace(/[\r\n\t\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim()
  return value.length > limit ? value.slice(0, limit - 1) + "…" : value
}

export function integrationRefreshToast(result: { integrations: RavenIntegration[] }) {
  const failed = result.integrations.filter(integrationNeedsAttention)
  const enabled = result.integrations.filter((item) => item.enabled)
  if (!failed.length) {
    const pending = enabled.filter((item) => item.status === "pending" || item.status === "authorizing").length
    return {
      title: "Raven", message: !enabled.length ? "No enabled integrations to check."
        : pending ? `${pending} integration${pending === 1 ? "" : "s"} still being checked or awaiting sign-in.`
        : "Integration checks passed.",
      variant: pending ? "info" as const : "success" as const, duration: 3000,
    }
  }
  const lines = failed.slice(0, 4).map((item) => {
    const reason = integrationFailureReason(item)
    return `[${integrationType(item)}] ${shortText(item.name, 40)} — ${reason}`
  })
  if (failed.length > 4) lines.push(`+${failed.length - 4} more · /raven-integrations`)
  return {
    title: `Raven · ${failed.length} integration${failed.length === 1 ? "" : "s"} need${failed.length === 1 ? "s" : ""} attention`,
    message: lines.join("\n"), variant: "warning" as const, duration: 6000,
  }
}

export function integrationSummary(integrations: RavenIntegration[]): string {
  const enabled = integrations.filter((item) => item.enabled)
  const failed = enabled.filter(integrationNeedsAttention).length
  const ready = enabled.filter((item) => ["ready", "connected", "available"].includes(item.status)).length
  const pending = enabled.length - failed - ready
  const counts = [
    `${ready} ready`, failed ? `${failed} need attention` : "",
    pending ? `${pending} pending` : "", integrations.length > enabled.length ? `${integrations.length - enabled.length} disabled` : "",
  ].filter(Boolean).join(" · ")
  const width = Math.min(32, Math.max(0, ...enabled.map((item) => shortText(item.name, 32).length)))
  return [`Integrations · ${counts}`, ...enabled.map((item) => {
    const icon = integrationNeedsAttention(item) ? "!" : ["ready", "connected", "available"].includes(item.status) ? "✓" : "·"
    const status = item.kind === "cli" && item.status === "available" ? "Available"
      : item.status === "ready" ? "Ready" : integrationStatus[item.status]
    return `${icon} ${shortText(item.name, 32).padEnd(width)}  ${integrationType(item)} · ${status}`
  }), ...(!integrations.length ? ["None configured."] : [])].join("\n")
}
