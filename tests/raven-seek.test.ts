import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import RavenPlugin from "../index"

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
  const hooks = await RavenPlugin(pluginInput(client))
  return (hooks.tool as any).raven_seek
}

async function ravenMcp(client: any) {
  const hooks = await RavenPlugin(pluginInput(client))
  return { hooks, mcp: (hooks.tool as any).raven_mcp }
}

describe("Raven configuration migration", () => {
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
    const prompt = mock(async () => ({ data: { parts: [{ type: "text", text: "Root-visible result" }] } }))
    const messages = mock(async () => ({ data: [] }))
    const seek = await ravenSeek({ session: { get, create, prompt, messages } })
    const { context } = toolContext()

    await seek.execute({ query: "Find evidence" }, context)

    expect(get).toHaveBeenCalledTimes(2)
    expect((create.mock.calls[0] as any)[0].body.parentID).toBe("ses_root")
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
    const prompt = mock(async () => ({ data: { parts: [{ type: "text", text: "MCP result" }] } }))
    const messages = mock(async () => ({ data: [] }))
    const { mcp } = await ravenMcp({ session: { get, create, prompt, messages } })
    const { context } = toolContext()

    const result = await mcp.execute({ query: "Use Context7 for current docs" }, context)

    expect((create.mock.calls[0] as any)[0].body.parentID).toBe("ses_root")
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
