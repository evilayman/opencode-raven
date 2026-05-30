import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"

// ── Resolve paths relative to this package (works in node_modules/) ──
const PKG_DIR = import.meta.dirname!

const RAVEN_MD = join(PKG_DIR, "Raven.md")
const MCP_GUIDANCE_MD = join(PKG_DIR, "mcp-guidance.md")

// ── Search tools that should be intercepted for non-Raven agents ──
const SEARCH_TOOLS = [
  // Built-in tools
  "grep",
  "glob",
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
const SEARCH_BASH_RE = /\b(rg|ripgrep|grep|egrep|fgrep|git\s+grep|ack|ag\b|findstr|Select-String|Get-ChildItem|gci\b|dir\b\s+[/-][sS]|ls\b\s+-[rR]|find\b\s+.*-name|find\b\s+.*-type)\b/

function isSearchBash(tool: string, args: any): boolean {
  if (tool !== "bash") return false
  const cmd = String(args?.command ?? "")
  const desc = String(args?.description ?? "")
  return SEARCH_BASH_RE.test(cmd) || SEARCH_BASH_RE.test(desc)
}

// ── Config file shape ──
interface RavenConfig {
  enabled: boolean
  model?: string
}

const DEFAULT_CONFIG: RavenConfig = { enabled: true }

// ── Parse Raven.md frontmatter ──
const ravenMd = readFileSync(RAVEN_MD, "utf-8")
const { frontmatter: fm, prompt: ravenPrompt } = parseRavenMd(ravenMd)

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

  // Config file lives in the project directory (next to opencode.jsonc)
  const configFile = join(input.directory, "raven-config.json")

  function loadConfig(): RavenConfig {
    try {
      if (existsSync(configFile)) {
        const raw = JSON.parse(readFileSync(configFile, "utf-8"))
        return {
          enabled: raw.enabled !== false,
          model: raw.model,
        }
      }
    } catch { /* ignore corruption, use defaults */ }
    return { ...DEFAULT_CONFIG }
  }

  function saveConfig(config: RavenConfig) {
    try {
      writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n")
    } catch { /* non-fatal: config won't persist but toggle still works in-session */ }
  }

  let config = loadConfig()
  const ravenSessions = new Set<string>()

  // Throttle: show the full error message once per session, then silent
  const throttledSessions = new Set<string>()
  const REROUTE_MSG = "Search tools are blocked. Use raven_seek(query=\"...\") to search through Raven."

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
        options: extractOptions(fm),
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
        description: "Fallback search tool — use only when task delegation to Raven (subagent_type=\"raven\") is unavailable. Raven has access to Context7, Exa AI, and Grep.app for web search, docs lookup, and GitHub examples.",
        args: {
          query: tool.schema.string().describe("What to search for — be specific about what you need (docs, code examples, web info, etc.)"),
        },
        async execute(args, context) {
          try {
            // Create a Raven session
            const session = await client.session.create({
              body: { title: `raven_seek: ${args.query.slice(0, 80)}` },
            })

            const sessionId = (session as any)?.data?.id ?? (session as any)?.id
            if (!sessionId) {
              return { title: "Raven Seek", output: "Failed to create Raven session." }
            }

            // Send the query to Raven
            const result = await client.session.prompt({
              path: { id: sessionId },
              body: {
                agent: "raven",
                parts: [{ type: "text", text: args.query }],
              },
            })

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

            return { title: "Raven Seek", output }
          } catch (err: any) {
            return { title: "Raven Seek", output: `Raven search failed: ${err.message || err}` }
          }
        },
      }),
    },

    // Track Raven sessions so we don't block its own tools
    "chat.message"(input: any, _output: any) {
      if (input.agent === "raven") {
        ravenSessions.add(input.sessionID)
      }
    },

    // /raven on|off|model <name>|status
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
      } else if (arg.startsWith("model ")) {
        const model = raw.slice(6).trim()
        if (!model) {
          output.parts.push({ type: "text", text: `Usage: /raven model <name>\nCurrent model: ${config.model || fm.model || "(default)"}` })
        } else {
          config.model = model
          saveConfig(config)
          output.parts.push({ type: "text", text: `Raven model set to: ${model}\nRestart opencode for the change to take effect.` })
        }
      } else {
        const enabled = config.enabled ? "enabled" : "disabled"
        const model = config.model || fm.model || "(default)"
        output.parts.push({ type: "text", text: `Raven is ${enabled}. Model: ${model}\n\nCommands:\n  /raven on      — enable search interception\n  /raven off     — disable search interception\n  /raven model <name> — change Raven's model (requires restart)` })
      }
    },

    "tool.execute.before"(input: any, output: any) {
      if (!config.enabled) return
      if (ravenSessions.has(input.sessionID)) return

      // ── Subagent prompt injection: inject Raven guidance into every subagent ──
      if ((input.tool === "task" || input.tool === "subtask") && output.args) {
        const subagentType = input.tool === "task" ? (output.args.subagent_type ?? "") : ""
        if (subagentType !== "raven") {
          const field = ["prompt", "description", "request", "objective", "query"].find(
            (f) => f in output.args
          ) ?? "prompt"
          output.args[field] = `${output.args[field] ?? ""}\n\n<raven_guidance>\nSearch tools (grep, glob, Context7, Exa, Grep.app, bash search) are blocked. Use raven_seek(query="...") to search through Raven.\n</raven_guidance>`
        }
      }

      // ── Block search tools for non-Raven agents ──
      const isSearchTool = SEARCH_TOOLS.includes(input.tool)
      const isSearchBashCmd = isSearchBash(input.tool, output.args || input.args)

      if (isSearchTool || isSearchBashCmd) {
        if (throttledSessions.has(input.sessionID)) {
          throw new Error("")
        }
        throttledSessions.add(input.sessionID)
        throw new Error(REROUTE_MSG)
      }
    },

    "tool.execute.after"(input: any, output: any) {
      // Reserved for future analytics / redirect tracking (#5)
    },
  }
}) satisfies Plugin