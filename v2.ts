import type { Plugin, Agent } from "@opencode/plugin"
import type { PluginInput, Hooks, ToolContext as V1ToolContext } from "@opencode-ai/plugin"
import type { SessionMessageInfo, SessionInfo } from "@opencode/client"
import { z } from "zod"
import createRavenRuntime from "./raven-core"
import { backgroundDelegations } from "./background"
import { RavenRpc, mcpRefreshArguments, mcpRefreshToast } from "./rpc"

type Context = Plugin.Context
type RequestOptions = NonNullable<Parameters<Context["session"]["get"]>[1]>
type Runtime = Awaited<ReturnType<typeof createRavenRuntime>>
type Registration = { dispose(): Promise<void> }
type Call = { path?: { id: string }; body?: Record<string, any>; signal?: AbortSignal }
type AgentDefinition = {
  description: string
  mode: "subagent"
  hidden: boolean
  disable: boolean
  model?: string
  options: Record<string, unknown>
  permission: Record<string, "allow" | "deny" | "ask">
  prompt: string
}

function modelRef(value: string): NonNullable<Agent.Info["model"]> {
  const slash = value.indexOf("/")
  if (slash < 1 || slash === value.length - 1) throw new Error(`Invalid Raven model: ${value}`)
  const [id, variant] = value.slice(slash + 1).split("#")
  if (!id || value.slice(0, slash).includes("#") || value.split("#").length > 2 || (variant !== undefined && !variant)) throw new Error(`Invalid Raven model: ${value}`)
  return { providerID: value.slice(0, slash), id, ...(variant ? { variant } : {}) } as NonNullable<Agent.Info["model"]>
}

function legacyError(error: { type: string; message: string; status?: number; response?: { body: string } }) {
  return { name: error.type, data: { message: error.message, statusCode: error.status, responseBody: error.response?.body } }
}

// V2 projects messages directly, rather than wrapping them in { info, parts }.
// Preserve agent switches when validating persisted continuation history.
function legacyMessages(messages: readonly SessionMessageInfo[], session: SessionInfo) {
  let agent = typeof session.metadata?.opencodeRavenAgent === "string"
    ? session.metadata.opencodeRavenAgent : session.agent
  const currentAgentMatches = session.agent === agent
  return messages.map((message) => {
    if (message.type === "agent-switched") agent = message.agent
    if (message.type === "assistant") {
      return { info: { ...message, role: "assistant" }, parts: message.content }
    }
    return {
      info: { ...message, role: message.type, agent: currentAgentMatches ? agent : session.agent },
      parts: message.type === "user" ? [{ type: "text", text: message.text }] : [],
    }
  })
}

