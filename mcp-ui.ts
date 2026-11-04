import type { Plugin } from "@opencode/plugin/tui"
import type { RavenMcpAction, RavenMcpServer } from "./rpc"

interface ManagerApi {
  list(): Promise<{ servers: RavenMcpServer[] }>
  action(serverName: string, action: RavenMcpAction): Promise<{ text: string; authorizationUrl?: string }>
  refresh(serverName?: string): Promise<unknown>
}

const STATUS: Record<RavenMcpServer["status"], string> = {
  connected: "Connected", ready: "Ready · on demand", pending: "Not checked",
  failed: "Failed", auth_required: "Needs sign-in", authorizing: "Signing in…", disabled: "Disabled",
}

// Run the platform opener on the TUI's machine, not the background server.
// Never interpolate an authorization URL into a shell command.
async function openBrowser(value: string, signal: AbortSignal): Promise<boolean> {
  try {
    const url = new URL(value)
    if (url.username || url.password || (url.protocol !== "https:"
      && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) return false
    const { execFile } = await import("node:child_process")
    const windows = process.platform === "win32"
    const command = windows ? "powershell.exe" : process.platform === "darwin" ? "open" : "xdg-open"
    const args = windows
      ? ["-NoProfile", "-NonInteractive", "-Command", "Start-Process -FilePath $env:OPENCODE_RAVEN_AUTH_URL"]
      : [url.href]
    return await new Promise<boolean>((resolve) => {
      execFile(command, args, {
        windowsHide: true, timeout: 10_000, signal,
        ...(windows ? { env: { ...process.env, OPENCODE_RAVEN_AUTH_URL: url.href } } : {}),
      }, (error) => resolve(!error))
    })
  } catch { return false }
}

export function createMcpManager(ctx: Plugin.Context, api: ManagerApi, signal: AbortSignal) {
  let pending: Promise<void> | undefined
  let showing = false
  const modal = async <T>(show: () => Promise<T>): Promise<T | undefined> => {
    if (signal.aborted) return undefined
    showing = true
    try { return await show() }
    finally { showing = false }
  }
  const alert = (title: string, message: string) => modal(() => ctx.ui.dialog.alert({ title, message }))
  const select = <T>(title: string, options: { title: string; value: T; description?: string }[], current?: T) =>
    modal(() => ctx.ui.dialog.select({ title, options, ...(current !== undefined ? { current } : {}) }))
  const stop = () => {
    if (!showing) return
    showing = false
    ctx.ui.dialog.clear()
  }
  signal.addEventListener("abort", stop, { once: true })

  async function manageServer(name: string) {
    while (!signal.aborted) {
      const server = (await api.list()).servers.find((item) => item.name === name)
      if (!server || signal.aborted) return false
      const options: { title: string; value: RavenMcpAction | "refresh" | "details" | "back"; description?: string }[] = []
      if (server.enabled) {
        if (server.oauth) options.push({
          title: server.status === "authorizing" ? "Continue browser sign-in" : server.authenticated ? "Sign in again" : "Sign in",
          value: "auth", description: "Open the authorization page in your browser",
        })
        options.push({ title: "Refresh connection and tools", value: "refresh", description: "Check server health and rediscover tools" })
      }
      if (server.oauth && (server.authenticated || server.status === "authorizing" || server.lastError)) {
        options.push({ title: server.status === "authorizing" ? "Cancel sign-in / clear credentials" : "Sign out / clear credentials", value: "logout" })
      }
      options.push(
        { title: server.enabled ? "Disable server" : "Enable server", value: server.enabled ? "disable" : "enable", description: "Saved in Raven configuration; takes effect immediately" },
        { title: "Server details", value: "details", description: `${server.type} · ${server.toolCount} discovered tools` },
        { title: "Back to Raven MCPs", value: "back" },
      )
      const action = await select(`${name} · ${STATUS[server.status]}`, options)
      if (action === undefined || signal.aborted) return false
      if (action === "back") return true
      try {
        if (action === "details") {
          await alert(name, [
            `Status: ${STATUS[server.status]}`, `Transport: ${server.type}`, `Discovered tools: ${server.toolCount}`,
            server.oauth ? `OAuth: ${server.authenticated ? "credentials saved" : "not signed in"}` : "Authentication: managed by server configuration",
            server.description, server.lastError ? `Last error: ${server.lastError}` : "",
            "Ready means health/tool discovery succeeded. On-demand connections open when Raven uses the server.",
          ].filter(Boolean).join("\n\n"))
        } else if (action === "refresh") {
          await api.refresh(name)
        } else {
          if (action === "logout") {
            const confirmed = await modal(() => ctx.ui.dialog.confirm({
              title: `Sign out of ${name}?`, message: "Clear Raven's saved OAuth credentials and close cached connections. This does not revoke the provider's grant.",
              label: { confirm: "Sign out", cancel: "Keep credentials" },
            }))
            if (!confirmed || signal.aborted) continue
          }
          const result = await api.action(name, action)
          if (signal.aborted) return
          if (result.authorizationUrl) {
            const opened = await openBrowser(result.authorizationUrl, signal)
            await alert(`Sign in to ${name}`, `${opened ? "Browser opened. Approve access there, then return here for the completion notification." : "Could not open your browser automatically. Open the URL below to sign in."}\n\n${result.text}`)
          } else {
            ctx.ui.toast.show({ title: "Raven MCP", message: result.text, variant: "info", duration: 6000 })
            if (action === "enable") await api.refresh(name)
            if (action === "disable") return true
          }
        }
      } catch (error) {
        if (signal.aborted) return
        ctx.ui.toast.show({ title: "Raven MCP", message: String(error), variant: "error", duration: 6000 })
      }
    }
  }

  async function run() {
    let current: string | undefined
    while (!signal.aborted) {
      const { servers } = await api.list()
      if (signal.aborted) return
      if (!servers.length) {
        await alert("Raven MCPs", "No on-demand MCP servers configured. Add servers under raven_mcp.onDemandMcpServers in raven-config.json.")
        return
      }
      const selected = await select("Raven MCPs", [
        ...servers.map((server) => ({
          title: server.name, value: `server:${server.name}`,
          description: `${STATUS[server.status]} · ${server.type} · ${server.toolCount} tools${server.description ? ` · ${server.description.slice(0, 120)}` : ""}`,
        })),
        { title: "Refresh all servers", value: "action:refresh", description: "Recheck enabled servers and rediscover tools" },
      ], current)
      if (selected === undefined || signal.aborted) return
      current = selected
      if (selected === "action:refresh") await api.refresh()
      else if (!await manageServer(selected.slice("server:".length))) return
    }
  }

  return {
    open() {
      if (pending) return pending
      pending = run().catch((error) => {
        if (!signal.aborted) ctx.ui.toast.show({ title: "Raven MCP", message: `Could not load servers: ${String(error)}`, variant: "error", duration: 6000 })
      }).finally(() => { pending = undefined })
      return pending
    },
    dispose() { signal.removeEventListener("abort", stop); stop() },
  }
}
