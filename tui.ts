import type { Plugin } from "@opencode/plugin/tui"
import { RavenRpc, mcpRefreshArguments, mcpRefreshToast } from "./rpc"

export default {
  id: "opencode-raven.tui",
  setup(ctx) {
    const rpc = ctx.client.rpc(RavenRpc)
    const refreshController = new AbortController()
    const refreshes = new Map<string, Promise<void>>()
    const refreshMcps = (input: { serverName?: string } = {}) => {
      const key = input.serverName?.toLowerCase() ?? "*"
      const pending = refreshes.get(key)
      if (pending) return pending
      ctx.ui.toast.show({ title: "Raven MCP", message: `Refreshing ${input.serverName ?? "on-demand MCPs"}…`, variant: "info", duration: 3000 })
      const run = rpc.refreshMcps(input, {
        location: ctx.location ?? ctx.data.location.default(), signal: refreshController.signal,
      }).then((result) => {
        if (!refreshController.signal.aborted) ctx.ui.toast.show(mcpRefreshToast(result))
      }).catch((error) => {
        if (refreshController.signal.aborted) return
        ctx.ui.toast.show({ title: "Raven MCP", message: `Refresh failed: ${String(error)}. Retry /raven mcp refresh.`, variant: "error", duration: 6000 })
      }).finally(() => refreshes.delete(key))
      refreshes.set(key, run)
      return run
    }
    const show = async (text: string) => {
      // Load the host's OpenTUI peer only when the terminal needs it.
      const { BoxRenderable, TextRenderable, ScrollBoxRenderable, RGBA } = await import("@opentui/core")
      ctx.ui.dialog.show(() => {
        const theme = ctx.theme.surface("dialog")
        const color = theme.background.base
        const backgroundColor = RGBA.fromValues(color.r, color.g, color.b, 1)
        const height = () => Math.max(1, Math.min(32, ctx.renderer.height - 4))
        const box = new BoxRenderable(ctx.renderer, {
          width: "100%", height: height(), flexDirection: "column",
          paddingX: 2, paddingY: 1, gap: 1, backgroundColor, overflow: "hidden",
        })
        box.add(new TextRenderable(ctx.renderer, {
          content: "Raven", fg: theme.text.base, flexShrink: 0,
        }))
        const scroll = new ScrollBoxRenderable(ctx.renderer, {
          flexGrow: 1, minHeight: 1, scrollX: false, scrollY: true,
          contentOptions: { paddingRight: 1 },
        })
        scroll.add(new TextRenderable(ctx.renderer, {
          content: text, fg: theme.text.base, width: "100%", wrapMode: "word", flexShrink: 0,
        }))
        box.add(scroll)
        box.add(new TextRenderable(ctx.renderer, {
          content: "↑/↓ PgUp/PgDn wheel · esc close",
          fg: theme.text.muted, flexShrink: 0, wrapMode: "word",
        }))
        const resize = () => { box.height = height() }
        ctx.renderer.on("resize", resize)
        box.once("destroyed", () => ctx.renderer.off("resize", resize))
        scroll.focus()
        return box
      })
      ctx.ui.dialog.set({ size: "large", centered: true })
    }
    const unsubscribe = rpc.events.on("notice", async (event) => {
      const location = ctx.location ?? ctx.data.location.default()
      if (event.location?.directory !== location.directory) return
      if (event.data.sessionID) {
        const route = ctx.ui.router.current()
        if (route.type !== "session" || route.sessionID !== event.data.sessionID) return
      }
      if (event.data.kind === "command") {
        const route = ctx.ui.router.current()
        if (route.type !== "session" || route.sessionID !== event.data.sessionID) return
        await show(event.data.message)
      } else {
        ctx.ui.toast.show(event.data)
      }
    })
    // Plugin activation can repeat during a single TUI's lifetime. Memory state
    // survives those reloads, but resets on a real TUI restart (unlike disk state).
    const location = ctx.location ?? ctx.data.location.default()
    const [startup, updateStartup] = ctx.storage.memory("mcp-startup-refresh", {
      initial: { directories: [] as string[] },
    })
    if (!startup.directories.includes(location.directory)) {
      updateStartup((state) => { state.directories.push(location.directory) })
      void refreshMcps()
    }
    ctx.keymap.layer(() => ({ commands: [{
      id: "raven", title: "Raven", description: "Manage Raven routing, MCPs, models, and status",
      slash: { name: "raven", arguments: true },
      async run(input = "") {
        try {
          const args = input.replace(/^\s*\/raven(?:\s+|$)/i, "").trim()
          const refresh = mcpRefreshArguments(args)
          if (refresh) { await refreshMcps(refresh); return }
          const result = await rpc.command({ arguments: args }, { location: ctx.location ?? ctx.data.location.default() })
          await show(result.text)
        } catch (error) {
          ctx.ui.toast.show({ title: "Raven", message: String(error), variant: "error" })
        }
      },
    }] }))
    return () => {
      refreshController.abort()
      unsubscribe()
    }
  },
} satisfies Plugin.Definition
