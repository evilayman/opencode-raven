import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

// ── Resolve paths relative to this package (works in node_modules/) ──
const PKG_DIR = import.meta.dirname!

const RAVEN_MD = join(PKG_DIR, "Raven.md")
const MCP_GUIDANCE_MD = join(PKG_DIR, "mcp-guidance.md")

// ── Search tools that should be intercepted for non-Raven agents ──
const SEARCH_TOOLS = [
  // Built-in tools
  "grep",
  "glob",
  "webfetch",
  "fetch",
  "websearch",
  // WebSearch MCP
  "websearch_web_search_exa",
  // Context7 MCP
  "context7_resolve-library-id",
  "context7_query-docs",
  // Exa AI MCP
  "exa_web_search_exa",
  "exa_web_fetch_exa",
  "exa_web_search_advanced_exa",
  "exa_company_research_exa",
  "exa_crawling_exa",
  "exa_people_search_exa",
  "exa_linkedin_search_exa",
  "exa_get_code_context_exa",
  "exa_deep_researcher_start",
  "exa_deep_researcher_check",
  "exa_deep_search_exa",
  // Grep.app MCP
  "grep_app_searchGitHub",
]

// ── Bash commands that look like search workarounds ──
const SEARCH_BASH_RE = /\b(rg|ripgrep|grep|egrep|fgrep|git\s+grep|ack|ag\b|findstr|Select-String|Get-ChildItem|gci\b|dir\b\s+[/-][sS]|ls\b\s+-[rR]|find\b\s+.*-name|find\b\s+.*-type)\b/i

// Strip quoted content to avoid false positives (e.g. echo "use grep here")
function stripHeredocs(cmd: string): string {
  return cmd.replace(/<<-?\s*["']?(\w+)["']?[\s\S]*?\n\s*\1/g, "")
}

function stripQuotedContent(cmd: string): string {
  return stripHeredocs(cmd)
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""')
}

function isSearchBash(tool: string, args: any): boolean {
  if (tool !== "bash") return false
  const cmd = stripQuotedContent(String(args?.command ?? ""))
  const desc = stripQuotedContent(String(args?.description ?? ""))
  const lower = cmd.toLowerCase().trim()
  return SEARCH_BASH_RE.test(cmd) || SEARCH_BASH_RE.test(desc) || /^cmd\s+\/c\s+(dir|findstr|find|where|tree)\b/.test(lower)
}

// ── Config file shape ──
interface RavenConfig {
  enabled: boolean
  model?: string
  reasoning_effort?: string
  excludeAgents?: string[]
  excludeTools?: string[]
  timeout?: number
  stats?: { bytes: number }
}

// ── Parse Raven.md frontmatter ──
const ravenMd = readFileSync(RAVEN_MD, "utf-8")
const { frontmatter: fm, prompt: ravenPrompt } = parseRavenMd(ravenMd)

const DEFAULT_CONFIG: RavenConfig = {
  enabled: true,
  model: fm.model,
  reasoning_effort: fm.reasoning_effort,
  excludeAgents: [],
  excludeTools: [],
  timeout: 180,
}

function parseRavenMd(raw: string): { frontmatter: Record<string, any>; prompt: string } {
  const parts = raw.split("---")
  if (parts.length < 3) {
    throw new Error("Raven.md missing frontmatter (--- delimiters)")
  }
  return { frontmatter: parseYaml(parts[1]), prompt: parts.slice(2).join("---").trim() }
}

// ── Minimal YAML parser (handles the structure used in Raven.md) ──
function parseYaml(yaml: string): Record<string, any> {
  const lines = yaml.split("\n")
  const root: Record<string, any> = {}
  const stack: Array<{ obj: Record<string, any>; indent: number }> = [
    { obj: root, indent: -1 },
  ]

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    if (!line.trim() || line.trim().startsWith("#")) continue

    const indent = line.search(/\S/)
    const colonIdx = line.indexOf(":")
    if (colonIdx === -1) continue

    const rawKey = line.slice(indent, colonIdx).trim()
    const key =
      (rawKey.startsWith('"') && rawKey.endsWith('"')) ||
      (rawKey.startsWith("'") && rawKey.endsWith("'"))
        ? rawKey.slice(1, -1)
        : rawKey

    const rawValue = line.slice(colonIdx + 1).trim()

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop()
    }
    const current = stack[stack.length - 1].obj

    if (!rawValue) {
      const nested: Record<string, any> = {}
      current[key] = nested
      stack.push({ obj: nested, indent })
    } else {
      let value: any = rawValue
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      } else if (value === "true") {
        value = true
      } else if (value === "false") {
        value = false
      }
      current[key] = value
    }
  }

  return root
}

