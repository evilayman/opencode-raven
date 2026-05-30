# opencode-raven

<table>
<tr>
<td><img src="Raven.png" alt="Raven" width="768" /></td>
<td>
<strong>Search-first subagent for <a href="https://opencode.ai">opencode</a></strong><br/>
Intercepts search tool calls and routes them to a hidden Raven agent with Context7, Exa AI, and Grep.app MCPs.
</td>
</tr>
</table>

## Why?

Search is the most common thing agents do — and the most wasteful. Every search call burns tokens and context on results that a cheap, focused agent could handle better. Raven fixes three problems:

1. **Cost** — Use a free model like `opencode/deepseek-v4-flash-free` for all search, saving your expensive model's context for actual work.
2. **Reliability** — Hard-enforced interception. Other plugins suggest delegation; Raven *blocks* search tools for non-Raven agents and redirects them. No more agents ignoring your instructions and searching directly.
3. **Simplicity** — One plugin, one agent, auto-configured. No bundled agents or features you don't need. Works with any agent or workflow. Just add it to `opencode.jsonc` and restart.

## Install

```bash
bun add opencode-raven
# or
npm install opencode-raven
```

Then add to your `opencode.jsonc`:

```jsonc
{
  "plugin": ["opencode-raven"]
}
```

Restart opencode.

## Commands

| Command | Action |
|---------|--------|
| `/raven` | Show status — enabled/disabled, current model, reasoning effort |
| `/raven on` | Enable search tool redirection (default) |
| `/raven off` | Disable interception — all agents can use search tools directly |
| `/raven model <name>` | Change Raven's model (requires restart) |
| `/raven effort <value>` | Change Raven's reasoning effort (requires restart) |
| `/raven stats` | Show blocked calls, context saved (session + global) |

Config persists across restarts in `~/.config/opencode/raven-config.json` (global, shared across all projects). Auto-created on first run.

## raven_seek

When search tools are blocked, agents use **`raven_seek`** — a tool that creates a hidden Raven session, runs the search, and returns compact results:

```
raven_seek(query: "how to use useEffect cleanup")
```

The agent doesn't see Raven's internal tool calls — just the final findings. Raven parallelizes independent searches internally within a single session.

## Configuration

### raven-config.json

Located at `~/.config/opencode/raven-config.json`. Auto-created on first run. Edit manually or use `/raven` commands:

```json
{
  "enabled": true,
  "model": "opencode/deepseek-v4-flash-free",
  "reasoning_effort": "low",
  "excludeAgents": [],
  "excludeTools": []
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Whether search tool interception is active |
| `model` | *(from Raven.md)* | Override Raven's model without editing package files |
| `reasoning_effort` | *(from Raven.md)* | Override Raven's reasoning effort (e.g. `"low"`, `"medium"`, `"high"`) |
| `excludeAgents` | `[]` | Agents that bypass search tool blocking (case-insensitive). e.g. `["librarian", "explorer"]` |
| `excludeTools` | `[]` | Tools that never get blocked. e.g. `["glob", "webfetch"]` |
| `stats` | *(auto)* | Global blocked call count and context saved. Managed automatically. |

### MCP servers

All three MCPs work without API keys. Add keys for higher rate limits:

| MCP | URL | API key |
|-----|-----|---------|
| Context7 | `https://mcp.context7.com/mcp` | Free key at [context7.com/dashboard](https://context7.com/dashboard) — higher limits |
| Exa AI | `https://mcp.exa.ai/mcp` | Free key at [exa.ai](https://exa.ai) — higher limits |
| Grep.app | `https://mcp.grep.app` | Not available — public API, no key needed |

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
| `config` | Registers Raven agent, adds Context7/Exa/Grep.app MCPs, loads MCP guidance |
| `tool` | Registers `raven_seek` — hidden Raven sessions with error recovery for API failures |
| `chat.message` | Tracks agent ↔ session mapping for allowlist and Raven exclusion |
| `command.execute.before` | Handles `/raven on\|off\|model\|effort\|status` |
| `tool.execute.before` | Blocks search tools for non-Raven, non-excluded agents. Injects `<raven_guidance>` into subagent prompts. Tracks blocked calls + context saved. |

### Blocked tools (redirected except for Raven and any agents in `excludeAgents`)

**Dedicated search tools:**

| Tool | Source |
|------|--------|
| `grep`, `glob`, `webfetch`, `fetch` | Built-in |
| `websearch_web_search_exa` | WebSearch MCP |
| `context7_resolve-library-id`, `context7_query-docs` | Context7 MCP |
| `exa_web_search_exa`, `exa_web_fetch_exa`, `exa_web_search_advanced_exa` | Exa AI MCP |
| `exa_company_research_exa`, `exa_crawling_exa`, `exa_people_search_exa` | Exa AI MCP |
| `exa_linkedin_search_exa`, `exa_get_code_context_exa` | Exa AI MCP |
| `exa_deep_researcher_start`, `exa_deep_researcher_check`, `exa_deep_search_exa` | Exa AI MCP |
| `grep_app_searchGitHub` | Grep.app MCP |

**Bash commands** — intercepted when the command or description matches a search pattern:

| Pattern | Examples |
|---------|----------|
| Content search | `rg`, `grep`, `egrep`, `fgrep`, `git grep`, `ack`, `ag`, `findstr`, `Select-String` |
| Filesystem exploration | `Get-ChildItem`, `gci`, `find -name`, `find -type`, `ls -R`, `dir /s` |

**Unrestricted**: `read`, `task`, `subtask`, `raven_seek`, and non-search `bash` commands.

**Bash quote stripping**: Quoted content in bash commands is stripped before pattern matching — `echo "use grep here"` won't falsely trigger blocking.

**Subagent guidance**: Every non-Raven, non-excluded subagent gets `<raven_guidance>` injected into its prompt at spawn time.

## Agent capabilities

Raven itself has access to these tools (blocked for other agents by the plugin):

| Tool / MCP | Purpose |
|------------|---------|
| `read`, `glob`, `grep`, `list` | Local codebase inspection |
| `bash` (`rg`, `grep`, `git grep`) | Local search commands |
| Context7 | Library/framework/SDK/API docs |
| Exa AI | Web search, news, pages, products |
| Grep.app | Public GitHub examples |

Raven returns compact findings: answer, sources, relevant details, recommended next step, and uncertainty.

## License

MIT