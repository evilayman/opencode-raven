import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import RavenModule from "../index"
import type { Plugin as V2Plugin } from "@opencode/plugin"
import RavenTui from "../tui"
import { createTestRenderer } from "@opentui/core/testing"
import { RGBA, ScrollBoxRenderable, type BoxRenderable } from "@opentui/core"

const RavenPlugin = RavenModule.server

const originalUserProfile = process.env.USERPROFILE
const testHome = join(tmpdir(), `opencode-raven-test-${process.pid}`)
const ravenLog = join(tmpdir(), "raven-sessions.log")
const ravenConfigDir = join(testHome, ".config", "opencode", "opencode-raven")
const ravenConfigFile = join(ravenConfigDir, "raven-config.json")
let originalRavenLog: Buffer | undefined

beforeAll(() => {
  if (existsSync(ravenLog)) originalRavenLog = readFileSync(ravenLog)
  mkdirSync(testHome, { recursive: true })
  process.env.USERPROFILE = testHome
})

beforeEach(() => {
  rmSync(ravenConfigDir, { recursive: true, force: true })
})

afterAll(() => {
  if (originalUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = originalUserProfile
  rmSync(testHome, { recursive: true, force: true })
  if (originalRavenLog) writeFileSync(ravenLog, originalRavenLog)
  else rmSync(ravenLog, { force: true })
})

function pluginInput(client: any) {
  return {
    client,
    project: { id: "project-1" },
    directory: "C:\\workspace",
    worktree: "C:\\workspace",
    experimental_workspace: { register() {} },
    serverUrl: new URL("http://localhost"),
    $: undefined,
  } as any
}

function toolContext() {
  const metadata = mock(() => {})
  return {
    context: {
      sessionID: "ses_parent",
      messageID: "msg_1",
      agent: "build",
      directory: "C:\\workspace",
      worktree: "C:\\workspace",
      abort: new AbortController().signal,
      metadata,
      ask: async () => {},
    } as any,
    metadata,
  }
}

async function ravenSeek(client: any) {
  mkdirSync(ravenConfigDir, { recursive: true })
  writeFileSync(ravenConfigFile, JSON.stringify({
    raven_seek: { model: "provider/search" },
    raven_mcp: { model: "provider/mcp", onDemandMcpServers: {} },
  }))
  const hooks = await RavenPlugin(pluginInput(client))
  return (hooks.tool as any).raven_seek
}

async function ravenMcp(client: any) {
  mkdirSync(ravenConfigDir, { recursive: true })
  writeFileSync(ravenConfigFile, JSON.stringify({
    raven_seek: { model: "provider/search" },
    raven_mcp: { model: "provider/mcp", onDemandMcpServers: {} },
  }))
  const hooks = await RavenPlugin(pluginInput(client))
  return { hooks, mcp: (hooks.tool as any).raven_mcp }
}

describe("Raven configuration migration", () => {
  test("auto-selects the newest active free OpenCode model with tool support", async () => {
    const list = mock(async () => ({
      data: {
        connected: ["opencode"],
        all: [{
          id: "opencode",
          models: {
            paid: { id: "paid", status: "active", release_date: "2026-08-20", tool_call: true, cost: { input: 1, output: 1 }, limit: { context: 200000 } },
            oldFree: { id: "old-free", status: "active", release_date: "2026-01-01", tool_call: true, cost: { input: 0, output: 0 }, limit: { context: 100000 } },
            noTools: { id: "newer-free", status: "active", release_date: "2026-08-21", tool_call: false, cost: { input: 0, output: 0 }, limit: { context: 300000 } },
            selected: { id: "selected-free", status: "active", release_date: "2026-08-01", tool_call: true, cost: { input: 0, output: 0 }, limit: { context: 200000 } },
          },
        }],
      },
    }))

    const hooks = await RavenPlugin(pluginInput({ provider: { list }, session: {} }))
    const initialConfig: any = { mcp: {}, instructions: [] }
    await hooks.config!(initialConfig)
    expect(initialConfig.agent.raven.disable).toBe(true)
    expect(list).not.toHaveBeenCalled()
    await hooks.event!({ event: { type: "test.ready" } } as any)
    const saved = JSON.parse(readFileSync(ravenConfigFile, "utf-8"))
    expect(saved.raven_seek).toMatchObject({ model: "opencode/selected-free", autoSelectedModel: "opencode/selected-free" })
    expect(saved.raven_mcp).toMatchObject({ model: "opencode/selected-free", autoSelectedModel: "opencode/selected-free" })
    await hooks.dispose?.()

    const restarted = await RavenPlugin(pluginInput({ provider: { list }, session: {} }))
    const config: any = { mcp: {}, instructions: [] }
    await restarted.config!(config)
    expect(config.agent.raven.model).toBe("opencode/selected-free")
    expect(config.agent.raven.disable).toBe(false)
    expect(config.agent["raven-mcp"].model).toBe("opencode/selected-free")
    expect(list).toHaveBeenCalledTimes(1)
    await restarted.dispose?.()
  })

  test("keeps routing inactive when no free tool-capable model is available", async () => {
    const list = mock(async () => ({
      data: {
        connected: ["opencode"],
        all: [{
          id: "opencode",
          models: {
            paid: { id: "paid", status: "active", tool_call: true, cost: { input: 1, output: 1 }, limit: { context: 200000 } },
          },
        }],
      },
    }))
    const hooks = await RavenPlugin(pluginInput({ provider: { list }, session: {} }))
    const config: any = { mcp: {}, instructions: [] }
    await hooks.config!(config)
    expect(list).not.toHaveBeenCalled()
    await hooks.event!({ event: { type: "test.ready" } } as any)
    const saved = JSON.parse(readFileSync(ravenConfigFile, "utf-8"))
    expect(saved.raven_seek.model).toBeUndefined()
    expect(saved.raven_mcp.model).toBeUndefined()

    await (hooks as any)["tool.execute.before"](
      { tool: "grep", sessionID: "ses_parent", callID: "call_1" },
      { args: { pattern: "direct while unconfigured" } },
    )
    const result = await (hooks.tool as any).raven_seek.execute({ query: "search" }, toolContext().context)
    expect(result.output).toContain("Raven setup required")
    expect(result.output).toContain("/raven seek model <provider/model>")
    await hooks.dispose?.()
  })

  test("replaces the retired default but preserves manually configured models", async () => {
    mkdirSync(ravenConfigDir, { recursive: true })
    writeFileSync(ravenConfigFile, JSON.stringify({
      raven_seek: { model: "opencode/deepseek-v4-flash-free" },
      raven_mcp: { model: "provider/manual", onDemandMcpServers: {} },
    }))
    const list = mock(async () => ({
      data: {
        connected: ["opencode"],
        all: [{
          id: "opencode",
          models: {
            replacement: { id: "replacement-free", status: "active", tool_call: true, cost: { input: 0, output: 0 }, limit: { context: 100000 } },
          },
        }],
      },
    }))

    const hooks = await RavenPlugin(pluginInput({ provider: { list }, session: {} }))
    const config: any = { mcp: {}, instructions: [] }
    await hooks.config!(config)
    expect(config.agent.raven.disable).toBe(true)
    expect(config.agent["raven-mcp"].model).toBe("provider/manual")
    await hooks.event!({ event: { type: "test.ready" } } as any)
    const saved = JSON.parse(readFileSync(ravenConfigFile, "utf-8"))
    expect(saved.raven_seek.model).toBe("opencode/replacement-free")
    expect(saved.raven_seek.autoSelectedModel).toBe("opencode/replacement-free")
    expect(saved.raven_mcp.model).toBe("provider/manual")
    expect(saved.raven_mcp.autoSelectedModel).toBeUndefined()
    await hooks.dispose?.()
  })

  test("migrates the flat config into separate search and MCP sections", async () => {
    mkdirSync(ravenConfigDir, { recursive: true })
    writeFileSync(ravenConfigFile, JSON.stringify({
      enabled: false,
      model: "provider/legacy",
      reasoning_effort: "high",
      ravenInstructions: "legacy instructions",
      routeTools: ["grep"],
      routeToolKeywords: ["docs"],
      excludeAgents: ["explore"],
      excludeTools: ["glob"],
      timeout: 321,
      onDemandMcpDescriptionDetail: "minimized",
      onDemandMcpServers: {
        privateDocs: { type: "remote", url: "https://example.com/mcp", headers: { Authorization: "secret" } },
      },
      stats: { bytes: 42 },
    }))

    await RavenPlugin(pluginInput({ session: {} }))

    const migrated = JSON.parse(readFileSync(ravenConfigFile, "utf-8"))
    expect(migrated.enabled).toBeUndefined()
    expect(migrated.model).toBeUndefined()
    expect(migrated.raven_seek).toMatchObject({
      model: "provider/legacy",
      reasoning_effort: "high",
      instructions: "legacy instructions",
      routeTools: ["grep"],
      routeToolKeywords: ["docs"],
      excludeAgents: ["explore"],
      excludeTools: ["glob"],
      timeout: 321,
    })
    expect(migrated.raven_mcp).toMatchObject({
      model: "provider/legacy",
      reasoning_effort: "high",
      instructions: "legacy instructions",
      timeout: 321,
      descriptionDetail: "minimized",
    })
    expect(migrated.raven_mcp.onDemandMcpServers.privateDocs.headers.Authorization).toBe("secret")
    expect(migrated.stats).toEqual({ bytes: 42 })
  })

  test("registers separate configured models and permissions for both agents", async () => {
    mkdirSync(ravenConfigDir, { recursive: true })
    writeFileSync(ravenConfigFile, JSON.stringify({
      raven_seek: { model: "provider/search", reasoning_effort: "medium" },
      raven_mcp: { model: "provider/mcp", reasoning_effort: "high", onDemandMcpServers: {} },
    }))
    const hooks = await RavenPlugin(pluginInput({ session: {} }))
    const config: any = { mcp: {}, instructions: [] }

    await hooks.config!(config)

    expect(config.agent.raven.model).toBe("provider/search")
    expect(config.agent.raven.options.reasoning_effort).toBe("medium")
    expect(config.agent["raven-mcp"].model).toBe("provider/mcp")
    expect(config.agent["raven-mcp"].options.reasoning_effort).toBe("high")
    expect(config.agent.raven.permission.raven_mcp_bridge).toBe("deny")
    expect(config.agent["raven-mcp"].permission["*"]).toBe("deny")
    expect(config.agent["raven-mcp"].permission.raven_mcp_bridge).toBe("allow")
    await hooks.dispose?.()
  })
})

describe("raven_seek session continuation", () => {
  test("creates a new Raven session and returns its continuation handle", async () => {
    const create = mock(async () => ({ data: { id: "ses_new" } }))
    const prompt = mock(async () => ({ data: { parts: [{ type: "text", text: "New result" }] } }))
    const messages = mock(async () => ({ data: [] }))
    const seek = await ravenSeek({ session: { create, prompt, messages } })
    const { context, metadata } = toolContext()

    const result = await seek.execute({ query: "Research this" }, context)

    expect(create).toHaveBeenCalledTimes(1)
    expect((create.mock.calls[0] as any)[0].body.parentID).toBe("ses_parent")
    expect((prompt.mock.calls[0] as any)[0].path.id).toBe("ses_new")
    expect((prompt.mock.calls[0] as any)[0].body.agent).toBe("raven")
    expect(metadata).toHaveBeenCalledWith({ metadata: { sessionId: "ses_new" } })
    expect(result.metadata).toEqual({ sessionId: "ses_new" })
    expect(result.output).toContain("Raven session: `ses_new`")
  })

  test("attaches a nested caller's Raven session directly to the root", async () => {
    const get = mock(async ({ path }: any) => ({
      data: path.id === "ses_parent"
        ? { id: "ses_parent", parentID: "ses_root", projectID: "project-1" }
        : { id: "ses_root", projectID: "project-1" },
    }))
    const create = mock(async () => ({ data: { id: "ses_new" } }))
    const update = mock(async () => ({ data: { id: "ses_new" } }))
    const prompt = mock(async () => ({ data: { parts: [{ type: "text", text: "Root-visible result" }] } }))
    const messages = mock(async () => ({ data: [] }))
    const seek = await ravenSeek({ session: { get, create, update, prompt, messages } })
    const { context } = toolContext()

    await seek.execute({ query: "Find evidence" }, context)

    expect(get).toHaveBeenCalledTimes(2)
    expect((create.mock.calls[0] as any)[0].body.parentID).toBe("ses_root")
    expect((update.mock.calls[0] as any)[0]).toMatchObject({
      path: { id: "ses_new" },
      body: { title: "raven_seek: Find evidence" },
    })
    expect((prompt.mock.calls[0] as any)[0].body.agent).toBe("raven")
  })

  test("continues a validated Raven child without creating another session", async () => {
    const create = mock(async () => {
      throw new Error("create should not be called")
    })
    const get = mock(async () => ({
      data: { id: "ses_existing", parentID: "ses_parent", projectID: "project-1" },
    }))
    const previousMessages = [
      { info: { role: "user", agent: "raven" }, parts: [] },
      { info: { role: "assistant", tokens: { input: 100, output: 10 } }, parts: [] },
    ]
    const currentMessages = [
      ...previousMessages,
      { info: { role: "user", agent: "raven" }, parts: [] },
      { info: { role: "assistant", tokens: { input: 200, output: 20 } }, parts: [] },
    ]
    let messagesCall = 0
    const messages = mock(async () => ({ data: messagesCall++ === 0 ? previousMessages : currentMessages }))
    const prompt = mock(async () => ({ data: { parts: [{ type: "text", text: "Follow-up result" }] } }))
    const seek = await ravenSeek({ session: { create, get, messages, prompt } })
    const { context } = toolContext()

    const result = await seek.execute({ query: "Now compare them", sessionId: "ses_existing" }, context)

    expect(create).not.toHaveBeenCalled()
    expect(get).toHaveBeenCalledTimes(2)
    expect((messages.mock.calls[0] as any)[0].query).toBeUndefined()
    expect((prompt.mock.calls[0] as any)[0].path.id).toBe("ses_existing")
    expect(result.metadata).toEqual({ sessionId: "ses_existing" })
    expect(result.output).toContain("Raven session: `ses_existing` (continued)")
    expect(result.output).toContain("440B handled")
  })

  test("rejects a Raven session owned by another parent", async () => {
    const get = mock(async () => ({
      data: { id: "ses_other", parentID: "ses_other_parent", projectID: "project-1" },
    }))
    const messages = mock(async () => ({ data: [] }))
    const prompt = mock(async () => ({ data: { parts: [] } }))
    const seek = await ravenSeek({ session: { get, messages, prompt } })
    const { context } = toolContext()

    const result = await seek.execute({ query: "Continue", sessionId: "ses_other" }, context)

    expect(messages).not.toHaveBeenCalled()
    expect(prompt).not.toHaveBeenCalled()
    expect(result.output).toContain("not a Raven child of this main session")
  })

  test("rejects a child whose persisted messages belong to another agent", async () => {
    const get = mock(async () => ({
      data: { id: "ses_non_raven", parentID: "ses_parent", projectID: "project-1" },
    }))
    const messages = mock(async () => ({
      data: [{ info: { role: "user", agent: "explore" }, parts: [] }],
    }))
    const prompt = mock(async () => ({ data: { parts: [] } }))
    const seek = await ravenSeek({ session: { get, messages, prompt } })
    const { context } = toolContext()

    const result = await seek.execute({ query: "Continue", sessionId: "ses_non_raven" }, context)

    expect(prompt).not.toHaveBeenCalled()
    expect(result.output).toContain("not a Raven child of this main session")
  })

  test("rejects concurrent follow-ups to the same Raven session", async () => {
    const get = mock(async () => ({
      data: { id: "ses_busy", parentID: "ses_parent", projectID: "project-1" },
    }))
    const messages = mock(async () => ({
      data: [{ info: { role: "user", agent: "raven" }, parts: [] }],
    }))
    let finishPrompt!: () => void
    const promptResult = new Promise<any>((resolve) => {
      finishPrompt = () => resolve({ data: { parts: [{ type: "text", text: "Finished" }] } })
    })
    const prompt = mock(async () => promptResult)
    const seek = await ravenSeek({ session: { get, messages, prompt } })
    const firstContext = toolContext().context
    const secondContext = toolContext().context

    const first = seek.execute({ query: "First follow-up", sessionId: "ses_busy" }, firstContext)
    while (prompt.mock.calls.length === 0) await Promise.resolve()
    const second = await seek.execute({ query: "Second follow-up", sessionId: "ses_busy" }, secondContext)

    expect(prompt).toHaveBeenCalledTimes(1)
    expect(second.output).toContain("already handling a request")

    finishPrompt()
    await first
  })

  test("surfaces SDK prompt error envelopes instead of reporting an empty success", async () => {
    mkdirSync(ravenConfigDir, { recursive: true })
    writeFileSync(ravenConfigFile, JSON.stringify({
      raven_seek: { model: "provider/search" },
      raven_mcp: { model: "provider/mcp", onDemandMcpServers: {} },
    }))
    const create = mock(async () => ({ data: { id: "ses_deleted" } }))
    const prompt = mock(async () => ({
      error: { name: "NotFoundError", data: { message: "Session not found" } },
    }))
    const messages = mock(async () => ({ data: [] }))
    const hooks = await RavenPlugin(pluginInput({ session: { create, prompt, messages } }))
    const seek = (hooks.tool as any).raven_seek
    const { context } = toolContext()

    const result = await seek.execute({ query: "Research this" }, context)

    expect(result.output).toContain("session is no longer available")
    expect(result.output).not.toContain("Raven returned no results")
    expect(result.output).not.toContain("Pass this as `sessionId`")
    expect(result.metadata).toEqual({ sessionId: "ses_deleted" })
    expect((prompt.mock.calls[0] as any)[0].throwOnError).toBe(true)

    let routeError: Error | undefined
    try {
      await (hooks as any)["tool.execute.before"](
        { tool: "grep", sessionID: "ses_parent", callID: "call_1" },
        { args: { pattern: "next query" } },
      )
    } catch (err) {
      routeError = err as Error
    }
    expect(routeError?.message).toContain("next tool call should be raven_seek")
  })
})

describe("Raven MCP delegation", () => {
  test("uses the dedicated MCP agent and root-level parent", async () => {
    const get = mock(async ({ path }: any) => ({
      data: path.id === "ses_parent"
        ? { id: "ses_parent", parentID: "ses_root", projectID: "project-1" }
        : { id: "ses_root", projectID: "project-1" },
    }))
    const create = mock(async () => ({ data: { id: "ses_mcp" } }))
    const update = mock(async () => ({ data: { id: "ses_mcp" } }))
    const prompt = mock(async () => ({ data: { parts: [{ type: "text", text: "MCP result" }] } }))
    const messages = mock(async () => ({ data: [] }))
    const { mcp } = await ravenMcp({ session: { get, create, update, prompt, messages } })
    const { context } = toolContext()

    const result = await mcp.execute({ query: "Use Context7 for current docs" }, context)

    expect((create.mock.calls[0] as any)[0].body.parentID).toBe("ses_root")
    expect((update.mock.calls[0] as any)[0].path.id).toBe("ses_mcp")
    expect((prompt.mock.calls[0] as any)[0].body.agent).toBe("raven-mcp")
    expect(result.output).toContain("later `raven_mcp` call")
  })

  test("blocks the internal bridge outside the MCP agent", async () => {
    const { hooks } = await ravenMcp({ session: {} })
    let error: Error | undefined

    try {
      await (hooks as any)["tool.execute.before"](
        { tool: "raven_mcp_bridge", sessionID: "ses_parent", callID: "call_bridge" },
        { args: { server: "context7", operation: "list_tools" } },
      )
    } catch (caught) {
      error = caught as Error
    }

    expect(error?.message).toContain("only available inside the Raven MCP agent")
  })

  test("rejects a search-agent session passed to raven_mcp", async () => {
    const get = mock(async ({ path }: any) => ({
      data: path.id === "ses_parent"
        ? { id: "ses_parent", projectID: "project-1" }
        : { id: "ses_search", parentID: "ses_parent", projectID: "project-1" },
    }))
    const messages = mock(async () => ({
      data: [{ info: { role: "user", agent: "raven" }, parts: [] }],
    }))
    const prompt = mock(async () => ({ data: { parts: [] } }))
    const { mcp } = await ravenMcp({ session: { get, messages, prompt } })
    const { context } = toolContext()

    const result = await mcp.execute({ query: "Continue", sessionId: "ses_search" }, context)

    expect(prompt).not.toHaveBeenCalled()
    expect(result.output).toContain("does not belong to the raven-mcp agent")
  })
})

function tuiStorage() {
  const values = new Map<string, any>()
  return {
    memory(key: string, options: { initial: object }) {
      if (!values.has(key)) values.set(key, options.initial)
      const value = values.get(key)
      return [value, (mutate: (state: any) => void) => mutate(value)]
    },
  }
}

function v2Fixture() {
  const tools: Record<string, any> = {}
  const agents: Record<string, any> = {}
  const commands: Record<string, any> = {}
  const rpcHandlers: Record<string, any> = {}
  const rpcEmit = mock(async (_name: string, _data: any) => {})
  const hooks: Record<string, (...args: any[]) => Promise<void>> = {}
  const registrations: Array<{ dispose: ReturnType<typeof mock> }> = []
  const sessions = new Map<string, any>([["ses_parent", { id: "ses_parent", projectID: "project-1" }]])
  const history = new Map<string, any[]>()
  let pendingEvent: ((value: any) => void) | undefined
  const register = () => {
    const registration = { dispose: mock(async () => {}) }
    registrations.push(registration)
    return registration
  }
  const emit = (type: string, data: any) => pendingEvent?.({ type, data })
  const session = {
    get: mock(async ({ sessionID }: any) => {
      const info = sessions.get(sessionID)
      if (!info) throw new Error("Session not found")
      return info
    }),
    create: mock(async (input: any, _options?: any) => {
      const info = { ...input, id: `ses_v2_${sessions.size}`, projectID: "project-1" }
      sessions.set(info.id, info)
      return info
    }),
    update: mock(async () => {}),
    interrupt: mock(async () => {}),
    context: mock(async ({ sessionID }: any) => history.get(sessionID) ?? []),
    synthetic: mock(async (_input: any, _options?: any) => ({ id: "msg_notice" })),
    prompt: mock(async ({ sessionID, text }: any) => {
      const messages = history.get(sessionID) ?? []
      const admitted = { id: `msg_user_${messages.length}`, type: "user", text }
      history.set(sessionID, [...messages, admitted])
      return admitted
    }),
    wait: mock(async ({ sessionID }: any, _options?: any) => {
      emit("session.text.delta", { sessionID, delta: "Result" })
      const messages = history.get(sessionID) ?? []
      const info = sessions.get(sessionID)
      history.set(sessionID, [...messages, {
        id: `msg_assistant_${messages.length}`, type: "assistant", agent: info.agent,
        content: [{ type: "text", text: `Result ${messages.length}` }],
        tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      }])
      info.outcome = "succeeded"
    }),
  }
  const ctx = {
    app: { version: "2.0.26" },
    location: { directory: "C:\\workspace", project: { id: "project-1", directory: "C:\\workspace" } },
    agent: {
      transform: mock(async (callback: any) => {
        callback({
          update(id: string, update: any) {
            const info = agents[id] ?? { id, request: { settings: {}, headers: {}, body: {} } }
            update(info)
            agents[id] = info
          },
          remove(id: string) { delete agents[id] },
        })
        return register()
      }),
      reload: mock(async () => {}),
    },
    tool: {
      transform: mock(async (callback: any) => { callback({ add: (tool: any) => { tools[tool.name] = tool } }); return register() }),
      hook: mock(async (name: string, callback: any) => { hooks[`tool.${name}`] = callback; return register() }),
      reload: mock(async () => {}),
    },
    command: {
      transform: mock(async (callback: any) => { callback({ add: (command: any) => { commands[command.name] = command } }); return register() }),
      reload: mock(async () => {}),
    },
    session: { ...session, hook: mock(async (name: string, callback: any) => { hooks[`session.${name}`] = callback; return register() }) },
    model: { list: mock(async () => ({ data: [] as any[] })) },
    permission: {
      hook: mock(async (name: string, callback: any) => { hooks[`permission.${name}`] = callback; return register() }),
    },
    rpc: { register: mock(async (_definition: any, handlers: any) => {
      Object.assign(rpcHandlers, handlers)
      return { ...register(), events: { emit: rpcEmit } }
    }) },
    mcp: {
      list: mock(async () => ({ data: [{ name: "globalDocs", status: { status: "connected" } }] })),
      transform: mock(async (callback: any) => {
        callback({ list: () => [["globalDocs", { type: "remote", url: "https://example.com/mcp" }]] })
        return register()
      }),
    },
    event: {
      async *subscribe({ signal }: any) {
        while (!signal.aborted) {
          const event = await new Promise<any>((resolve) => {
            pendingEvent = resolve
            signal.addEventListener("abort", () => resolve(undefined), { once: true })
          })
          if (!event) break
          yield event
        }
      },
    },
  }
  return {
    ctx, tools, agents, commands, hooks, sessions, history, session, registrations, emit, rpcHandlers, rpcEmit,
    context: {
      sessionID: "ses_parent", messageID: "msg_1", id: "call_1", agent: "build",
      signal: new AbortController().signal, progress: mock(async () => {}),
    },
  }
}

async function setupV2(fixture = v2Fixture(), servers: Record<string, any> = {}) {
  mkdirSync(ravenConfigDir, { recursive: true })
  writeFileSync(ravenConfigFile, JSON.stringify({
    raven_seek: { model: "provider/search" },
    raven_mcp: { model: "provider/mcp", onDemandMcpServers: servers },
  }))
  const cleanup = await RavenModule.setup(fixture.ctx as unknown as V2Plugin.Context)
  return { ...fixture, cleanup: cleanup as () => Promise<void> }
}

describe("OpenCode 2 integration", () => {
  test("exposes one dual entrypoint and registers native agents, tools, permissions, and commands", async () => {
    expect(RavenModule.id).toBe("opencode-raven")
    expect(typeof RavenModule.server).toBe("function")
    const f = await setupV2()
    try {
      expect(f.agents.raven.model).toEqual({ providerID: "provider", id: "search" })
      expect(f.agents.raven.permissions).toContainEqual({ action: "shell", resource: "*", effect: "allow" })
      expect(f.agents.raven.permissions).toContainEqual({ action: "subagent", resource: "*", effect: "deny" })
      expect(f.agents["raven-mcp"].permissions).toContainEqual({ action: "*", resource: "*", effect: "deny" })
      expect(f.agents["raven-mcp"].permissions).toContainEqual({ action: "raven_mcp_bridge", resource: "*", effect: "allow" })
      expect(Object.keys(f.tools)).toEqual(["raven_seek", "raven_mcp", "raven_mcp_bridge"])
      expect(f.tools.raven_seek.input.required).toEqual(["query"])
      expect(f.commands.raven).toBeDefined()
      expect(f.ctx.agent.reload).toHaveBeenCalledTimes(1)
    } finally { await f.cleanup() }
    expect(f.registrations.every((r) => r.dispose.mock.calls.length === 1)).toBe(true)
    await f.cleanup() // disposal is idempotent
    expect(f.registrations.every((r) => r.dispose.mock.calls.length === 1)).toBe(true)
  })

  test("waits for completion and returns the new answer and native child-session metadata", async () => {
    const f = await setupV2()
    try {
      const first = await f.tools.raven_seek.execute({ query: "Find evidence" }, f.context)
      expect(first.content).toContain("Result 1")
      expect(first.metadata.sessionId).toBe("ses_v2_1")
      expect(f.session.create.mock.calls[0]).toEqual([expect.objectContaining({
        parentID: "ses_parent", agent: "raven", model: { providerID: "provider", id: "search" },
        metadata: { opencodeRavenAgent: "raven" },
      }), expect.objectContaining({ signal: expect.any(AbortSignal) })])
      const second = await f.tools.raven_seek.execute({ query: "Follow up", sessionId: first.metadata.sessionId }, f.context)
      expect(f.session.create).toHaveBeenCalledTimes(1)
      expect(f.session.wait).toHaveBeenCalledTimes(2)
      expect(second.content).toContain("Result 3")
      expect(second.content).not.toContain("Result 1")
      expect(second.content).toContain("(continued)")
      expect(f.context.progress).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "ses_v2_1" }))
    } finally { await f.cleanup() }
  })

  test("attaches MCP delegation to the root and uses the dedicated model", async () => {
    const f = await setupV2()
    f.sessions.set("ses_parent", { id: "ses_parent", projectID: "project-1", parentID: "ses_root" })
    f.sessions.set("ses_root", { id: "ses_root", projectID: "project-1" })
    try {
      await f.tools.raven_mcp.execute({ query: "Find MCP docs" }, f.context)
      expect(f.session.create.mock.calls[0][0]).toMatchObject({
        parentID: "ses_root", agent: "raven-mcp", model: { providerID: "provider", id: "mcp" },
      })
    } finally { await f.cleanup() }
  })

  test("routes shell searches and global MCPs while allowing bounded filters and Raven direct tools", async () => {
    const f = await setupV2()
    const before = (tool: string, input: any, agent = "build") => f.hooks["tool.execute.before"]({
      tool, input, agent, sessionID: agent === "build" ? "ses_parent" : "ses_raven", id: "call_1",
    })
    try {
      await expect(before("shell", { command: "rg query ." })).rejects.toThrow("raven_seek")
      await before("shell", { command: "git status | rg modified" })
      await expect(before("globalDocs_search", { query: "docs" })).rejects.toThrow("raven_seek")
      await before("grep", { pattern: "direct" }, "raven")
      await expect(before("raven_seek", { query: "recursive" }, "raven")).rejects.toThrow("cannot be called")
      await expect(before("raven_mcp_bridge", {})).rejects.toThrow("only available inside")
      await before("raven_mcp_bridge", {}, "raven-mcp")
    } finally { await f.cleanup() }
  })

  test("honors shell exclusions and injects guidance into main-agent model requests", async () => {
    const f = await setupV2()
    try {
      const config = JSON.parse(readFileSync(ravenConfigFile, "utf-8"))
      config.raven_seek.excludeTools = ["shell"]
      writeFileSync(ravenConfigFile, JSON.stringify(config))
      // Commands merge the latest config and apply routing changes immediately.
      await f.commands.raven.execute({ sessionID: "ses_parent", prompt: { text: "route tool add grep" } })
      await f.hooks["tool.execute.before"]({ tool: "shell", input: { command: "rg query ." }, agent: "build", sessionID: "ses_parent", id: "call_1" })
      const event = { sessionID: "ses_parent", agent: "build", system: [] as any[] }
      await f.hooks["session.context"](event)
      expect(event.system[0].text).toContain("Raven performs search and information retrieval only")
      const ravenEvent = { sessionID: "ses_raven", agent: "raven", system: [] as any[] }
      await f.hooks["session.context"](ravenEvent)
      expect(ravenEvent.system).toEqual([])
    } finally { await f.cleanup() }
  })

  test("refreshes global MCP routing after native catalog initialization", async () => {
    const f = await setupV2()
    try {
      f.ctx.mcp.transform.mock.calls[0][0]({ list: () => [["laterDocs", { type: "remote", url: "https://example.com/mcp" }]] })
      await expect(f.hooks["tool.execute.before"]({ tool: "laterDocs_search", input: { query: "docs" }, agent: "build", sessionID: "ses_parent", id: "call_1" })).rejects.toThrow("raven_seek")
    } finally { await f.cleanup() }
  })

  test("runs /raven commands through RPC without queuing session input or scheduling a model turn", async () => {
    const f = await setupV2()
    try {
      await f.commands.raven.execute({ sessionID: "ses_parent", prompt: { text: "seek timeout 45" } })
      expect(f.rpcEmit.mock.calls[0]).toEqual(["notice", expect.objectContaining({ sessionID: "ses_parent", kind: "command", message: expect.stringContaining("timeout set to 45s") })])
      const response = await f.rpcHandlers.command({ arguments: "help" })
      expect(response.text).toContain("/raven seek model")
      expect(f.session.synthetic).not.toHaveBeenCalled()
      expect(f.session.prompt).not.toHaveBeenCalled()
      expect(JSON.parse(readFileSync(ravenConfigFile, "utf-8")).raven_seek.timeout).toBe(45)
    } finally { await f.cleanup() }
  })

  test("auto-approves public delegation without overriding denials or other tool permissions", async () => {
    const f = await setupV2()
    try {
      for (const action of ["raven_seek", "raven_mcp"]) {
        const event = { action, effect: "ask" }
        await f.hooks["permission.evaluate"](event)
        expect(event.effect).toBe("allow")
        const denied = { action, effect: "deny" }
        await f.hooks["permission.evaluate"](denied)
        expect(denied.effect).toBe("deny")
      }
      for (const action of ["raven_mcp_bridge", "shell", "read", "other_mcp", "raven_seek_other"]) {
        const event = { action, effect: "ask" }
        await f.hooks["permission.evaluate"](event)
        expect(event.effect).toBe("ask")
      }
    } finally { await f.cleanup() }
  })

  test("native MCP refresh commands emit only progress and result toasts", async () => {
    const f = await setupV2()
    try {
      await f.commands.raven.execute({ sessionID: "ses_parent", prompt: { text: "mcp refresh" } })
      expect(f.rpcEmit.mock.calls).toEqual([
        ["notice", expect.objectContaining({ kind: "toast", sessionID: "ses_parent", variant: "info", message: expect.stringContaining("Refreshing") })],
        ["notice", expect.objectContaining({ kind: "toast", sessionID: "ses_parent", variant: "success", message: expect.stringContaining("Refresh complete") })],
      ])
      expect(f.session.synthetic).not.toHaveBeenCalled()
      expect(f.session.prompt).not.toHaveBeenCalled()
      expect(f.session.create).not.toHaveBeenCalled()
    } finally { await f.cleanup() }
  })

  test("client refresh shares startup, rechecks ready MCPs, coalesces requests, and recovers failures", async () => {
    let probes = 0
    let toolName = "first_tool"
    let fail = false
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 405 })
      const body = await request.json() as any
      if (body.id === undefined) return new Response(null, { status: 202 })
      if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: {
        protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" },
      } })
      if (body.method === "tools/list") {
        probes++
        return Response.json(fail
          ? { jsonrpc: "2.0", id: body.id, error: { code: -32603, message: "MCP temporarily unavailable" } }
          : { jsonrpc: "2.0", id: body.id, result: { tools: [{ name: toolName, description: toolName, inputSchema: { type: "object" } }] } })
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, result: {} })
    } })
    let f: Awaited<ReturnType<typeof setupV2>> | undefined
    try {
      f = await setupV2(v2Fixture(), { fixture: { type: "remote", url: `http://127.0.0.1:${server.port}/mcp`, timeout: 1000 } })
      const initial = await Promise.all([f.rpcHandlers.refreshMcps({}), f.rpcHandlers.refreshMcps({})])
      expect(initial).toEqual([{ refreshed: ["fixture"], failed: [] }, { refreshed: ["fixture"], failed: [] }])
      expect(probes).toBe(1)
      expect(f.hooks["session.context"]).toBeDefined()

      toolName = "updated_tool"
      const [fresh, manual] = await Promise.all([
        f.rpcHandlers.refreshMcps({}),
        f.rpcHandlers.command({ arguments: "mcp refresh" }),
      ])
      expect(fresh).toEqual({ refreshed: ["fixture"], failed: [] })
      expect(manual.text).toContain("Refreshed: fixture")
      expect(probes).toBe(2)
      for (const agent of ["build", "raven-mcp"]) {
        const guidance = { sessionID: "ses_parent", agent, system: [] as any[] }
        await f.hooks["session.context"](guidance)
        expect(guidance.system[0].text).toContain("updated_tool")
        expect(guidance.system[0].text).not.toContain("first_tool")
        expect(guidance.system[0].text).toContain(agent === "raven-mcp" ? "Use raven_mcp_bridge" : "public raven_mcp delegator")
      }
      expect(f.agents["raven-mcp"].system).not.toContain("Discovered capabilities:")

      fail = true
      expect(await f.rpcHandlers.refreshMcps({})).toEqual({ refreshed: [], failed: ["fixture"] })
      expect((await f.rpcHandlers.command({ arguments: "mcp" })).text).toContain("failed")
      fail = false
      expect(await f.rpcHandlers.refreshMcps({})).toEqual({ refreshed: ["fixture"], failed: [] })
      const metadata = JSON.parse(readFileSync(join(ravenConfigDir, "autogenerated-on-demand-mcp-metadata.json"), "utf-8"))
      expect(metadata.fixture.status).toBe("ready")
      expect(metadata.fixture.lastError).toBeUndefined()
      expect(probes).toBe(4)
      expect(await f.rpcHandlers.refreshMcps({ serverName: "FIXTURE" })).toEqual({ refreshed: ["fixture"], failed: [] })
      expect(probes).toBe(5)
      expect(f.session.prompt).not.toHaveBeenCalled()
    } finally {
      await f?.cleanup()
      server.stop(true)
    }
  })

  test("each new TUI launch refreshes MCPs without blocking and reports RPC errors", async () => {
    const pending = Promise.withResolvers<{ refreshed: string[]; failed: string[] }>()
    const refreshMcps = mock((_input: any, _options: any) => pending.promise)
    const toast = mock((_notice: any) => {})
    const unsubscribe = mock(() => {})
    const ctx = {
      storage: tuiStorage(),
      client: { rpc: () => ({ refreshMcps, events: { on: () => unsubscribe } }) },
      data: { location: { default: () => ({ directory: "C:\\workspace" }) } },
      keymap: { layer: () => {} },
      ui: { toast: { show: toast } },
    }
    const closeFirst = RavenTui.setup(ctx as any)
    expect(refreshMcps).toHaveBeenCalledTimes(1)
    expect(toast.mock.calls[0][0]).toMatchObject({ variant: "info", message: expect.stringContaining("Refreshing") })
    closeFirst()
    const closeSecond = RavenTui.setup({ ...ctx, storage: tuiStorage() } as any)
    try {
      expect(refreshMcps).toHaveBeenCalledTimes(2)
      expect(refreshMcps.mock.calls[1][1].location).toEqual({ directory: "C:\\workspace" })
      pending.reject(new Error("RPC disconnected"))
      await pending.promise.catch(() => {})
      await Promise.resolve()
      expect(toast).toHaveBeenCalledTimes(3) // Two progress toasts, only the open client's error.
      expect(toast.mock.calls[2][0].message).toContain("/raven mcp refresh")
    } finally { closeSecond() }
  })

  test("returning from sessions or reactivating a plugin does not repeat the startup refresh", async () => {
    const refreshMcps = mock(async (_input: any, _options: any) => ({ refreshed: ["context7"], failed: [] }))
    const toast = mock((_notice: any) => {})
    const storage = tuiStorage()
    let layer: any
    const ctx = {
      storage,
      location: { directory: "C:\\workspace" },
      client: { rpc: () => ({ refreshMcps, events: { on: () => () => {} } }) },
      keymap: { layer: (factory: any) => { layer = factory() } },
      ui: { toast: { show: toast } },
    }
    const first = RavenTui.setup(ctx as any)
    await layer.commands[0].run("/raven mcp refresh") // Wait for the shared startup check.
    first()
    const second = RavenTui.setup({ ...ctx } as any)
    try {
      expect(refreshMcps).toHaveBeenCalledTimes(1)
      expect(toast).toHaveBeenCalledTimes(2)
      await layer.commands[0].run("/raven mcp refresh")
      expect(refreshMcps).toHaveBeenCalledTimes(2) // Explicit refresh still works.
    } finally { second() }
    const third = RavenTui.setup({ ...ctx } as any)
    expect(refreshMcps).toHaveBeenCalledTimes(2)
    third()
    const otherWorkspace = RavenTui.setup({ ...ctx, location: { directory: "C:\\other" } } as any)
    await layer.commands[0].run("/raven mcp refresh")
    expect(refreshMcps).toHaveBeenCalledTimes(3)
    otherWorkspace()
    const back = RavenTui.setup(ctx as any)
    expect(refreshMcps).toHaveBeenCalledTimes(3)
    back()
  })

  test("manual and automatic refreshes show only notifications, including partial failures", async () => {
    const refreshMcps = mock(async (_input: any, _options: any) => ({ refreshed: ["context7"], failed: [] as string[] }))
    const command = mock(async () => ({ text: "Unexpected dialog" }))
    const toast = mock((_notice: any) => {})
    const show = mock(() => {})
    let layer: any
    const cleanup = RavenTui.setup({
      storage: tuiStorage(),
      client: { rpc: () => ({ command, refreshMcps, events: { on: () => () => {} } }) },
      location: { directory: "C:\\workspace" },
      keymap: { layer: (factory: any) => { layer = factory() } },
      ui: { dialog: { show }, toast: { show: toast } },
    } as any)
    try {
      await layer.commands[0].run("/raven mcp refresh") // Shares the attachment check already in flight.
      expect(refreshMcps).toHaveBeenCalledTimes(1)
      expect(toast.mock.calls.map(([notice]) => notice.variant)).toEqual(["info", "success"])
      expect(toast.mock.calls[1][0].message).toContain("context7")
      toast.mockClear()
      refreshMcps.mockImplementation(async () => ({ refreshed: ["context7"], failed: ["exa"] }))
      await layer.commands[0].run("/raven mcp refresh")
      expect(toast.mock.calls.map(([notice]) => notice.variant)).toEqual(["info", "warning"])
      expect(toast.mock.calls[1][0].message).toContain("Failed: exa")
      expect(command).not.toHaveBeenCalled()
      expect(show).not.toHaveBeenCalled()
      await layer.commands[0].run("/raven mcp refresh context7")
      expect(refreshMcps.mock.calls[2][0]).toEqual({ serverName: "context7" })
      expect(show).not.toHaveBeenCalled()
    } finally { cleanup() }
  })

  test("terminal companion displays scrollable command output and filters notices by location", async () => {
    const command = mock(async (_input: any, _options: any) => ({ text: "Raven status" }))
    const refreshMcps = mock(async (_input: any, _options: any) => ({ refreshed: [], failed: [] }))
    const screen = await createTestRenderer({ width: 74, height: 24 })
    let dialog!: BoxRenderable
    const show = mock((render: () => any) => { dialog = render(); screen.renderer.root.add(dialog) })
    const set = mock((_options: any) => {})
    const toast = mock((_input: any) => {})
    const unsubscribe = mock(() => {})
    let receive!: (event: any) => Promise<void>
    let layer: any
    const cleanup = RavenTui.setup({
      storage: tuiStorage(),
      client: { rpc: () => ({ command, refreshMcps, events: { on: (_name: string, callback: any) => { receive = callback; return unsubscribe } } }) },
      location: { directory: "C:\\workspace" },
      renderer: screen.renderer,
      theme: { surface: () => ({ background: { base: RGBA.fromValues(0.1, 0.1, 0.1, 0) }, text: { base: RGBA.fromHex("#ffffff"), muted: RGBA.fromHex("#aaaaaa") } }) },
      keymap: { layer: (factory: any) => { layer = factory() } },
      ui: { dialog: { show, set }, toast: { show: toast }, router: { current: () => ({ type: "session", sessionID: "ses_parent" }) } },
    } as any)
    try {
      expect(refreshMcps).toHaveBeenCalledWith({}, expect.objectContaining({ location: { directory: "C:\\workspace" }, signal: expect.any(AbortSignal) }))
      expect(show).not.toHaveBeenCalled()
      await layer.commands[0].run("/raven help")
      expect(command).toHaveBeenCalledWith({ arguments: "help" }, { location: { directory: "C:\\workspace" } })
      expect(set).toHaveBeenCalledWith({ size: "large", centered: true })
      await screen.renderOnce()
      expect(screen.captureCharFrame()).toContain("Raven status")
      const scroll = dialog.getChildren().find((child) => child instanceof ScrollBoxRenderable) as ScrollBoxRenderable
      expect(scroll.focused).toBe(true)
      expect(dialog.backgroundColor.a).toBe(1)
      toast.mockClear() // Automatic refresh notifications are tested separately.
      await receive({ location: { directory: "C:\\other" }, data: { kind: "toast", message: "Wrong location" } })
      expect(toast).not.toHaveBeenCalled()
      await receive({ location: { directory: "C:\\workspace" }, data: { kind: "toast", message: "MCP warning", variant: "warning" } })
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ message: "MCP warning" }))
      dialog.destroyRecursively()
      const listeners = screen.renderer.listenerCount("resize")
      await receive({ location: { directory: "C:\\workspace" }, data: { kind: "command", sessionID: "other", message: "Wrong session" } })
      expect(show).toHaveBeenCalledTimes(1)
      await receive({ location: { directory: "C:\\workspace" }, data: { kind: "command", sessionID: "ses_parent", message: Array.from({ length: 80 }, (_, i) => `Output line ${i}`).join("\n") } })
      await screen.renderOnce()
      const longScroll = dialog.getChildren().find((child) => child instanceof ScrollBoxRenderable) as ScrollBoxRenderable
      expect(longScroll.scrollHeight).toBeGreaterThan(longScroll.height)
      screen.mockInput.pressArrow("down")
      await screen.renderOnce()
      expect(longScroll.scrollTop).toBeGreaterThan(0)
      const previous = longScroll.scrollTop
      await screen.mockMouse.scroll(longScroll.x + 1, longScroll.y + 1, "down")
      await screen.renderOnce()
      expect(longScroll.scrollTop).toBeGreaterThan(previous)
      const beforePage = longScroll.scrollTop
      await screen.mockInput.pressKeys(["\u001b[6~"])
      await screen.renderOnce()
      expect(longScroll.scrollTop).toBeGreaterThan(beforePage + 1)
      longScroll.scrollTo(longScroll.scrollHeight)
      await screen.renderOnce()
      expect(screen.captureCharFrame()).toContain("Output line 79")
      screen.resize(42, 14)
      await screen.renderOnce()
      expect(dialog.height).toBe(10)
      expect(longScroll.height).toBeGreaterThan(0)
      dialog.destroyRecursively()
      expect(screen.renderer.listenerCount("resize")).toBe(listeners)
    } finally {
      cleanup()
      screen.renderer.destroy()
    }
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(refreshMcps.mock.calls[0][1].signal.aborted).toBe(true)
  })

  test("rejects foreign roots, the wrong agent, and switched-agent history", async () => {
    const f = await setupV2()
    try {
      for (const [id, info, messages] of [
        ["ses_foreign", { parentID: "ses_other", agent: "raven" }, [{ id: "u1", type: "user" }]],
        ["ses_wrong", { parentID: "ses_parent", agent: "raven-mcp" }, [{ id: "u1", type: "user" }]],
        ["ses_switched", { parentID: "ses_parent", agent: "raven", metadata: { opencodeRavenAgent: "raven" } }, [
          { id: "s1", type: "agent-switched", agent: "build" },
          { id: "u1", type: "user", text: "Other agent's work" },
          { id: "s2", type: "agent-switched", agent: "raven" },
        ]],
      ] as const) {
        f.sessions.set(id, { id, projectID: "project-1", ...info })
        f.history.set(id, [...messages])
        const result = await f.tools.raven_seek.execute({ query: "Continue", sessionId: id }, f.context)
        expect(result.content).toContain("not a Raven child")
      }
      expect(f.session.prompt).not.toHaveBeenCalled()
    } finally { await f.cleanup() }
  })

  test("resumes a compacted, persisted Raven child and handles compaction during a turn", async () => {
    const f = await setupV2()
    f.sessions.set("ses_compacted", { id: "ses_compacted", projectID: "project-1", parentID: "ses_parent", agent: "raven", metadata: { opencodeRavenAgent: "raven" } })
    f.history.set("ses_compacted", [{ id: "summary_old", type: "compaction", text: "Summary" }])
    f.ctx.session.wait = mock(async ({ sessionID }: any) => {
      f.history.set(sessionID, [
        { id: "summary_new", type: "compaction", text: "New summary" },
        { id: "new_answer", type: "assistant", agent: "raven", content: [{ type: "text", text: "After compaction" }] },
      ])
      f.sessions.get(sessionID).outcome = "succeeded"
    })
    try {
      const result = await f.tools.raven_seek.execute({ query: "Continue", sessionId: "ses_compacted" }, f.context)
      expect(result.content).toContain("After compaction")
      expect(result.content).toContain("(continued)")
      expect(f.session.create).not.toHaveBeenCalled()
    } finally { await f.cleanup() }
  })

  test("does not return a stale answer when a new turn produces no response", async () => {
    const f = await setupV2()
    try {
      const first = await f.tools.raven_seek.execute({ query: "First" }, f.context)
      f.ctx.session.wait = mock(async () => {})
      const result = await f.tools.raven_seek.execute({ query: "Second", sessionId: first.metadata.sessionId }, f.context)
      expect(result.content).toContain("without an assistant answer")
      expect(result.content).not.toContain("Result 1")
    } finally { await f.cleanup() }
  })

  test("cancellation interrupts the child and propagates the signal to the native wait", async () => {
    const f = await setupV2()
    const controller = new AbortController()
    const waiting = Promise.withResolvers<void>()
    f.ctx.session.wait = mock(async (_input: any, options?: any) => {
      waiting.resolve()
      await new Promise<void>((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true }))
    })
    try {
      const resultPromise = f.tools.raven_seek.execute({ query: "Cancel me" }, { ...f.context, signal: controller.signal })
      await waiting.promise
      controller.abort()
      const result = await resultPromise
      expect(result.content).toContain("cancelled")
      expect(f.session.interrupt).toHaveBeenCalledWith({ sessionID: "ses_v2_1", resume: false }, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    } finally { await f.cleanup() }
  })

  test("reports native provider failures promptly and retains the child", async () => {
    const f = await setupV2()
    let finish!: () => void
    f.ctx.session.wait = mock(async () => new Promise<void>((resolve) => { finish = resolve }))
    try {
      const resultPromise = f.tools.raven_seek.execute({ query: "Fail fast" }, f.context)
      while (!finish) await Promise.resolve()
      f.emit("session.execution.failed", { sessionID: "ses_v2_1", error: { type: "APIError", message: "Quota exhausted", status: 429 } })
      const result = await resultPromise
      expect(result.content).toContain("rate limited")
      expect(result.metadata.sessionId).toBe("ses_v2_1")
      expect(f.session.interrupt).toHaveBeenCalledTimes(1)
      finish()
    } finally { await f.cleanup() }
  })

  test("plugin disposal cancels pending delegation and interrupts the native child", async () => {
    const f = await setupV2()
    const waiting = Promise.withResolvers<void>()
    f.ctx.session.wait = mock(async (_input: any, options?: any) => {
      waiting.resolve()
      await new Promise<void>((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("Disposed")), { once: true }))
    })
    const resultPromise = f.tools.raven_seek.execute({ query: "Dispose during retrieval" }, f.context)
    await waiting.promise
    await f.cleanup()
    const result = await resultPromise
    expect(result.content).toContain("cancelled")
    expect(f.session.interrupt).toHaveBeenCalledWith({ sessionID: "ses_v2_1", resume: false }, expect.anything())
  })

  test("auto-detects enabled, free, tool-capable native models and requests restart", async () => {
    const f = v2Fixture()
    mkdirSync(ravenConfigDir, { recursive: true })
    writeFileSync(ravenConfigFile, JSON.stringify({ raven_seek: {}, raven_mcp: { onDemandMcpServers: {} } }))
    f.ctx.model.list = mock(async () => ({ data: [
      { id: "free-choice", providerID: "opencode", enabled: true, status: "active", time: { released: 1000 }, capabilities: { tools: true }, cost: [{ input: 0, output: 0 }], limit: { context: 100000 } },
      { id: "disabled-free", providerID: "opencode", enabled: false, status: "active", time: { released: 2000 }, capabilities: { tools: true }, cost: [{ input: 0, output: 0 }], limit: { context: 200000 } },
    ] as any[] }))
    const cleanup = await RavenModule.setup(f.ctx as unknown as V2Plugin.Context) as () => Promise<void>
    try {
      expect(f.agents.raven).toBeUndefined()
      const result = await f.tools.raven_seek.execute({ query: "Set up" }, f.context)
      expect(result.content).toContain("Restart OpenCode")
      expect(JSON.parse(readFileSync(ravenConfigFile, "utf-8")).raven_seek.model).toBe("opencode/free-choice")
    } finally { await cleanup() }
  })
})
