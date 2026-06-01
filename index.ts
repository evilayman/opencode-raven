import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { homedir, tmpdir } from "node:os"

// ── Resolve paths relative to this package (works in node_modules/) ──
const PKG_DIR = import.meta.dirname!

const RAVEN_MD = join(PKG_DIR, "Raven.md")
const MCP_GUIDANCE_MD = join(PKG_DIR, "mcp-guidance.md")
const PACKAGE_JSON = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf-8"))
const PACKAGE_NAME = PACKAGE_JSON.name || "opencode-raven"
const PACKAGE_VERSION = PACKAGE_JSON.version || "0.0.0"

// ── Tools/MCPs that should be intercepted for non-Raven agents ──
const DEFAULT_ROUTE_TOOLS = [
  "grep",
  "glob",
  "webfetch",
  "fetch",
  "bash",
]

const DEFAULT_ROUTE_MCP_SERVERS = [
  "context7",
  "exa",
  "grep_app",
]

const DEFAULT_ROUTE_TOOL_KEYWORDS = [
  "search",
  "context7",
  "exa",
  "grep_app",
]

const DEFAULT_MCP_SERVERS: Record<string, string> = {
  context7: "https://mcp.context7.com/mcp",
  exa: "https://mcp.exa.ai/mcp",
  grep_app: "https://mcp.grep.app",
}

const NEVER_ROUTE_TOOLS = new Set(["raven_seek", "task", "subtask"])

// ── Bash commands that look like search workarounds ──
const SEARCH_BASH_RE = /\b(?:rg|ripgrep|grep|egrep|fgrep|git\s+grep|ack|ag\b|findstr|Select-String)\b|\b(?:Get-ChildItem|gci)\b(?=[^|;&\n]*(?:-Recurse|-Filter|-Include|\s-[A-Za-z]*r[A-Za-z]*\b))|\bdir\b(?=[^|;&\n]*(?:[/-][sS]\b|-Recurse|-Filter|-Include))|\bls\b(?=[^|;&\n]*(?:\s-[A-Za-z]*R[A-Za-z]*\b|--recursive\b))|\bfind\b\s+.*(?:-name|-type)\b/i

// Strip quoted content to avoid false positives (e.g. echo "use grep here")
function stripHeredocs(cmd: string): string {
  return cmd.replace(/<<-?\s*["']?(\w+)["']?[\s\S]*?\n\s*\1/g, "")
}

function stripShellComments(cmd: string): string {
  return cmd
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, "$1").trimEnd())
    .join("\n")
}

