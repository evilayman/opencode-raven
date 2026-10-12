// Deterministic, offline model/tool fixture for native v2 compatibility checks.
import { Model, Provider } from "@opencode/plugin"
import type { Plugin } from "@opencode/plugin"

export default {
  id: "raven-smoke-model",
  async setup(ctx) {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const body = await request.json() as { model: string; stream?: boolean; messages: Array<{ role: string; tool_call_id?: string }> }
      const results = body.messages.filter((message) => message.role === "tool")
      const delegated = results.some((message) => message.tool_call_id === "call-raven_seek")
      const searched = results.some((message) => message.tool_call_id === "call-grep")
      const caller = body.model.startsWith("caller")
      const toolName = caller && searched && !delegated ? "raven_seek" : "grep"
      const done = caller ? delegated : searched
      const content = caller ? "NATIVE MAIN DONE" : "NATIVE EVIDENCE"
      const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }
      if (!body.stream) return Response.json({ id: "offline", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "Offline title" }, finish_reason: "stop" }], usage })
      const delta = done ? { content } : { tool_calls: [{ index: 0, id: `call-${toolName}`, type: "function", function: {
        name: toolName, arguments: JSON.stringify(toolName === "grep" ? { pattern: "needle" } : { query: "Find native evidence", ...(body.model === "caller" ? { background: false } : {}) }),
      } }] }
      const frame = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: "offline", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta, finish_reason }], usage })}\n\n`
      return new Response(frame(delta, null) + frame({}, done ? "stop" : "tool_calls") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
    } })
    const providerID = Provider.ID.make("raven-smoke")
    const registrations = [await ctx.provider.transform((editor) => {
      editor.add({
        info: { ...Provider.Info.empty(providerID), package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "offline-fixture" } },
        models: ["caller", "caller-background", "retrieval"].map((id) => Model.Info.default(providerID, Model.ID.make(id))),
      })
    })]
    registrations.push(await ctx.agent.transform((editor) => {
      editor.update("build", (agent) => {
        agent.model = { providerID, id: Model.ID.make("caller") }
        agent.permissions = [
          { action: "*", resource: "*", effect: "allow" },
          // The native smoke must finish without an interactive approval.
          { action: "raven_seek", resource: "*", effect: "ask" },
          { action: "raven_mcp", resource: "*", effect: "ask" },
        ]
      })
    }))
    registrations.push(await ctx.tool.transform((editor) => {
      editor.add({ name: "grep", description: "Offline smoke search", input: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] }, options: { codemode: false },
        async execute(_input, context) {
          if (context.agent !== "raven") throw new Error("Main search bypassed Raven routing")
          return { content: "Direct child evidence" }
        },
      })
    }))
    await ctx.provider.reload()
    await ctx.agent.reload()
    await ctx.tool.reload()
    return async () => { server.stop(true); await Promise.all(registrations.map((registration) => registration.dispose())) }
  },
} satisfies Plugin.Plugin
