# opencode-raven

<table>
<tr>
<td><img src="Raven.png" alt="Raven" width="768" /></td>
<td>
<strong>Context firewall for <a href="https://opencode.ai">OpenCode</a></strong><br/>
Raven routes noisy search, docs, web, GitHub, and MCP calls through a free focused agent before they hit your main model, saving cost and context.
</td>
</tr>
</table>

## Why?

Tool-heavy work floods context. Search, docs, web, GitHub examples, and verbose MCP calls can dump raw results into your expensive main model. Raven is a hard blocker-rerouter: configured tools fail closed for non-Raven agents and must be delegated through `raven_seek`, where a focused Raven agent performs the work and returns a compact answer.

Raven fixes three problems:

1. **Context flooding** — Keep noisy tool results out of the main session. Raven summarizes tool/MCP output before returning it.
2. **Cost** — Use a cheaper model like `opencode/deepseek-v4-flash-free` for tool-heavy work while saving your main model's context for decisions and edits.
3. **Enforcement** — This is not soft nudging. Raven blocks configured tools/MCP prefixes for non-Raven agents and gives them the exact `raven_seek` retry path.

Raven defaults to search/fetch/docs/GitHub routing, but it works with any MCP whose opencode tool names share a prefix.

Important limitation: opencode still loads enabled MCP tool schemas into the main session. Raven saves context from tool calls and raw results, but it cannot hide initial MCP schemas from the main model until opencode supports agent-scoped MCP visibility.

## Example

<p align="center">
  <img src="example.gif" alt="Raven example: searching today's top 30 AI news items while saving 71K context" />
</p>

In this example, the main model asks for the top 30 AI news items from today. Raven handles the noisy search/web work in a focused agent and returns the compact result, saving about 71K context that would otherwise have landed in the main session.

## Install

Add Raven to your `opencode.jsonc` plugins:

```jsonc
{
  "plugin": ["opencode-raven"]
}
```

Restart opencode. It will resolve Raven from npm and cache the plugin automatically.

## Commands

| Command | Action |
|---------|--------|
| `/raven` | Show status — enabled/disabled, version, update availability, model, routing, reasoning effort, timeout (no args) |
| `/raven on` | Enable hard tool/MCP routing (default) |
| `/raven off` | Disable routing — all agents can use routed tools directly |
| `/raven route` | Show routed tools and MCP server prefixes |
| `/raven route tool add <name>` | Route a specific tool through Raven |
| `/raven route tool remove <name>` | Stop routing a specific tool |
| `/raven route mcp add <server>` | Route every tool whose name starts with `<server>_` through Raven |
| `/raven route mcp remove <server>` | Stop routing an MCP server prefix |
| `/raven route keyword add <keyword>` | Route any tool whose name contains `<keyword>` |
| `/raven route keyword remove <keyword>` | Stop routing a tool-name keyword |
| `/raven update` | Check npm for a newer Raven, clear opencode's plugin cache if needed, then restart opencode |
| `/raven model <name>` | Change Raven's model (requires restart) |
| `/raven effort <value>` | Change Raven's reasoning effort (requires restart) |
| `/raven timeout <seconds>` | Change raven_seek timeout (min 10s, takes effect immediately) |
| `/raven stats` | Show estimated context saved (session + all-time, bytes + tokens) |

Config persists across restarts in `~/.config/opencode/raven-config.json` (global, shared across all projects). Auto-created on first run.

## Updates

opencode caches npm plugins, so `"opencode-raven"` / `"opencode-raven@latest"` may not automatically refresh after a new npm release.

Raven checks npm after the TUI starts. If an update is available, it shows a notification. `/raven` also shows the current version and update availability. To update:

```txt
/raven update
```

This checks npm, clears Raven's opencode plugin cache when a newer version exists, and tells you to restart opencode.

Manual alternatives:

```bash
bun update --latest opencode-raven
# or
npm install opencode-raven@latest
```

If opencode still loads the old cached plugin, clear the opencode plugin cache and restart:

```powershell
Remove-Item -Recurse -Force "$HOME\.cache\opencode\packages\opencode-raven*"
```

```bash
rm -rf ~/.cache/opencode/packages/opencode-raven*
```

## Direct access

You can call Raven directly with `@Raven` in any opencode chat. The Raven agent runs with full filesystem and MCP access — no permission prompts.

## raven_seek

When configured tools/MCPs are blocked, agents use **`raven_seek`** — a unified delegation tool that sends the request to Raven. It handles routed MCP requests, local codebase search, filesystem discovery, specific URL/page reads, web/docs research, GitHub examples, and command-output/system inspection. Output includes elapsed time and tokens processed.

```
raven_seek(query: "how to use useEffect cleanup")
raven_seek(query: "Fetch/read https://example.com and summarize install steps")
raven_seek(query: "Check whether archivemount/libarchive supports ISO or UDF. Use docs, web, or command output as needed.")
```

The main agent doesn't see Raven's internal tool calls or raw tool output — just the final findings. Raven parallelizes independent tool calls internally within a single session.