function stripQuotedContent(cmd: string): string {
  return stripShellComments(stripHeredocs(cmd)
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""'))
}

function splitPipelineSegments(cmd: string): string[] {
  const segments: string[] = []
  let current = ""
  for (let i = 0; i < cmd.length; i++) {
    const char = cmd[i]
    const prev = cmd[i - 1]
    const next = cmd[i + 1]
    if (char === "|" && prev !== "|" && next !== "|") {
      segments.push(current)
      current = ""
    } else {
      current += char
    }
  }
  segments.push(current)
  return segments
}

function isOutputFilterSegment(segment: string): boolean {
  return /^\s*(?:grep|ripgrep|rg|egrep|fgrep|findstr|Select-String|head|tail)\b/i.test(segment)
}

function hasSearchAfterCommandSeparator(segment: string): boolean {
  const separator = segment.search(/;|&&|\|\|/)
  return separator !== -1 && SEARCH_BASH_RE.test(segment.slice(separator))
}

function commandLooksLikeSearch(cmd: string): boolean {
  const lower = cmd.toLowerCase().trim()
  if (/^cmd\s+\/c\s+"?(?:findstr|find|tree)\b/.test(lower)) return true
  if (/^cmd\s+\/c\s+"?dir\b[^\n]*\s\/s\b/.test(lower)) return true

  return splitPipelineSegments(cmd).some((segment, index) => {
    // Allow bounded filters over output already produced by the previous command:
    //   pacman -Qi libarchive | head -15
    //   7z i | grep -i udf
    // These are not Raven-worthy filesystem/web/doc searches.
    if (index > 0 && isOutputFilterSegment(segment)) return hasSearchAfterCommandSeparator(segment)
    return SEARCH_BASH_RE.test(segment)
  })
}

function isSearchBash(tool: string, args: any): boolean {
  if (tool !== "bash") return false
  const raw = String(args?.command ?? "")
  const cmd = stripQuotedContent(raw)
  return commandLooksLikeSearch(cmd)
}

// ── Config file shape ──
interface RavenConfig {
  enabled: boolean
  model?: string
  reasoning_effort?: string
  ravenInstructions?: string
  routeTools?: string[]
  routeMcpServers?: string[]
  routeToolKeywords?: string[]
  allowBundledMCPServers?: boolean
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
  ravenInstructions: "",
  routeTools: DEFAULT_ROUTE_TOOLS,
  routeMcpServers: DEFAULT_ROUTE_MCP_SERVERS,
  routeToolKeywords: DEFAULT_ROUTE_TOOL_KEYWORDS,
  allowBundledMCPServers: true,
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
      } else if (/^\d+$/.test(value)) {
        value = parseInt(value, 10)
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

function uniqueStrings(value: unknown, fallback: string[] = []): string[] {
  const source = Array.isArray(value) ? value : fallback
  return [...new Set(source.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))]
}

// ── Plugin ──
export default ((input: PluginInput) => {
  const client = input.client

  // Config file lives in the global opencode config directory
  const configFile = join(homedir(), ".config", "opencode", "raven-config.json")

  function normalizeConfig(raw: any): RavenConfig {
    const source = raw && typeof raw === "object" ? raw : {}
    const normalized: RavenConfig = { ...DEFAULT_CONFIG, ...source }

    normalized.enabled = source.enabled !== false
    normalized.model = typeof source.model === "string" ? source.model : DEFAULT_CONFIG.model
    normalized.reasoning_effort = typeof source.reasoning_effort === "string" ? source.reasoning_effort : DEFAULT_CONFIG.reasoning_effort
    normalized.ravenInstructions = typeof source.ravenInstructions === "string" ? source.ravenInstructions : DEFAULT_CONFIG.ravenInstructions
    normalized.routeTools = uniqueStrings(source.routeTools, DEFAULT_ROUTE_TOOLS)
    normalized.routeMcpServers = uniqueStrings(source.routeMcpServers, DEFAULT_ROUTE_MCP_SERVERS)
    normalized.routeToolKeywords = uniqueStrings(source.routeToolKeywords, DEFAULT_ROUTE_TOOL_KEYWORDS)
    normalized.allowBundledMCPServers = source.allowBundledMCPServers !== false
    normalized.excludeAgents = uniqueStrings(source.excludeAgents)
    normalized.excludeTools = uniqueStrings(source.excludeTools)
    normalized.timeout = typeof source.timeout === "number" ? source.timeout : DEFAULT_CONFIG.timeout
    normalized.stats = source.stats || undefined

    return normalized
  }

  function loadConfig(): RavenConfig {
    try {
      if (existsSync(configFile)) {
        const raw = JSON.parse(readFileSync(configFile, "utf-8"))
        const normalized = normalizeConfig(raw)
        if (JSON.stringify(raw) !== JSON.stringify(normalized)) {
          saveConfig(normalized)
        }
        return normalized
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
  const ravenTaskCalls = new Set<string>()
  const sessionAgents = new Map<string, string>()
  const ravenSessionParents = new Map<string, string>()
  let updateInfo: { current: string; latest?: string; available: boolean } | undefined
  let updateCheckPromise: Promise<{ current: string; latest?: string; available: boolean }> | undefined
  let updateToastPending = false

  // ── Check if an agent is excluded from Raven enforcement (case-insensitive) ──
  function isExcluded(agent: string | undefined): boolean {
    if (!agent || !config.excludeAgents?.length) return false
    const lower = agent.toLowerCase()
    return config.excludeAgents.some((a) => a.toLowerCase() === lower)
  }

  function ravenGuidance(): string {
    const tools = config.routeTools?.length ? config.routeTools.join(", ") : "none"
    const mcps = config.routeMcpServers?.length ? config.routeMcpServers.map((server) => `${server}_*`).join(", ") : "none"
    const keywords = config.routeToolKeywords?.length ? config.routeToolKeywords.join(", ") : "none"
    return `Some tools/MCPs are routed through Raven to save context. Routed tools: ${tools}. Routed MCP prefixes: ${mcps}. Routed tool-name keywords: ${keywords}. If one is blocked, your next tool call should be raven_seek(query="<same request>"). Include the original tool/MCP name and relevant arguments.`
  }

  function isRouteConfigured(toolName: string): boolean {
    const tool = toolName.toLowerCase()
    if (NEVER_ROUTE_TOOLS.has(tool)) return false
    if (config.routeTools?.some((name) => name.toLowerCase() === tool)) return true
    if (config.routeToolKeywords?.some((keyword) => tool.includes(keyword.toLowerCase()))) return true
    return config.routeMcpServers?.some((server) => tool.startsWith(`${server.toLowerCase()}_`)) ?? false
  }

  function compactArgs(value: any): any {
    if (Array.isArray(value)) {
      return value.map(compactArgs).filter((item) => item !== undefined)
    }
    if (!value || typeof value !== "object") return value
    const result: Record<string, any> = {}
    for (const [key, raw] of Object.entries(value)) {
      const item = compactArgs(raw)
      if (item === undefined || item === null || item === "") continue
      if (Array.isArray(item) && item.length === 0) continue
      if (typeof item === "object" && !Array.isArray(item) && Object.keys(item).length === 0) continue
      result[key] = item
    }
    return result
  }

  function attemptedQuery(tool: string, args: any): string {
    const compact = compactArgs(args)
    if (!compact || typeof compact !== "object") return `${tool}: ${JSON.stringify(compact)}`
    const direct = compact.query ?? compact.pattern ?? compact.url ?? compact.urls ?? compact.command ?? compact.path ?? compact.filePath
    const value = direct !== undefined ? direct : compact
    const text = typeof value === "string" ? value : JSON.stringify(value)
    const query = value === compact ? `${tool} ${text}` : `${tool}: ${text}`
    return query.length > 300 ? `${query.slice(0, 297)}...` : query
  }

  function rerouteMessage(tool: string, args: any): string {
    return `The '${tool}' tool call is blocked by Raven. Your next tool call should be raven_seek(query="${attemptedQuery(tool, args).replace(/"/g, "'")}").`
  }

  function routeSummary(): string {
    const tools = config.routeTools?.length ? config.routeTools.join(", ") : "(none)"
    const mcps = config.routeMcpServers?.length ? config.routeMcpServers.join(", ") : "(none)"
    const keywords = config.routeToolKeywords?.length ? config.routeToolKeywords.join(", ") : "(none)"
    return `Raven routed tools/MCPs:\n  Tools: ${tools}\n  MCP servers: ${mcps}\n  Tool keywords: ${keywords}`
  }

  function mcpSummary(): string {
    return `Raven bundled MCPs: ${config.allowBundledMCPServers === false ? "disabled" : Object.keys(DEFAULT_MCP_SERVERS).join(", ")}`
  }

  function ravenAgentPrompt(): string {
    const extra = config.ravenInstructions?.trim()
    return extra ? `${ravenPrompt}\n\nAdditional user instructions:\n${extra}` : ravenPrompt
  }

  // ── Context saved by Raven delegation ──
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

  function compareVersions(a: string, b: string): number {
    const parse = (v: string) => v.replace(/^v/, "").split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0)
    const left = parse(a)
    const right = parse(b)
    const len = Math.max(left.length, right.length)
    for (let i = 0; i < len; i++) {
      const diff = (left[i] ?? 0) - (right[i] ?? 0)
      if (diff !== 0) return diff
    }
    return 0
  }

  async function fetchLatestVersion(): Promise<string | undefined> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    try {
      const res = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      })
      if (!res.ok) return undefined
      const data = await res.json() as { version?: string }
      return data.version
    } finally {
      clearTimeout(timeout)
    }
  }

  async function checkForUpdate(): Promise<{ current: string; latest?: string; available: boolean }> {
    const latest = await fetchLatestVersion()
    return { current: PACKAGE_VERSION, latest, available: !!latest && compareVersions(latest, PACKAGE_VERSION) > 0 }
  }

  async function countRavenSavedCandidateBytes(sessionId: string): Promise<number> {
    const messagesResp = await client.session.messages({ path: { id: sessionId }, query: { limit: 200 } })
    const messages = (messagesResp as any)?.data ?? []
    const assistantMessages = messages.filter((m: any) =>
      m?.info?.role === "assistant" && m?.info?.tokens?.output > 0
    )
    const first = assistantMessages[0]
    const last = assistantMessages[assistantMessages.length - 1]
    const t = last?.info?.tokens
    const firstTokens = first?.info?.tokens
    if (!t) return 0

    // Balanced estimate: total Raven context minus the first-turn prompt/schema/cache baseline.
    const totalTokens = (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
    const baselineTokens = firstTokens
      ? (firstTokens.input ?? 0) + (firstTokens.cache?.read ?? 0) + (firstTokens.cache?.write ?? 0)
      : 0
    const savedCandidateTokens = Math.max(0, totalTokens - baselineTokens)
    return savedCandidateTokens * 4
  }

  async function getUpdateInfo(): Promise<{ current: string; latest?: string; available: boolean }> {
    if (updateInfo) return updateInfo
    if (!updateCheckPromise) {
      updateCheckPromise = checkForUpdate()
        .then((info) => {
          updateInfo = info
          return info
        })
        .catch((err) => {
          updateCheckPromise = undefined
          throw err
        })
    }
    return updateCheckPromise
  }

  async function refreshUpdateInfo(): Promise<{ current: string; latest?: string; available: boolean }> {
    updateInfo = undefined
    updateCheckPromise = checkForUpdate()
      .then((info) => {
        updateInfo = info
        return info
      })
      .catch((err) => {
        updateCheckPromise = undefined
        throw err
      })
    return updateCheckPromise
  }

  function clearPluginCache(): string[] {
    const packagesDir = join(homedir(), ".cache", "opencode", "packages")
    if (!existsSync(packagesDir)) return []

    const removed: string[] = []
    for (const entry of readdirSync(packagesDir)) {
      if (entry !== PACKAGE_NAME && !entry.startsWith(`${PACKAGE_NAME}@`)) continue
      const target = join(packagesDir, entry)
      rmSync(target, { recursive: true, force: true })
      removed.push(target)
    }
    return removed
  }

  function manualUpdateText(latest = "latest"): string {
    return `Restart opencode to load the update.\n\nManual alternatives:\n  bun update --latest ${PACKAGE_NAME}\n  npm install ${PACKAGE_NAME}@${latest}\n\nIf opencode still loads the old version, clear its plugin cache and restart:\n  PowerShell: Remove-Item -Recurse -Force "$HOME\\.cache\\opencode\\packages\\${PACKAGE_NAME}*"\n  macOS/Linux: rm -rf ~/.cache/opencode/packages/${PACKAGE_NAME}*`
  }

  async function notifyIfUpdateAvailable() {
    try {
      const info = await getUpdateInfo()
      if (!info.available || !info.latest) return
      await (client as any).tui?.showToast?.({
        body: {
          title: "Raven update available",
          message: `${PACKAGE_NAME} ${info.current} → ${info.latest}. Run /raven update, then restart opencode.`,
          variant: "info",
          duration: 10000,
        },
      })
    } catch { /* update checks are best-effort */ }
  }

  function ensureRemoteMcp(configInput: any, key: string, url: string) {
    const existing = configInput.mcp?.[key] && typeof configInput.mcp[key] === "object"
      ? configInput.mcp[key]
      : {}
    const type = existing.type ?? "remote"
    configInput.mcp[key] = {
      ...existing,
      type,
      ...(type === "local" ? {} : { url: existing.url ?? url }),
      enabled: existing.enabled ?? true,
    }
  }

  return {
    config(configInput: any) {
      // Bundled MCP defaults. Existing opencode.jsonc entries are merged, not overwritten.
      if (config.allowBundledMCPServers !== false) {
        configInput.mcp = configInput.mcp || {}
        for (const [key, url] of Object.entries(DEFAULT_MCP_SERVERS)) {
          ensureRemoteMcp(configInput, key, url)
        }
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
        prompt: ravenAgentPrompt(),
      }

      // Register /raven command
      configInput.command = configInput.command || {}
      if (!configInput.command.raven) {
        configInput.command.raven = {
          template: "Manage Raven: /raven on|off|route|update|model <name>|status",
          description: "Toggle Raven routing, manage routed tools/MCPs, or change Raven's model",
        }
      }

      updateToastPending = true
    },

    // Register raven_seek tool — lets agents with task:false still delegate through Raven
    tool: {
      "raven_seek": tool({
        description: "Unified Raven delegation tool. Use this whenever a tool/MCP is blocked by Raven, or when grep, glob, WebFetch/fetch, websearch, docs lookup, GitHub search, or search-like bash would be used. Handles routed MCP requests, local codebase search, filesystem discovery, specific URL/page reads, web/docs research, GitHub examples, and command-output/system inspection via Raven.",
        args: {
          query: tool.schema.string().describe("What Raven should do. Include the original blocked tool/MCP request and relevant args, exact URLs when replacing WebFetch, and commands/output checks when replacing grep/rg/head over command output."),
        },
        async execute(args, context) {
          const started = Date.now()
          const timeout = (config.timeout ?? 180) * 1000
          try {
            // Create a Raven session
            const session = await client.session.create({
              body: {
                parentID: context.sessionID,
                title: `raven_seek: ${args.query.slice(0, 80)}`,
              },
            })

            const sessionId = (session as any)?.data?.id ?? (session as any)?.id
            if (!sessionId) {
              return { title: "Raven Seek", output: "Failed to create Raven session." }
            }

            ravenSessions.add(sessionId)

            // Emit sessionId so the TUI renders a clickable delegation box
            context.metadata({ metadata: { sessionId } })

            // Log session for debugging
            try {
              const logFile = join(tmpdir(), "raven-sessions.log")
              const ts = new Date().toISOString()
              const q = String(args.query).slice(0, 100)
              appendFileSync(logFile, `${ts} ${sessionId} "${q}"\n`)
            } catch { /* non-fatal */ }

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

            // Context saved = Raven output/reasoning/cache context - compact answer returned to main session.
            let savedCandidate = 0
            try {
              savedCandidate = await countRavenSavedCandidateBytes(sessionId)
            } catch { /* best-effort */ }
            if (savedCandidate <= 0) {
              for (const part of parts) {
                if (part.args) savedCandidate += JSON.stringify(part.args).length
                if (part.content) savedCandidate += typeof part.content === "string" ? part.content.length : JSON.stringify(part.content).length
              }
            }
            const saved = Math.max(0, savedCandidate - output.length)
            addBytes(saved)

            return { title: "Raven Seek", metadata: { sessionId }, output: `${output}\n\n*Raven searched for ${elapsed}s — ${formatBytes(savedCandidate)} handled, ${formatTokens(savedCandidate)} tokens*` }
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

    event(input: { event: any }) {
      // Track subagent session → parent mapping for accurate context counting
      const evt = input.event
      if (evt?.type === "session.created" && evt?.properties?.parentID) {
        ravenSessionParents.set(evt.properties.parentID, evt.properties.id)
      }

      if (!updateToastPending) return
      updateToastPending = false
      setTimeout(() => void notifyIfUpdateAvailable(), 500)
    },

    // /raven on|off|route|model <name>|effort <value>|timeout <seconds>|stats|status
    async "command.execute.before"(input: any, output: any) {
      if (input.command !== "raven") return
      output.parts.length = 0
      const raw = input.arguments.trim()
      const arg = raw.toLowerCase()

      if (arg === "on") {
        config.enabled = true
        saveConfig(config)
        output.parts.push({ type: "text", text: "Raven tool/MCP routing enabled. Non-Raven agents will be redirected to raven_seek for configured tools." })
      } else if (arg === "off") {
        config.enabled = false
        saveConfig(config)
        output.parts.push({ type: "text", text: "Raven tool/MCP routing disabled. All agents can use tools directly." })
      } else if (arg === "stats") {
        output.parts.push({ type: "text", text: `Raven context saved:\n  This session: ${formatBytes(sessionBytes)} (~${formatTokens(sessionBytes)} context)\n  All time: ${formatBytes(totalBytes)} (~${formatTokens(totalBytes)} context)` })
      } else if (arg === "route") {
        output.parts.push({ type: "text", text: `${routeSummary()}\n\nUsage:\n  /raven route tool add <tool_name>\n  /raven route tool remove <tool_name>\n  /raven route mcp add <server_name>\n  /raven route mcp remove <server_name>\n  /raven route keyword add <keyword>\n  /raven route keyword remove <keyword>` })
      } else if (arg.startsWith("route ")) {
        const parts = raw.split(/\s+/)
        const kind = parts[1]?.toLowerCase()
        const action = parts[2]?.toLowerCase()
        const name = parts.slice(3).join(" ").trim()
        const key = kind === "tool" ? "routeTools" : kind === "mcp" || kind === "server" ? "routeMcpServers" : kind === "keyword" ? "routeToolKeywords" : undefined

        if (!key || !["add", "remove", "rm"].includes(action) || !name) {
          output.parts.push({ type: "text", text: "Usage:\n  /raven route tool add <tool_name>\n  /raven route tool remove <tool_name>\n  /raven route mcp add <server_name>\n  /raven route mcp remove <server_name>\n  /raven route keyword add <keyword>\n  /raven route keyword remove <keyword>" })
        } else {
          const values = uniqueStrings(config[key])
          const exists = values.some((value) => value.toLowerCase() === name.toLowerCase())
          config[key] = action === "add"
            ? exists ? values : [...values, name]
            : values.filter((value) => value.toLowerCase() !== name.toLowerCase())
          saveConfig(config)
          output.parts.push({ type: "text", text: routeSummary() })
        }
      } else if (arg === "update") {
        try {
          const info = await refreshUpdateInfo()
          if (!info.latest) {
            output.parts.push({ type: "text", text: `Could not check npm for ${PACKAGE_NAME}. Try again later.\n\n${manualUpdateText()}` })
          } else if (!info.available) {
            output.parts.push({ type: "text", text: `Raven is up to date (${info.current}). Latest on npm: ${info.latest}.` })
          } else {
            const removed = clearPluginCache()
            output.parts.push({ type: "text", text: `Raven update available: ${info.current} → ${info.latest}.\n\nCleared ${removed.length} opencode plugin cache entr${removed.length === 1 ? "y" : "ies"}. ${manualUpdateText(info.latest)}` })
          }
        } catch (err: any) {
          output.parts.push({ type: "text", text: `Raven update check failed: ${err?.message ?? err}\n\n${manualUpdateText()}` })
        }
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
        let update = "Update: unable to check npm."
        try {
          const info = await getUpdateInfo()
          update = info.available && info.latest
            ? `Update: ${info.latest} available. Run /raven update, then restart opencode.`
            : `Update: up to date${info.latest ? ` (latest ${info.latest})` : ""}.`
        } catch { /* keep fallback */ }
        output.parts.push({ type: "text", text: `Raven is ${enabled}. Version: ${PACKAGE_VERSION}. Model: ${model}. Reasoning: ${effort}. Timeout: ${timeout}s\n${update}\n\n${routeSummary()}\n\n${mcpSummary()}\n\nRaven context saved:\n  This session: ${formatBytes(sessionBytes)} (~${formatTokens(sessionBytes)} context)\n  All time: ${formatBytes(totalBytes)} (~${formatTokens(totalBytes)} context)\n\nCommands:\n  /raven on      — enable tool/MCP routing\n  /raven off     — disable tool/MCP routing\n  /raven route   — show or edit routed tools/MCP servers/keywords\n  /raven update  — check npm, clear plugin cache if newer, then restart opencode\n  /raven model <name> — change Raven's model (requires restart)\n  /raven effort <value> — change Raven's reasoning effort (requires restart)\n  /raven timeout <seconds> — change raven_seek timeout\n  /raven stats   — show context saved` })
      }
    },

    "tool.execute.before"(input: any, output: any) {
      if (input.tool === "raven_seek" && (ravenSessions.has(input.sessionID) || sessionAgents.get(input.sessionID) === "raven")) {
        throw new Error("raven_seek is disabled inside Raven. Use Raven's direct search/fetch tools instead.")
      }

      if (!config.enabled) return
      if (ravenSessions.has(input.sessionID)) return
      if (isExcluded(sessionAgents.get(input.sessionID))) return
      if (config.excludeTools?.some((name) => name.toLowerCase() === input.tool.toLowerCase())) return

      // ── Subagent prompt injection: inject Raven guidance into every subagent ──
      if ((input.tool === "task" || input.tool === "subtask") && output.args) {
        const subagentType = input.tool === "task" ? (output.args.subagent_type ?? "") : ""
        if (subagentType === "raven") {
          ravenTaskCalls.add(input.callID)
        }
        if (subagentType !== "raven" && !isExcluded(subagentType)) {
          const field = ["prompt", "description", "request", "objective", "query"].find(
            (f) => f in output.args
          ) ?? "prompt"
          output.args[field] = `${output.args[field] ?? ""}\n\n<raven_guidance>\n${ravenGuidance()}\n</raven_guidance>`
        }
      }

      // ── Block routed tools/MCPs for non-Raven agents ──
      const shouldRouteTool = input.tool === "bash" ? false : isRouteConfigured(input.tool)
      const isSearchBashCmd = isRouteConfigured("bash") && isSearchBash(input.tool, output.args || input.args)

      if (shouldRouteTool || isSearchBashCmd) {
        const args = compactArgs(output.args || input.args)
        if (output.args && typeof output.args === "object") output.args = args
        throw new Error(rerouteMessage(input.tool, args))
      }
    },

    "tool.execute.after"(input: any, output: any) {
      if (ravenTaskCalls.has(input.callID)) {
        ravenTaskCalls.delete(input.callID)
        // Try task metadata first (built-in tools preserve metadata)
        const ravenSessionId = output.metadata?.sessionId ?? ravenSessionParents.get(input.sessionID)
        if (ravenSessionId) {
          if (ravenSessionParents.has(input.sessionID)) ravenSessionParents.delete(input.sessionID)
          void countRavenSavedCandidateBytes(ravenSessionId)
            .then((total) => {
              const saved = Math.max(0, total - String(output.output ?? "").length)
              if (saved > 0) addBytes(saved)
            })
            .catch(() => {
              // Without token metadata we cannot separate saved context from the compact answer.
            })
        }
      }
    },
  }
}) satisfies Plugin
