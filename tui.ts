import type { Plugin } from "@opencode/plugin/tui"
import { RavenRpc } from "./rpc"

export default {
  id: "opencode-raven.tui",
  setup(ctx) {
    const rpc = ctx.client.rpc(RavenRpc)
    const show = async (text: string) => {
      await ctx.ui.dialog.alert({ title: "Raven", message: text })
    }
    const unsubscribe = rpc.events.on("notice", async (event) => {
      const location = ctx.location ?? ctx.data.location.default()
      if (event.location?.directory !== location.directory) return
      if (event.data.kind === "command") {
        const route = ctx.ui.router.current()
        if (route.type !== "session" || route.sessionID !== event.data.sessionID) return
        await show(event.data.message)
      } else {
        ctx.ui.toast.show(event.data)
      }
    })
    ctx.keymap.layer(() => ({ commands: [{
      id: "raven", title: "Raven", description: "Manage Raven routing, MCPs, models, and status",
      slash: { name: "raven", arguments: true },
      async run(input = "") {
        try {
          const args = input.replace(/^\s*\/raven(?:\s+|$)/i, "").trim()
          const result = await rpc.command({ arguments: args }, { location: ctx.location ?? ctx.data.location.default() })
          await show(result.text)
        } catch (error) {
          ctx.ui.toast.show({ title: "Raven", message: String(error), variant: "error" })
        }
      },
    }] }))
    return unsubscribe
  },
} satisfies Plugin.Definition