// ── Move unknown frontmatter fields into options ──
const KNOWN_KEYS = new Set([
  "description", "mode", "hidden", "model", "permission",
  "prompt", "name", "color", "steps", "disable",
  "temperature", "top_p", "variant",
])

function extractOptions(fm: Record<string, any>): Record<string, any> {
  const options: Record<string, any> = {}
  for (const key of Object.keys(fm)) {
    if (!KNOWN_KEYS.has(key)) options[key] = fm[key]
  }
  return options
}

// ── Plugin ──
export default ((input: PluginInput) => {
  const client = input.client

  // Config file lives in the global opencode config directory
  const configFile = join(homedir(), ".config", "opencode", "raven-config.json")

  function loadConfig(): RavenConfig {
    try {
      if (existsSync(configFile)) {
        const raw = JSON.parse(readFileSync(configFile, "utf-8"))
        return {
          enabled: raw.enabled !== false,
          model: raw.model,
          reasoning_effort: raw.reasoning_effort,
          excludeAgents: Array.isArray(raw.excludeAgents) ? raw.excludeAgents : [],
          excludeTools: Array.isArray(raw.excludeTools) ? raw.excludeTools : [],
          timeout: typeof raw.timeout === "number" ? raw.timeout : undefined,
          stats: raw.stats || undefined,
        }
      }
    } catch { /* ignore corruption, use defaults */ }
    // Auto-create config file with defaults on first run
    saveConfig(DEFAULT_CONFIG)
    return { ...DEFAULT_CONFIG }
  }

  function saveConfig(config: RavenConfig) {
    try {
      mkdirSync(join(homedir(), ".config", "opencode"), { recursive: true })
      writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n")
    } catch { /* non-fatal: config won't persist but toggle still works in-session */ }
  }

  let config = loadConfig()
  const ravenSessions = new Set<string>()
  const sessionAgents = new Map<string, string>()

  // ── Check if an agent is excluded from Raven enforcement (case-insensitive) ──
  function isExcluded(agent: string | undefined): boolean {
    if (!agent || !config.excludeAgents?.length) return false
    const lower = agent.toLowerCase()
    return config.excludeAgents.some((a) => a.toLowerCase() === lower)
  }

  const REROUTE_MSG = "Search tools are blocked. Use raven_seek(query=\"...\") for all searches — local codebase, web, docs, and GitHub examples."

  // ── Context processed by raven_seek ──
  let sessionBytes = 0
  let totalBytes = config.stats?.bytes ?? 0

  function addBytes(bytes: number) {
    sessionBytes += bytes
    totalBytes += bytes
    config.stats = { bytes: totalBytes }
    saveConfig(config)
  }

  function formatBytes(bytes: number): string {
    return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)}MB`
      : bytes >= 1000 ? `${(bytes / 1000).toFixed(1)}KB`
      : `${bytes}B`
  }

  function formatTokens(bytes: number): string {
    const tokens = Math.round(bytes / 4)
    return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}K` : `${tokens}`
  }

  return {
    config(configInput: any) {
      // MCP servers
      configInput.mcp = configInput.mcp || {}
      configInput.mcp.context7 = {
        type: "remote", url: "https://mcp.context7.com/mcp", enabled: true,
      }
      configInput.mcp.exa = {
        type: "remote", url: "https://mcp.exa.ai/mcp", enabled: true,
      }
      configInput.mcp.grep_app = {
        type: "remote", url: "https://mcp.grep.app", enabled: true,
      }

      // Inject MCP guidance as a startup instruction file (absolute path for npm compat)
      configInput.instructions = configInput.instructions || []
      if (!configInput.instructions.includes(MCP_GUIDANCE_MD)) {
        configInput.instructions.push(MCP_GUIDANCE_MD)
      }

      // Register Raven from Raven.md, with config file overrides
      configInput.agent = configInput.agent || {}
      configInput.agent.raven = {
        description: fm.description || "",
        mode: fm.mode || "subagent",
        hidden: fm.hidden !== undefined ? fm.hidden : false,
        model: config.model || fm.model,
        options: {
          ...extractOptions(fm),
          ...(config.reasoning_effort ? { reasoning_effort: config.reasoning_effort } : {}),
        },
        permission: fm.permission || {},
        prompt: ravenPrompt,
      }

      // Register /raven command
      configInput.command = configInput.command || {}
      if (!configInput.command.raven) {
        configInput.command.raven = {
          template: "Manage Raven: /raven on|off|model <name>|status",
          description: "Toggle search interception or change Raven's model",
        }
      }
    },

    // Register raven_seek tool — lets agents with task:false still search through Raven
    tool: {
      "raven_seek": tool({
        description: "Unified search tool — use only when task delegation to Raven (subagent_type=\"raven\") is unavailable. Handles ALL searches: local codebase, web, docs, and GitHub examples via Context7, Exa AI, and Grep.app.",
        args: {
          query: tool.schema.string().describe("What to search for — be specific about what you need (docs, code examples, web info, etc.)"),
        },
        async execute(args, context) {
          const started = Date.now()
          const timeout = (config.timeout ?? 180) * 1000
          try {
            // Create a Raven session
            const session = await client.session.create({
              body: { title: `raven_seek: ${args.query.slice(0, 80)}` },
            })

            const sessionId = (session as any)?.data?.id ?? (session as any)?.id
            if (!sessionId) {
              return { title: "Raven Seek", output: "Failed to create Raven session." }
            }

            // Send the query to Raven with timeout
            const result = await Promise.race([
              client.session.prompt({
                path: { id: sessionId },
                body: {
                  agent: "raven",
                  parts: [{ type: "text", text: args.query }],
                },
              }),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`Raven timed out after ${timeout / 1000}s — session kept: ${sessionId}`)), timeout)
              ),
            ])

            const elapsed = ((Date.now() - started) / 1000).toFixed(1)

            // Extract text from the response
            const parts = (result as any)?.data?.parts ?? []
            const textParts = parts
              .filter((p: any) => p.type === "text" && p.text)
              .map((p: any) => p.text)
            const output = textParts.join("\n") || "Raven returned no results."

            // Clean up the session
            try {
              await client.session.delete({ path: { id: sessionId } })
            } catch { /* non-fatal */ }

            // Track context saved
            addBytes(output.length)

            return { title: "Raven Seek", output: `${output}\n\n*Raven searched for ${elapsed}s — ${formatBytes(output.length)}, ~${formatTokens(output.length)} tokens*` }
          } catch (err: any) {
            const elapsed = ((Date.now() - started) / 1000).toFixed(1)
            const msg = String(err?.message ?? err ?? "").toLowerCase()
            const hint =
              /rate.?limit|too many requests|429/i.test(msg) ? "Raven rate limited — wait 30s then retry with a narrower query."
              : /quota|usage.?limit|billing|insufficient.*(?:credit|balance|quota)/i.test(msg) ? "Raven API quota exhausted — proceed without search, tell user what's missing."
              : /token|context.?length|too large|too long/i.test(msg) ? "Raven query too large — shorten your query and retry."
              : /model|unavailable|down|not found/i.test(msg) ? "Raven model unavailable — retry later, or proceed without search."
              : /timeout|timed.?out|session kept/i.test(msg) ? err.message
              : `Raven search failed. Proceed without search — note gaps for the user. [${err.message || err}]`
            return { title: "Raven Seek", output: `${hint}\n\n*Attempt took ${elapsed}s*` }
          }
        },
      }),
    },

    // Track agent ↔ session mapping for allowlist + Raven exclusion
    "chat.message"(input: any, _output: any) {
      if (input.agent) {
        sessionAgents.set(input.sessionID, input.agent)
        if (input.agent === "raven") {
          ravenSessions.add(input.sessionID)
        }
      }
    },

    // /raven on|off|model <name>|effort <value>|timeout <seconds>|stats|status
    "command.execute.before"(input: any, output: any) {
      if (input.command !== "raven") return
      output.parts.length = 0
      const raw = input.arguments.trim()
      const arg = raw.toLowerCase()

      if (arg === "on") {
        config.enabled = true
        saveConfig(config)
        output.parts.push({ type: "text", text: "Raven search interception enabled. Non-Raven agents will be redirected to @raven for search tools." })
      } else if (arg === "off") {
        config.enabled = false
        saveConfig(config)
        output.parts.push({ type: "text", text: "Raven search interception disabled. All agents can use search tools directly." })
      } else if (arg === "stats") {
        output.parts.push({ type: "text", text: `Raven context processed:\n  This session: ${formatBytes(sessionBytes)} (~${formatTokens(sessionBytes)} tokens)\n  All time: ${formatBytes(totalBytes)} (~${formatTokens(totalBytes)} tokens)` })
      } else if (arg.startsWith("model ")) {
        const model = raw.slice(6).trim()
        if (!model) {
          output.parts.push({ type: "text", text: `Usage: /raven model <name>\nCurrent model: ${config.model || fm.model || "(default)"}` })
        } else {
          config.model = model
          saveConfig(config)
          output.parts.push({ type: "text", text: `Raven model set to: ${model}\nRestart opencode for the change to take effect.` })
        }
      } else if (arg.startsWith("effort ")) {
        const effort = raw.slice(7).trim()
        if (!effort) {
          output.parts.push({ type: "text", text: `Usage: /raven effort <value>\nCurrent: ${config.reasoning_effort || fm.reasoning_effort || "(default)"}` })
        } else {
          config.reasoning_effort = effort
          saveConfig(config)
          output.parts.push({ type: "text", text: `Raven reasoning effort set to: ${effort}\nRestart opencode for the change to take effect.` })
        }
      } else if (arg.startsWith("timeout ")) {
        const secs = parseInt(raw.slice(8).trim(), 10)
        if (!secs || secs < 10) {
          output.parts.push({ type: "text", text: `Usage: /raven timeout <seconds>\nMust be at least 10. Current: ${config.timeout ?? 180}s` })
        } else {
          config.timeout = secs
          saveConfig(config)
          output.parts.push({ type: "text", text: `Raven timeout set to ${secs}s. Takes effect immediately.` })
        }
      } else {
        const enabled = config.enabled ? "enabled" : "disabled"
        const model = config.model || fm.model || "(default)"
        const effort = config.reasoning_effort || fm.reasoning_effort || "(default)"
        const timeout = config.timeout ?? 180
        output.parts.push({ type: "text", text: `Raven is ${enabled}. Model: ${model}. Reasoning: ${effort}. Timeout: ${timeout}s\n\nCommands:\n  /raven on      — enable search interception\n  /raven off     — disable search interception\n  /raven model <name> — change Raven's model (requires restart)\n  /raven effort <value> — change Raven's reasoning effort (requires restart)\n  /raven timeout <seconds> — change raven_seek timeout\n  /raven stats   — show blocked calls and context saved` })
      }
    },

    "tool.execute.before"(input: any, output: any) {
      if (!config.enabled) return
      if (ravenSessions.has(input.sessionID)) return
      if (isExcluded(sessionAgents.get(input.sessionID))) return
      if (config.excludeTools?.includes(input.tool)) return

      // ── Subagent prompt injection: inject Raven guidance into every subagent ──
      if ((input.tool === "task" || input.tool === "subtask") && output.args) {
        const subagentType = input.tool === "task" ? (output.args.subagent_type ?? "") : ""
        if (subagentType !== "raven" && !isExcluded(subagentType)) {
          const field = ["prompt", "description", "request", "objective", "query"].find(
            (f) => f in output.args
          ) ?? "prompt"
          output.args[field] = `${output.args[field] ?? ""}\n\n<raven_guidance>\nSearch tools (grep, glob, ls, dir, bash search commands) are blocked. Use raven_seek(query=\"...\") for ALL searches — local codebase, web, docs, and GitHub examples.\n</raven_guidance>`
        }
      }

      // ── Block search tools for non-Raven agents ──
      const isSearchTool = SEARCH_TOOLS.includes(input.tool)
      const isSearchBashCmd = isSearchBash(input.tool, output.args || input.args)

      if (isSearchTool || isSearchBashCmd) {
        throw new Error(REROUTE_MSG)
      }
    },

    "tool.execute.after"(input: any, output: any) {
      // Context saved is tracked in raven_seek instead
    },
  }
}) satisfies Plugin