# opencode-raven

<table>
<tr>
<td><img src="Raven.png" alt="Raven" width="768" /></td>
<td>
<strong>Search-first subagent for <a href="https://opencode.ai">opencode</a></strong><br/>
Intercepts search tool calls and routes them to a dedicated <strong>@raven</strong> agent with Context7, Exa AI, and Grep.app MCPs.
</td>
</tr>
</table>

## Why?

Search is the most common thing agents do — and the most wasteful. Every search call burns tokens and context on results that a cheap, focused agent could handle better. Raven fixes three problems:

1. **Cost** — Use a free model like `opencode/deepseek-v4-flash-free` for all search, saving your expensive model's context for actual work.
2. **Reliability** — Hard-enforced interception. Other plugins suggest delegation; Raven *blocks* search tools for non-Raven agents and redirects them. No more agents ignoring your instructions and searching directly.
3. **Simplicity** — One plugin, one agent, zero config. No bundled agents or features you don't need. Works with any agent or workflow. Just add it to `opencode.jsonc` and restart.

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
| `/raven` | Show status — enabled/disabled, current model |
| `/raven on` | Enable search tool redirection to @raven (default) |
| `/raven off` | Disable interception — all agents can use search tools directly |
| `/raven model <name>` | Change Raven's model (e.g. `/raven model opencode/deepseek-v4-flash-free`) |

Config persists across restarts in `raven-config.json` (next to your `opencode.jsonc`).

## raven_seek — fallback for agents without task

When search tools are blocked, agents are told to delegate to Raven via the `task` tool (`subagent_type="raven"`). This is the preferred path — the Raven subagent runs visibly in its own session, and you can see its work.

Some agents have `task: deny` and can't delegate. **`raven_seek`** is the fallback for those agents — a custom tool that any agent can call directly, no `task` permission needed:

```
raven_seek(query: "how to use useEffect cleanup")
```

The tool creates a Raven session behind the scenes, sends the query, and returns results. It's less visible than task delegation, so it's only used when task isn't available.

## Configuration

### raven-config.json

Created automatically on first toggle. Edit manually or use `/raven` commands:

```json
{
  "enabled": true,
  "model": "opencode/deepseek-v4-flash-free"
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Whether search tool interception is active |
| `model` | *(from Raven.md)* | Override Raven's model without editing package files |

### MCP servers

All three MCPs work without API keys. Adding keys increases rate limits:

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
| `tool` | Registers `raven_seek` — fallback tool for agents that can't use `task` |
| `chat.message` | Tracks Raven's session IDs so its own tools aren't blocked |
| `command.execute.before` | Handles `/raven on\|off\|model\|status` |
| `tool.execute.before` | Throws to abort disabled tools before they execute — no wasted API calls |
| `tool.execute.after` | Safety net: replaces output if the tool somehow still ran |

### Blocked tools (redirected for all agents except Raven itself)

**Dedicated search tools:**

| Tool | Source |
|------|--------|
| `grep`, `glob` | Built-in |
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

**Unrestricted**: `webfetch`, `read`, `task`, `raven_seek`, and non-search `bash` commands.

## Agent capabilities

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