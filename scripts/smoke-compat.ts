// Native-host smoke check, with isolated config/data and no model generation.
// Usage: bun scripts/smoke-compat.ts v1|v2 [path-to-opencode-executable]
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import { OpenCode } from "@opencode/client"
import { RavenRpc } from "../rpc"

const host = Bun.argv[2]
if (host !== "v1" && host !== "v2") throw new Error("Usage: bun scripts/smoke-compat.ts v1|v2 [executable]")
const executable = Bun.argv[3] ?? "opencode"
const home = mkdtempSync(join(tmpdir(), "raven-host-smoke-"))
const workspace = join(home, "workspace")
const configDir = join(home, ".config", "opencode")
mkdirSync(workspace, { recursive: true })
mkdirSync(join(configDir, "opencode-raven"), { recursive: true })
writeFileSync(join(configDir, "opencode-raven", "raven-config.json"), JSON.stringify({
  raven_seek: { model: host === "v1" ? "opencode/big-pickle" : "raven-smoke/retrieval" },
  raven_mcp: { model: host === "v1" ? "opencode/big-pickle" : "raven-smoke/retrieval", onDemandMcpServers: {} },
}))
const plugin = pathToFileURL(resolve(import.meta.dirname!, "..", ...(host === "v1" ? ["index.ts"] : []))).href
const plugins = [plugin]
if (host === "v2") {
  const fixture = join(home, "smoke-model")
  mkdirSync(fixture)
  writeFileSync(join(fixture, "index.ts"), `export { default } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dirname!, "smoke-model.ts")).href)}`)
  plugins.unshift(pathToFileURL(fixture).href)
}
writeFileSync(join(workspace, "opencode.json"), JSON.stringify({ [host === "v1" ? "plugin" : "plugins"]: plugins }))
const env: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: home, USERPROFILE: home, OPENCODE_TEST_HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".data"),
  XDG_CACHE_HOME: join(home, ".cache"), XDG_STATE_HOME: join(home, ".state"),
  OPENCODE_SERVER_PASSWORD: "raven-isolated-smoke", OPENCODE_SERVER_USERNAME: "opencode",
}
for (const key of ["OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_PURE", "OPENCODE_DISABLE_PROJECT_CONFIG", "OPENCODE_DISABLE_DEFAULT_PLUGINS"]) delete env[key]
let proc: ReturnType<typeof Bun.spawn> | undefined
let logs = ""
try {
  if (host === "v1") {
    proc = Bun.spawn([executable, "debug", "agent", "raven"], { cwd: workspace, env, stdout: "pipe", stderr: "pipe" })
    const timer = setTimeout(() => proc?.kill(), 45_000)
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text(), proc.exited,
    ])
    clearTimeout(timer)
    if (code !== 0) throw new Error(`v1 exited ${code}: ${stderr}\n${stdout}`)
    const agent = JSON.parse(stdout)
    if (agent.mode !== "subagent" || agent.model?.modelID !== "big-pickle") throw new Error(`Unexpected Raven agent: ${stdout}`)
    console.log("v1: native loader accepted the dual entrypoint and registered Raven with its configured model")
  } else {
    const reserve = Bun.serve({ port: 0, fetch: () => new Response() })
    const port = reserve.port!
    reserve.stop(true)
    proc = Bun.spawn([executable, "serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs", "--log-level", "debug"], { cwd: workspace, env, stdout: "pipe", stderr: "pipe" })
    const collect = async (stream: ReadableStream<Uint8Array>) => {
      for await (const chunk of stream) logs += new TextDecoder().decode(chunk)
    }
    const collectors = [collect(proc.stdout as ReadableStream<Uint8Array>), collect(proc.stderr as ReadableStream<Uint8Array>)]
    const client = OpenCode.make({
      baseUrl: `http://127.0.0.1:${port}`,
      headers: { authorization: `Basic ${Buffer.from("opencode:raven-isolated-smoke").toString("base64")}` },
    })
    let ready = false
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await client.server.info({ signal: AbortSignal.timeout(500) }); ready = true; break }
      catch { if (proc.exitCode !== null) break; await Bun.sleep(100) }
    }
    if (!ready) throw new Error(`v2 server did not start: ${logs}`)
    const options = { signal: AbortSignal.timeout(30_000) }
    let agents = await client.agent.list({ location: { directory: workspace } }, options)
    for (let attempt = 0; attempt < 100 && !agents.data.some((agent) => agent.id === "raven"); attempt++) {
      await Bun.sleep(100)
      agents = await client.agent.list({ location: { directory: workspace } }, options)
    }
    for (const id of ["raven", "raven-mcp"]) {
      const agent = agents.data.find((agent) => agent.id === id)
      if (agent?.mode !== "subagent" || agent.model?.id !== "retrieval") {
        const plugins = await client.plugin.list({ location: { directory: workspace } }, options)
        const config = await client.config.get({ location: { directory: workspace } }, options)
        throw new Error(`Missing/incorrect ${id}: ${JSON.stringify(agents)}\nPlugins: ${JSON.stringify(plugins)}\nConfig: ${JSON.stringify(config)}\n${logs}`)
      }
    }
    const session = await client.session.create({ location: { directory: workspace }, agent: "build", model: { providerID: "raven-smoke", id: "caller" } }, options)
    await client.session.command({ sessionID: session.id, name: "raven", text: "help" }, options)
    const result = await client.rpc(RavenRpc).command({ arguments: "help" }, { ...options, location: { directory: workspace } })
    if (!result.text.includes("/raven seek model")) throw new Error(`Native Raven RPC returned no help: ${JSON.stringify(result)}`)
    const context = await client.session.context({ sessionID: session.id }, options)
    const inbox = await client.session.inbox.list({ sessionID: session.id }, options)
    if (context.length || inbox.length) throw new Error("/raven help unexpectedly queued session input or scheduled model generation")
    await client.session.prompt({ sessionID: session.id, text: "Run the offline routing and delegation smoke check" }, options)
    await client.session.wait({ sessionID: session.id }, options)
    const completed = await client.session.context({ sessionID: session.id }, options)
    const answer = completed.filter((message) => message.type === "assistant").at(-1)
    if (answer?.type !== "assistant" || !answer.content.some((part) => part.type === "text" && part.text === "NATIVE MAIN DONE")) {
      throw new Error(`Native delegation failed: ${JSON.stringify(completed)}\n${logs}`)
    }
    const toolParts = completed.filter((message) => message.type === "assistant").flatMap((message) => message.content).filter((part) => part.type === "tool")
    const routed = toolParts.find((part) => part.name === "grep")
    const delegated = toolParts.find((part) => part.name === "raven_seek")
    if (routed?.state.status !== "error" || delegated?.state.status !== "completed" || !delegated.state.content.some((part) => part.type === "text" && part.text.includes("NATIVE EVIDENCE"))) {
      throw new Error(`Native routing/delegation output mismatch: ${JSON.stringify(toolParts)}\n${logs}`)
    }
    await client.session.remove({ sessionID: session.id }, options)
    const background = await client.session.create({ location: { directory: workspace }, agent: "build", model: { providerID: "raven-smoke", id: "caller-background" } }, options)
    await client.session.prompt({ sessionID: background.id, text: "Run the background delegation smoke check" }, options)
    await client.session.wait({ sessionID: background.id }, options)
    let backgroundContext = await client.session.context({ sessionID: background.id }, options)
    for (let attempt = 0; attempt < 100 && !backgroundContext.some((message) => message.type === "synthetic" && message.text.includes("NATIVE EVIDENCE")); attempt++) {
      await Bun.sleep(100)
      backgroundContext = await client.session.context({ sessionID: background.id }, options)
    }
    const acknowledgement = backgroundContext.filter((message) => message.type === "assistant").flatMap((message) => message.content).find((part) => part.type === "tool" && part.name === "raven_seek")
    if (acknowledgement?.type !== "tool" || acknowledgement.state.status !== "completed" || !acknowledgement.state.content.some((part) => part.type === "text" && part.text.includes("started in the background"))
      || !backgroundContext.some((message) => message.type === "synthetic" && message.text.includes("NATIVE EVIDENCE"))) {
      throw new Error(`Native background delegation failed: ${JSON.stringify(backgroundContext)}\n${logs}`)
    }
    const notice = backgroundContext.find((message) => message.type === "synthetic" && message.text.includes("NATIVE EVIDENCE"))
    if (notice?.type !== "synthetic") throw new Error("Missing native background completion")
    // Retried delivery after an ambiguous disconnect must not duplicate evidence.
    await client.session.synthetic({ sessionID: background.id, id: notice.id, text: notice.text, delivery: "steer", resume: true }, options)
    await client.session.wait({ sessionID: background.id }, options)
    const retried = await client.session.context({ sessionID: background.id }, options)
    if (retried.filter((message) => message.type === "synthetic" && message.id === notice.id).length !== 1) throw new Error("Duplicate background result admission")
    await client.session.remove({ sessionID: background.id }, options)
    console.log("v2: native agents, commands/RPC, routing, foreground and background Raven delegation passed (offline model)")
    proc.kill()
    await proc.exited
    await Promise.all(collectors)
  }
} catch (error) {
  if (logs) console.error(logs)
  throw error
} finally {
  if (proc && proc.exitCode === null) { proc.kill(); await proc.exited }
  rmSync(home, { recursive: true, force: true })
}
