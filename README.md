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

## What Raven Does

Tool-heavy work floods context. Search, docs, web, GitHub examples, and verbose MCP calls can dump raw results into your expensive main model. Raven is a hard blocker-rerouter: configured tools fail closed for non-Raven agents and must be delegated through `raven_seek`, where a focused Raven agent performs the work and returns a compact answer.

Raven fixes three problems:

1. **Context flooding** - Keep noisy tool results out of the main session. Raven summarizes tool/MCP output before returning it.
2. **Cost** - Use a cheaper model like `opencode/deepseek-v4-flash-free` for tool-heavy work while saving your main model's context for decisions and edits.
3. **Enforcement** - This is not soft nudging. Raven blocks configured tools/MCP prefixes for non-Raven agents and gives them the exact `raven_seek` retry path.

Raven defaults to routing noisy search/fetch tools and bundles Context7, Exa, and Grep.app as on-demand MCPs that are always handled behind Raven.

Important limitation: MCPs enabled directly in OpenCode config still load their tool schemas into the main session. Raven saves context from tool calls and raw results for those global MCPs, but schema hiding requires putting the MCP in Raven's `onDemandMcpServers`. **Strongly recommended:** configure noisy/search/docs/web MCPs as on-demand MCPs unless you need direct main-agent access.

## Install

Add Raven to your `opencode.jsonc` plugins:

```jsonc
{
  "plugin": ["opencode-raven"]
}
```

Restart opencode. It will resolve Raven from npm and cache the plugin automatically.

Raven checks for package updates and notifies you when a newer version is available. Run `/raven update`, then restart opencode.

## Quick Use

Run `/raven` to see status, routed tools, on-demand MCP health, and saved context.

When a configured tool or MCP is blocked, agents use `raven_seek` to delegate the same request through Raven:

```txt
raven_seek(query: "how to use useEffect cleanup")
raven_seek(query: "Fetch/read https://example.com and summarize install steps")
raven_seek(query: "Check whether archivemount/libarchive supports ISO or UDF. Use docs, web, or command output as needed.")
```

You can call Raven directly with `@Raven` in any OpenCode chat. The Raven agent runs with full filesystem and MCP access, without permission prompts.

The main agent does not see Raven's internal tool calls or raw tool output, just the final findings. Raven parallelizes independent tool calls internally within a single session.

## Commands

| Command | Action |
|---------|--------|
| `/raven` | Show status, version, model, routing, on-demand MCP health, stats, reasoning effort, and timeout |
| `/raven help` | Show all Raven commands |
| `/raven on` | Enable hard tool/MCP routing |
| `/raven off` | Disable routing so all agents can use routed tools directly |
| `/raven route` | Show routed tools, auto-routed global MCP prefixes, and routed tool keywords |
| `/raven route tool add <name>` | Route a specific tool through Raven |
| `/raven route tool remove <name>` | Stop routing a specific tool |
| `/raven route keyword add <keyword>` | Route any tool whose name contains `<keyword>` |
| `/raven route keyword remove <keyword>` | Stop routing a tool-name keyword |
| `/raven mcp` | Show on-demand MCP status and generated metadata state |
| `/raven mcp refresh [server]` | Recheck on-demand MCP health and regenerate tool descriptions/schema estimates |
| `/raven mcp detail full\|minimized` | Choose full tool descriptions or minimized capability summaries in guidance |
| `/raven update` | Check npm for a newer Raven, clear OpenCode's plugin cache if needed, then restart opencode |
| `/raven model <name>` | Change Raven's model (requires restart) |
| `/raven effort <value>` | Change Raven's reasoning effort (requires restart) |
| `/raven timeout <seconds>` | Change `raven_seek` timeout, minimum 10 seconds |
| `/raven stats` | Show estimated context saved, including avoided MCP schema load, session, and all-time totals |

Config persists across restarts in `~/.config/opencode/opencode-raven/raven-config.json`. It is global and shared across all projects.

## Example

<p align="center">
  <img src="example.gif" alt="Raven example: searching today's top 30 AI news items while saving 71K context" />
</p>

In this example, the main model asks for the top 30 AI news items from today. Raven handles the noisy search/web work in a focused agent and returns the compact result, saving about 71K context that would otherwise have landed in the main session.

## Recommended MCP Setup

Raven's bundled Context7, Exa, and Grep.app MCPs are on-demand by default. They live in `onDemandMcpServers`, so Raven connects to them internally through `raven_mcp` instead of registering their full tool schemas in OpenCode's global MCP config.

On-demand MCPs are always behind Raven and do not need routing entries.

Raven checks configured on-demand MCPs after startup. `/raven` and `/raven mcp` show loaded, failed, and pending MCPs. Loaded MCPs count toward avoided schema-load stats, while failed or pending MCPs do not. Raven shows a warning toast after startup or manual refresh if any configured on-demand MCP fails to load.

Raven also warns if the same MCP server name is configured both globally in OpenCode and in Raven's `onDemandMcpServers`. Prefer one location: on-demand for schema hiding, or global only when direct main-agent access is required.

