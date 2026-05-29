# opencode-raven

Search-first subagent for [opencode](https://opencode.ai) — intercepts search tool calls from other agents and routes them to a dedicated **@raven** agent with Context7, Exa AI, and Grep.app MCPs.

## Why?

Other agents (orchestrator, fixer, etc.) waste tokens and context on search tools. Raven gives them a single delegation target that's purpose-built for search, with the right MCPs wired in and a compact-output prompt.

## Install

```bash
bun add opencode-raven
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

## Configuration

### raven-config.json

Created automatically in your project root on first toggle. Edit manually or use `/raven` commands:

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

All three MCPs are enabled by default:

| MCP | URL | Notes |
|-----|-----|-------|
| Context7 | `https://mcp.context7.com/mcp` | No API key needed |
| Exa AI | `https://mcp.exa.ai/mcp` | Requires Exa account |
| Grep.app | `https://mcp.grep.app` | No API key needed |

To disable an MCP, override it in your `opencode.jsonc`:

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
| `chat.message` | Tracks Raven's session IDs so its own tools aren't blocked |
| `command.execute.before` | Handles `/raven on\|off\|model\|status` |
| `tool.execute.before` | Nukes search tool args for non-Raven agents (no wasted API calls) |
| `tool.execute.after` | Replaces search tool output with redirect to Raven |

**Blocked tools** (redirected to Raven for all agents except Raven itself):

| Tool | Raven's equivalent |
|------|-------------------|
| `websearch_web_search_exa` | Exa AI (web search) |
| `exa_web_search_exa` | Exa AI (web search via MCP) |
| `exa_web_fetch_exa` | Exa AI (page fetch via MCP) |
| `grep_app_searchGitHub` | Grep.app (GitHub examples) |
| `grep` | grep/rg (local code search) |
| `glob` | glob (file search) |

**Unrestricted**: `webfetch`, `read`, `bash`, `task`, and all other tools.

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