## Configuration

### raven-config.json

Located at `~/.config/opencode/raven-config.json`. Auto-created on first run and auto-migrated on startup when new config fields are added. Default route lists are only applied when the field is missing, so removed tools/MCP prefixes stay removed. Edit manually or use `/raven` commands:

```json
{
  "enabled": true,
  "model": "opencode/deepseek-v4-flash-free",
  "reasoning_effort": "low",
  "ravenInstructions": "",
  "routeTools": ["grep", "glob", "webfetch", "fetch", "bash"],
  "routeMcpServers": ["context7", "exa", "grep_app"],
  "routeToolKeywords": ["search", "context7", "exa", "grep_app"],
  "allowBundledMCPServers": true,
  "excludeAgents": [],
  "excludeTools": [],
  "timeout": 180
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Whether tool/MCP routing is active |
| `model` | *(from Raven.md)* | Override Raven's model without editing package files |
| `reasoning_effort` | *(from Raven.md)* | Override Raven's reasoning effort (e.g. `"low"`, `"medium"`, `"high"`) |
| `ravenInstructions` | `""` | Extra instructions appended to Raven's prompt. Useful for custom MCP usage rules. |
| `routeTools` | built-in search/fetch tools plus `bash` | Exact tool names hard-routed through Raven. `bash` means route only search-like bash commands, not every bash call. e.g. `["grep", "glob", "bash", "linear_search_issues"]` |
| `routeMcpServers` | `["context7", "exa", "grep_app"]` | MCP server prefixes hard-routed through Raven. `"linear"` routes tools like `linear_search_issues` and `linear_get_issue` |
| `routeToolKeywords` | `["search", "context7", "exa", "grep_app"]` | Case-insensitive substrings hard-routed through Raven. Catches suffix-style names like `web_search_exa`. |
| `allowBundledMCPServers` | `true` | Whether Raven auto-registers bundled Context7, Exa, and Grep.app MCP defaults. Existing `opencode.jsonc` MCP entries are never overwritten. |
| `excludeAgents` | `[]` | Agents that bypass Raven routing (case-insensitive). e.g. `["librarian", "explorer"]` |
| `excludeTools` | `[]` | Exact tools that never get blocked, even if matched by `routeMcpServers`. e.g. `["my_mcp_validate"]` |
| `timeout` | `180` | Max seconds for a `raven_seek` call. On timeout the session is kept for inspection. |
| `stats` | *(auto)* | Session + global estimated context saved by Raven (bytes + tokens). Managed automatically. |

### MCP servers

All three MCPs work without API keys. Add keys for higher rate limits:

| MCP | URL | API key |
|-----|-----|---------|
| Context7 | `https://mcp.context7.com/mcp` | Free key at [context7.com/dashboard](https://context7.com/dashboard) — higher limits |
| Exa AI | `https://mcp.exa.ai/mcp` | Free key at [exa.ai](https://exa.ai) — higher limits |
| Grep.app | `https://mcp.grep.app` | Not available — public API, no key needed |

When `allowBundledMCPServers` is `true`, Raven auto-registers bundled Context7, Exa, and Grep.app MCP defaults. It merges those MCP defaults with your existing `opencode.jsonc` settings, preserving custom headers, URLs, and `enabled: false` overrides. Set `allowBundledMCPServers` to `false` if you do not want Raven to add bundled MCP defaults.

To add other MCPs, configure them in `opencode.jsonc`, then add their server prefix to `routeMcpServers` if you want Raven to route them. Raven does not install arbitrary MCPs from `raven-config.json`.

Use `ravenInstructions` for extra Raven-only guidance, such as how to use custom MCPs:

```json
{
  "ravenInstructions": "For Linear requests, prefer assigned open issues and include issue keys in the answer."
}
```

To add an API key, override the MCP in your `opencode.jsonc` with a `headers` field:

```jsonc
{
  "mcp": {
    "exa": {
      "type": "remote",
      "url": "https://mcp.exa.ai/mcp",
      "headers": { "x-api-key": "{env:EXA_API_KEY}" },
      "enabled": true
    }
  }
}
```

To disable an MCP entirely:

```jsonc
{
  "mcp": {
    "exa": { "type": "remote", "url": "https://mcp.exa.ai/mcp", "enabled": false }
  }
}
```

## How it works

| Hook | What it does |
|------|--------------|
| `config` | Registers Raven agent, optionally merges bundled Context7/Exa/Grep.app MCP defaults, loads MCP routing guidance |
| `tool` | Registers `raven_seek` — creates Raven sessions with timeout, error recovery, timing, and session tree visibility. Tracks context saved for stats (both `raven_seek` and direct `@Raven`). |
| `chat.message` | Tracks agent ↔ session mapping for allowlist and Raven exclusion |
| `event` | Shows startup update notifications after the TUI event stream is ready |
| `command.execute.before` | Handles `/raven on\|off\|route\|update\|model\|effort\|timeout\|stats\|status` |
| `tool.execute.before` | Hard-blocks configured tools/MCPs for non-Raven, non-excluded agents (respects `excludeTools`). Error output gives the next `raven_seek(query="...")` call. Injects dynamic `<raven_guidance>` with configured routes into subagent prompts. |
| `tool.execute.after` | Tracks direct `@Raven` calls for context-saved stats. |

### Routed tools (blocked and redirected except for Raven and any agents in `excludeAgents`)

By default, Raven routes these built-in tools and MCP server prefixes:

| Config | Default |
|------|--------|
| `routeTools` | `grep`, `glob`, `webfetch`, `fetch`, `bash` |
| `routeMcpServers` | `context7`, `exa`, `grep_app` |
| `routeToolKeywords` | `search`, `context7`, `exa`, `grep_app` |

To route another MCP, add its server prefix. For example, `"linear"` routes every tool named `linear_*` through Raven:

```txt
/raven route mcp add linear
```

This works for any MCP whose opencode tool names share a prefix. For example, if an MCP exposes tools named `my_mcp_search`, `my_mcp_fetch`, and `my_mcp_get_item`, this routes all of them:

```txt
/raven route mcp add my_mcp
```

The prefix must match the actual tool name before `_`. If the tools are named `project_search`, add `project`, not the display name of the MCP. Matching is case-insensitive.

If a server uses suffix-style or mixed tool names, route by keyword instead. For example, `exa` catches names like `web_search_exa` and `web_fetch_exa`:

```txt
/raven route keyword add exa
```

Keyword matching is case-insensitive and checks whether the tool name contains the keyword anywhere.

If an MCP is routed but one tool should remain direct, add the exact tool to `excludeTools`:

```json
{
  "routeMcpServers": ["context7", "exa", "grep_app", "my_mcp"],
  "excludeTools": ["my_mcp_validate"]
}
```

To route one specific tool without routing the whole MCP server:

```txt
/raven route tool add linear_search_issues
```

**Bash commands** — intercepted only while `bash` is included in `routeTools` and the command matches a primary search/discovery pattern:

| Pattern | Examples |
|---------|----------|
| Content search | `rg`, `grep`, `egrep`, `fgrep`, `git grep`, `ack`, `ag`, `findstr`, `Select-String` |
| Filesystem exploration | `Get-ChildItem -Recurse`, `gci -Recurse`, `Get-ChildItem -Filter`, `find -name`, `find -type`, `ls -R`, `ls --recursive`, `dir /s` |
| Shell bypass | `cmd /c dir /s`, `cmd /c findstr`, `cmd /c find`, `cmd /c tree` |

**Unrestricted for non-Raven agents**: `read`, `task`, `subtask`, `raven_seek`, non-routed tools, and non-search `bash` commands.

**Allowed output filters**: Piped filters like `command | grep ...`, `command | rg ...`, `command | findstr ...`, and `command | head ...` are allowed. Raven only blocks search commands when they are used as primary discovery commands, not when they filter bounded output from another command.

To stop routing search-like bash commands, remove `bash` from `routeTools`:

```txt
/raven route tool remove bash
```

**Bash quote stripping**: Quoted content in bash commands is stripped before pattern matching — `echo "use grep here"` won't falsely trigger blocking.

**Comment stripping**: Shell comments are stripped before matching — `# use grep later` won't falsely trigger blocking.

**Subagent guidance**: Every non-Raven, non-excluded subagent gets `<raven_guidance>` injected into its prompt at spawn time.

The injected guidance includes the current `routeTools` and `routeMcpServers`, including user-added custom MCP prefixes, so subagents know which calls must go through `raven_seek`.

### What Raven Saves

Raven saves context from tool call results and raw MCP output by moving the work into a Raven session and returning a compact answer. It does not currently save context from MCP tool schemas that opencode loads into the main session when an MCP is enabled globally.

This means large MCPs may still increase the main session's starting context. Raven still prevents repeated verbose tool outputs from accumulating in the main session.

`/raven stats` uses a balanced estimate: Raven's final session token total minus the first Raven assistant turn's input/cache baseline, then minus the compact answer returned to the main session. This counts tool/web/MCP result context Raven handled while avoiding Raven's starting prompt and tool-schema overhead.

## Agent capabilities

Raven itself has access to these tools (blocked for other agents when configured by the plugin):

| Tool / MCP | Purpose |
|------------|---------|
| `read`, `glob`, `grep`, `list` | Local codebase inspection |
| `bash` (all commands) | Full local shell access (`rg`, `grep`, `dir`, `ls`, `Get-ChildItem`, `find`, etc.) |
| `external_directory` | Allowed — no permission prompts when accessing paths outside the workspace |
| Context7 | Library/framework/SDK/API docs |
| Exa AI | Web search, news, pages, products |
| Grep.app | Public GitHub examples |

`raven_seek` is denied inside Raven itself so Raven cannot recursively call its own wrapper tool. Raven uses direct tools/MCPs instead.

Raven returns compact findings: answer, sources, relevant details, recommended next step, and uncertainty.

## License

MIT