All three bundled MCPs work without API keys. Add keys for higher rate limits:

| MCP | URL | API key |
|-----|-----|---------|
| Context7 | `https://mcp.context7.com/mcp` | Free key at [context7.com/dashboard](https://context7.com/dashboard) for higher limits |
| Exa AI | `https://mcp.exa.ai/mcp` | Free key at [exa.ai](https://exa.ai) for higher limits |
| Grep.app | `https://mcp.grep.app` | Public API, no key needed |

To add an API key to an on-demand MCP, edit Raven config:

```jsonc
{
  "onDemandMcpServers": {
    "exa": {
      "type": "remote",
      "url": "https://mcp.exa.ai/mcp",
      "headers": { "x-api-key": "{env:EXA_API_KEY}" },
      "description": "Live web search and webpage fetching."
    }
  }
}
```

To add a local stdio MCP:

```jsonc
{
  "onDemandMcpServers": {
    "localServer": {
      "type": "stdio",
      "command": "bunx",
      "args": ["some-mcp-server"],
      "env": { "API_KEY": "{env:API_KEY}" },
      "cwd": "/optional/path",
      "description": "Local MCP server."
    }
  }
}
```

`description` is user-authored and never overwritten. Raven fills missing generated metadata after startup or when you run `/raven mcp refresh [server]`, storing tool summaries, MCP health, and avoided schema-load estimates separately in `~/.config/opencode/opencode-raven/autogenerated-on-demand-mcp-metadata.json`.

Raven also writes generated main-model guidance to `~/.config/opencode/opencode-raven/autogenerated-on-demand-guidance.md` and injects that file into OpenCode instructions at startup.

## Configuration

Raven config lives at `~/.config/opencode/opencode-raven/raven-config.json`. It is auto-created on first run and auto-migrated on startup when new config fields are added. Old root files such as `~/.config/opencode/raven-config.json` are moved into the `opencode-raven` folder automatically.

Edit config manually or use `/raven` commands:

```json
{
  "enabled": true,
  "model": "opencode/deepseek-v4-flash-free",
  "reasoning_effort": "low",
  "ravenInstructions": "",
  "routeTools": ["grep", "glob", "webfetch", "fetch", "websearch", "bash"],
  "routeToolKeywords": [],
  "onDemandMcpDescriptionDetail": "full",
  "onDemandMcpServers": {
    "context7": {
      "type": "remote",
      "url": "https://mcp.context7.com/mcp",
      "description": "Library/framework documentation lookup."
    },
    "exa": {
      "type": "remote",
      "url": "https://mcp.exa.ai/mcp",
      "description": "Live web search and webpage fetching."
    },
    "grep_app": {
      "type": "remote",
      "url": "https://mcp.grep.app",
      "description": "Public GitHub code search and real-world examples."
    }
  },
  "excludeAgents": [],
  "excludeTools": [],
  "timeout": 180
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Whether tool/MCP routing is active |
| `model` | from `Raven.md` | Override Raven's model without editing package files |
| `reasoning_effort` | from `Raven.md` | Override Raven's reasoning effort, such as `low`, `medium`, or `high` |
| `ravenInstructions` | `""` | Extra instructions appended to Raven's prompt. Useful for custom MCP usage rules. |
| `routeTools` | built-in search/fetch tools plus `bash` | Exact tool names hard-routed through Raven. `bash` routes only search-like bash commands, not every bash call. |
| `routeToolKeywords` | `[]` | Case-insensitive substrings hard-routed through Raven for globally registered tools with non-standard names. Catches suffix-style names like `web_search_exa`. |
| `onDemandMcpDescriptionDetail` | `"full"` | On-demand MCP guidance detail. `full` includes tool names/descriptions; `minimized` uses compact capability summaries. |
| `onDemandMcpServers` | Context7, Exa, Grep.app | MCPs Raven connects to internally on demand, without registering full schemas in OpenCode global MCP config. Supports `remote` and `stdio`. |
| `excludeAgents` | `[]` | Agents that bypass Raven routing, case-insensitive. |
| `excludeTools` | `[]` | Exact tools that never get blocked, even if matched by auto-routed global MCP prefixes. |
| `timeout` | `180` | Max seconds for a `raven_seek` call. On timeout the session is kept for inspection. |
| `stats` | auto | Session and global estimated context saved by Raven. Managed automatically. |

Use `ravenInstructions` for extra Raven-only guidance, such as how to use custom MCPs:

```json
{
  "ravenInstructions": "For Linear requests, prefer assigned open issues and include issue keys in the answer."
}
```

## Routing And Exceptions

By default, Raven routes these built-in tools and auto-routes globally configured MCPs by detected server name:

| Config | Default |
|--------|---------|
| `routeTools` | `grep`, `glob`, `webfetch`, `fetch`, `websearch`, `bash` |
| `routeToolKeywords` | none |

Global MCPs configured in OpenCode are auto-routed through Raven by server name. For example, an MCP named `linear` routes tools named `linear_*`. This works for any MCP whose OpenCode tool names use the normal `<server>_<tool>` prefix. Matching is case-insensitive.

If a server uses suffix-style or mixed tool names, route by keyword instead. For example, `exa` catches names like `web_search_exa` and `web_fetch_exa`:

```txt
/raven route keyword add exa
```

If an MCP is routed but one tool should remain direct, add the exact tool to `excludeTools`:

```json
{
  "excludeTools": ["my_mcp_validate"]
}
```

To route one specific tool without routing the whole MCP server:

```txt
/raven route tool add linear_search_issues
```

`bash` is intercepted only while `bash` is included in `routeTools` and the command matches a primary search/discovery pattern.

| Pattern | Examples |
|---------|----------|
| Content search | `rg`, `grep`, `egrep`, `fgrep`, `git grep`, `ack`, `ag`, `findstr`, `Select-String` |
| Filesystem exploration | `Get-ChildItem -Recurse`, `gci -Recurse`, `Get-ChildItem -Filter`, `find -name`, `find -type`, `ls -R`, `ls --recursive`, `dir /s` |
| Shell bypass | `cmd /c dir /s`, `cmd /c findstr`, `cmd /c find`, `cmd /c tree` |

Unrestricted for non-Raven agents: `read`, `task`, `subtask`, `raven_seek`, non-routed tools, and non-search `bash` commands.

Allowed output filters: piped filters like `command | grep ...`, `command | rg ...`, `command | findstr ...`, and `command | head ...` are allowed. Raven only blocks search commands when they are used as primary discovery commands, not when they filter bounded output from another command.

To stop routing search-like bash commands, remove `bash` from `routeTools`:

```txt
/raven route tool remove bash
```

Quoted content and shell comments in bash commands are stripped before pattern matching. For example, `echo "use grep here"` and `# use grep later` do not trigger routing.

## What Raven Saves

Raven saves context from tool call results and raw MCP output by moving the work into a Raven session and returning a compact answer. On-demand MCPs also avoid loading full MCP tool schemas into the main OpenCode session because Raven connects to them internally through `raven_mcp`.

MCPs configured directly in OpenCode `opencode.jsonc` still load globally and may increase the main session's starting context. Use `onDemandMcpServers` for MCPs you want Raven to keep behind the context firewall.

`/raven stats` uses a balanced estimate: Raven's final session token total minus the first Raven assistant turn's input/cache baseline, then minus the compact answer returned to the main session. This counts tool/web/MCP result context Raven handled while avoiding Raven's starting prompt and tool-schema overhead.

`Avoided MCP schema load` is a separate estimate based on full loaded on-demand MCP tool schemas discovered by Raven but not loaded into the main model. Failed or pending MCPs do not count toward this total. It is stored in autogenerated MCP metadata and shown separately from delegated session savings.

## How It Works

| Hook | What it does |
|------|--------------|
| `config` | Registers Raven agent, loads MCP routing guidance, and starts on-demand MCP health/metadata checks. Bundled MCPs are on-demand by default, not injected into global OpenCode MCP config. |
| `tool` | Registers `raven_seek` and Raven-only `raven_mcp`. `raven_seek` creates Raven sessions with timeout, error recovery, timing, and session tree visibility. Tracks context saved for stats. |
| `chat.message` | Tracks agent to session mapping for allowlist and Raven exclusion. |
| `event` | Shows startup update and MCP failure notifications after the TUI event stream is ready. |
| `command.execute.before` | Handles `/raven help`, routing commands, MCP commands, update checks, model settings, timeout, and stats. |
| `tool.execute.before` | Hard-blocks configured tools/MCPs for non-Raven, non-excluded agents. Error output gives the next `raven_seek(query="...")` call. Injects dynamic `<raven_guidance>` with configured routes into subagent prompts. |
| `tool.execute.after` | Tracks direct `@Raven` calls for context-saved stats. |

Every non-Raven, non-excluded subagent gets `<raven_guidance>` injected into its prompt at spawn time. The injected guidance includes `routeTools`, auto-detected global MCP prefixes, `routeToolKeywords`, and on-demand MCP capabilities.

## Agent Capabilities

Raven itself has access to these tools, blocked for other agents when configured by the plugin:

| Tool / MCP | Purpose |
|------------|---------|
| `read`, `glob`, `grep`, `list` | Local codebase inspection |
| `bash` | Full local shell access, including `rg`, `grep`, `dir`, `ls`, `Get-ChildItem`, and `find` |
| `external_directory` | Allowed, with no permission prompts when accessing paths outside the workspace |
| `raven_mcp` | Raven-only bridge to on-demand remote/stdio MCP servers |
| Context7 | On-demand library/framework/SDK/API docs |
| Exa AI | On-demand web search, news, pages, products |
| Grep.app | On-demand public GitHub examples |

`raven_seek` is denied inside Raven itself so Raven cannot recursively call its own wrapper tool. Raven uses direct tools, globally available MCPs, and `raven_mcp` for on-demand MCPs instead.

Raven returns compact findings: answer, sources, relevant details, recommended next step, and uncertainty.

## License

MIT