export async function setupRaven(ctx: Context): Promise<Plugin.Cleanup> {
  const registrations: Registration[] = []
  const controller = new AbortController()
  const background = backgroundDelegations(ctx, controller.signal)
  const location = { directory: ctx.location.directory }
  const agents: Record<string, AgentDefinition> = {}
  const globalMcpToolPrefixes = new Set<string>()
  const activeSessions = new Set<string>()
  let emitNotice: (notice: z.infer<typeof RavenRpc.events.notice.schema>) => Promise<void> = async () => {}
  let runtime: Runtime | undefined
  let startupTimer: ReturnType<typeof setTimeout> | undefined
  let eventPump: Promise<void> | undefined
  let disposed = false

  const requestOptions = (call: Call): RequestOptions => ({ signal: call.signal ? AbortSignal.any([call.signal, controller.signal]) : controller.signal })

  // Adapt only the host boundary. Raven's MCP transports, state, timeout logic,
  // command parser, and continuation validation remain shared with v1.
  const client = {
    provider: {
      async list(call: Call) {
        const response = await ctx.model.list({ location }, requestOptions(call))
        const models = response.data.filter((model) => model.providerID === "opencode" && model.enabled)
        return { data: {
          connected: models.length ? ["opencode"] : [],
          all: [{ id: "opencode", models: Object.fromEntries(models.map((model) => [model.id, {
            id: model.id,
            status: model.status,
            release_date: new Date(model.time.released).toISOString(),
            tool_call: model.capabilities.tools,
            cost: model.cost.length && model.cost.every((tier) => tier.input === 0 && tier.output === 0)
              ? { input: 0, output: 0 } : { input: 1, output: 1 },
            limit: model.limit,
          }])) }],
        } }
      },
    },
    session: {
      async get(call: Call) {
        return { data: await ctx.session.get({ sessionID: call.path!.id }, requestOptions(call)) }
      },
      async create(call: Call) {
        const agent = String(call.body!.agent)
        const definition = agents[agent]
        if (!definition?.model) throw new Error(`Raven agent ${agent} has no configured model`)
        return { data: await ctx.session.create({
          parentID: call.body!.parentID,
          title: call.body!.title,
          agent,
          model: modelRef(definition.model),
          location,
          metadata: { opencodeRavenAgent: agent },
        }, requestOptions(call)) }
      },
      async update(call: Call) {
        await ctx.session.update({ sessionID: call.path!.id, title: call.body!.title }, requestOptions(call))
      },
      async messages(call: Call) {
        const sessionID = call.path!.id
        const options = requestOptions(call)
        const [messages, session] = await Promise.all([
          ctx.session.context({ sessionID }, options), ctx.session.get({ sessionID }, options),
        ])
        return { data: legacyMessages(messages, session) }
      },
      async abort(call: Call) {
        await ctx.session.interrupt({ sessionID: call.path!.id, resume: false }, requestOptions(call))
      },
      async prompt(call: Call) {
        const sessionID = call.path!.id
        const options = requestOptions(call)
        const session = await ctx.session.get({ sessionID }, options)
        if (session.agent !== call.body!.agent) throw new Error("Raven session agent changed; start a new retrieval")
        activeSessions.add(sessionID)
        try {
          const previousIDs = new Set((await ctx.session.context({ sessionID }, options)).map((message) => message.id))
          const admitted = await ctx.session.prompt({
            sessionID,
            text: call.body!.parts.map((part: { text: string }) => part.text).join("\n"),
            delivery: "queue",
          }, options)
          // Admission is not completion. Wait for idle, then read only this turn's
          // final assistant message; a follow-up must never return an older answer.
          await ctx.session.wait({ sessionID }, options)
          options.signal?.throwIfAborted()
          const [messages, completed] = await Promise.all([
            ctx.session.context({ sessionID }, options), ctx.session.get({ sessionID }, options),
          ])
          const boundary = messages.findIndex((message) => message.id === admitted.id)
          // Compaction may remove the admitted user message from active context.
          // In that case, only newly projected messages can belong to this turn.
          const candidates = boundary >= 0 ? messages.slice(boundary + 1) : messages.filter((message) => !previousIDs.has(message.id))
          const nextUser = candidates.findIndex((message) => message.type === "user")
          const turn = nextUser < 0 ? candidates : candidates.slice(0, nextUser)
          const failed = turn.find((message) => message.type === "assistant" && (message.error || message.retry))
          if (failed?.type === "assistant") throw new Error(JSON.stringify(legacyError(failed.error ?? failed.retry!.error)))
          if (completed.outcome === "failed" || completed.outcome === "interrupted") {
            throw new Error(`Raven execution ${completed.outcome}; no completed answer is available`)
          }
          const answer = turn.filter((message) => message.type === "assistant").at(-1)
          if (answer?.type !== "assistant") {
            throw new Error(`Raven finished without an assistant answer (${completed.outcome ?? "unknown outcome"})`)
          }
          return { data: { parts: answer.content } }
        } finally {
          activeSessions.delete(sessionID)
        }
      },
    },
    tui: {
      async showToast({ body }: { body: { title?: string; message: string; variant?: "info" | "warning"; duration?: number } }) {
        if (disposed) return
        await emitNotice({ kind: "toast", ...body })
      },
    },
  }

  const cleanup = async () => {
    if (disposed) return
    disposed = true
    const running = [...activeSessions]
    controller.abort()
    if (startupTimer) clearTimeout(startupTimer)
    await Promise.allSettled(running.map((sessionID) => ctx.session.interrupt({ sessionID, resume: false }, { signal: AbortSignal.timeout(5000) })))
    await background.dispose()
    await Promise.allSettled(registrations.reverse().map((registration) => registration.dispose()))
    await runtime?.dispose()
    await eventPump
  }

  try {
    runtime = await createRavenRuntime({
      client: client as unknown as PluginInput["client"],
      directory: ctx.location.directory,
      project: { id: ctx.location.project.id },
    }, "v2")
    const raven = runtime
    const mcp = await ctx.mcp.list({ location }, { signal: controller.signal })
    const config = {
      mcp: Object.fromEntries(mcp.data.map((server) => [server.name, { enabled: server.status.status !== "disabled" }])),
      agent: agents,
      instructions: [] as string[],
    }
    await raven.config(config)
    registrations.push(await ctx.mcp.transform((editor) => {
      const names = editor.list().filter(([, server]) => !server.disabled).map(([name]) => name)
      raven.globalMcpRouting(names)
      globalMcpToolPrefixes.clear()
      for (const name of names) globalMcpToolPrefixes.add(`${name.replace(/[^a-zA-Z0-9_-]/g, "_")}_`)
    }))

    async function executeCommand(raw: string) {
      const output = { parts: [] as Array<{ type: string; text: string }> }
      await raven["command.execute.before"]({ command: "raven", arguments: raw, sessionID: "" }, output)
      return { text: output.parts.map((part) => part.text).join("\n") }
    }
    const rpc = await ctx.rpc.register(RavenRpc, {
      command: async ({ arguments: raw }) => executeCommand(raw),
      refreshMcps: async ({ serverName }) => raven.refreshMcps(serverName),
    })
    registrations.push(rpc)
    emitNotice = (notice) => rpc.events.emit("notice", notice)

    // Approve specific retrieval actions at execution time, not by adding a
    // blanket agent allow rule that changes Raven's entire tool policy.
    // Explicit configured denials are final and do not invoke this hook.
    registrations.push(await ctx.permission.hook("evaluate", (event) => {
      if (event.effect !== "ask") return
      const delegation = event.action === "raven_seek" || event.action === "raven_mcp"
      const retrieval = (event.agent === "raven" || event.agent === "raven-mcp") && (
        event.action === "webfetch" || event.action === "websearch" || event.action === "fetch"
        || [...globalMcpToolPrefixes].some((prefix) => event.action.startsWith(prefix))
      )
      if (delegation || retrieval) {
        event.effect = "allow"
      }
    }))

    registrations.push(await ctx.agent.transform((editor) => {
      for (const [id, definition] of Object.entries(agents)) {
        if (definition.disable) { editor.remove(id); continue }
        // The shipped registry upserts on update, including previously absent IDs.
        editor.update(id, (agent) => {
          agent.name = id as Agent.Name
          agent.description = definition.description
          agent.mode = definition.mode
          agent.hidden = definition.hidden
          agent.model = definition.model ? modelRef(definition.model) : undefined
          agent.system = definition.prompt
          agent.request.body = { ...definition.options }
          agent.permissions = Object.entries(definition.permission).map(([action, effect]) => ({
            action: action === "bash" ? "shell" : action === "task" ? "subagent" : action,
            resource: "*", effect,
          }))
        })
      }
    }))

    const tools: NonNullable<Hooks["tool"]> = raven.tool
    registrations.push(await ctx.tool.transform((editor) => {
      for (const [name, definition] of Object.entries(tools)) {
        const delegation = name === "raven_seek" || name === "raven_mcp"
        const schema = z.object({ ...definition.args, ...(delegation ? {
          background: z.boolean().optional().describe("Defaults to true. Return immediately and deliver compact findings to this calling session on completion. Set false to wait when the next step depends on these findings."),
        } : {}) })
        editor.add({
          name, description: definition.description + (delegation ? " Runs in the background by default on V2; completion findings arrive automatically. Use background: false to wait for dependent evidence." : ""),
          input: z.toJSONSchema(schema),
          options: { permission: name, codemode: false },
          async execute(input, context) {
            await raven["chat.message"]({ sessionID: context.sessionID, agent: context.agent }, {})
            await raven["tool.execute.before"]({ tool: name, sessionID: context.sessionID, callID: context.id }, { args: input })
            let metadata: Record<string, unknown> = {}
            let progress = Promise.resolve()
            const legacyContext: V1ToolContext = {
              sessionID: context.sessionID, messageID: context.messageID, agent: context.agent,
              directory: ctx.location.directory, worktree: ctx.location.project.directory,
              abort: AbortSignal.any([context.signal, controller.signal]),
              metadata(update) {
                metadata = { ...metadata, ...update.metadata, ...(update.title ? { title: update.title } : {}) }
                progress = progress.then(() => context.progress(metadata)).catch(() => {})
              },
              async ask() { throw new Error("Raven tools do not request additional permissions") },
            }
            const parsed: Record<string, any> = schema.parse(input)
            const execute = (toolContext: V1ToolContext) => definition.execute(parsed, toolContext)
            const result = delegation && parsed.background !== false
              ? await background.run(name, String(parsed.query), legacyContext, execute)
              : await execute(legacyContext)
            await progress
            return typeof result === "string" ? { content: result } : {
              content: result.output,
              metadata: { ...metadata, ...result.metadata, ...(result.title ? { title: result.title } : {}) },
            }
          },
        })
      }
    }))

    registrations.push(await ctx.tool.hook("execute.before", async (event) => {
      await raven["chat.message"]({ sessionID: event.sessionID, agent: event.agent }, {})
      const output = { args: event.input }
      await raven["tool.execute.before"]({
        ...event,
        callID: event.id,
      }, output)
      event.input = output.args
    }))
    registrations.push(await ctx.tool.hook("execute.after", async (event) => {
      if (event.status !== "completed") return
      await raven["tool.execute.after"]({ ...event, callID: event.id }, {
        metadata: event.result.metadata, output: event.result.content ?? "",
      })
    }))
    registrations.push(await ctx.session.hook("context", async (event) => {
      await raven["chat.message"]({ sessionID: event.sessionID, agent: event.agent }, {})
      if (event.agent === "raven") return
      event.system.push({ type: "text", text: event.agent === "raven-mcp" ? raven.mcpGuidance() : raven.guidance() })
      if (event.agent !== "raven-mcp") event.system.push({ type: "text", text: "On OpenCode V2, raven_seek and raven_mcp run in the background by default. Their initial response is a session handle, not findings. Continue independent work while waiting for the automatic completion message. Do not poll or repeat pending retrievals, and do not finalize dependent conclusions without their findings. Set background: false if your next step requires the answer. Follow-ups must wait until the earlier request finishes." })
    }))
    registrations.push(await ctx.session.hook("retry", async (event) => {
      await raven.event({ event: {
        type: "session.error", properties: { sessionID: event.sessionID, error: legacyError(event.error) },
      } })
    }))
    registrations.push(await ctx.command.transform((editor) => {
      editor.add({
        name: "raven", description: "Manage Raven routing, MCPs, models, timeouts, updates, and status",
        async execute({ sessionID, prompt }) {
          const refresh = mcpRefreshArguments(prompt.text)
          if (refresh) {
            await emitNotice({ kind: "toast", sessionID, title: "Raven MCP", message: `Refreshing ${refresh.serverName ?? "on-demand MCPs"}…`, variant: "info" })
            try {
              const result = await raven.refreshMcps(refresh.serverName)
              await emitNotice({ kind: "toast", sessionID, ...mcpRefreshToast(result) })
            } catch (error) {
              await emitNotice({ kind: "toast", sessionID, title: "Raven MCP", message: `Refresh failed: ${String(error)}`, variant: "error" })
            }
            return
          }
          const { text } = await executeCommand(prompt.text)
          await emitNotice({ kind: "command", sessionID, message: text, title: "Raven" })
        },
      })
    }))

    eventPump = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type === "model.updated") {
            await raven.event({ event: { type: "raven.models.ready" } })
          } else if (event.type === "session.created") {
            const data = event.data
            await raven.event({ event: { type: event.type, properties: { info: { ...data, id: data.sessionID } } } })
          } else if (event.type === "session.deleted") {
            const data = event.data
            await background.deleted(data.sessionID)
            await raven.event({ event: { type: event.type, properties: { info: { id: data.sessionID } } } })
          } else if (event.type === "session.execution.failed" || event.type === "session.retry.scheduled") {
            const data = event.data
            await raven.event({ event: { type: "session.error", properties: { sessionID: data.sessionID, error: legacyError(data.error) } } })
          } else if (event.type === "session.text.delta" || event.type === "session.reasoning.delta" || event.type === "session.tool.input.delta" || event.type === "session.text.started" || event.type === "session.reasoning.started" || event.type === "session.tool.input.started") {
            const data = event.data
            await raven.event({ event: { type: "message.part.updated", properties: { part: { sessionID: data.sessionID, type: "text" } } } })
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) console.error("Raven event subscription failed:", error)
      }
    })()
    await ctx.agent.reload()
    await ctx.tool.reload()
    await ctx.command.reload()
    await background.recover()
    startupTimer = setTimeout(() => {
      void raven.event({ event: { type: "raven.ready" } }).catch((error) => console.error("Raven startup failed:", error))
    }, 3000)
    return cleanup
  } catch (error) {
    await cleanup()
    throw error
  }
}
