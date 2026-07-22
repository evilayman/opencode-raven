<div align="center">
  <h1>opencode-raven</h1>
  <p><strong>Keep noisy tool work out of your main OpenCode context.</strong></p>
  <p>
    <a href="https://www.npmjs.com/package/opencode-raven"><img src="https://img.shields.io/npm/v/opencode-raven.svg" alt="npm version" /></a>
    <a href="https://www.npmjs.com/package/opencode-raven"><img src="https://img.shields.io/npm/dm/opencode-raven.svg" alt="npm downloads" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/npm/l/opencode-raven.svg" alt="license" /></a>
  </p>
</div>

<table>
  <tr>
    <td width="28%" align="center" valign="middle">
      <img src="Raven.png" alt="Raven" width="180" />
    </td>
    <td valign="top">
      <h2>Why Raven</h2>
      <p>Raven delegates search and on-demand MCP retrieval to separate focused agents, then returns compact evidence to the calling session.</p>
      <ul>
        <li>Routes OpenCode search tools and globally configured MCPs through <code>raven_seek</code>.</li>
        <li>Uses a separately configurable model for on-demand MCP retrieval through <code>raven_mcp</code>.</li>
        <li>Keeps optional on-demand MCP schemas out of the main model's tool list.</li>
        <li>Preconfigures Context7, Exa, and Grep.app endpoints.</li>
        <li>Tracks estimated main-session context avoided by delegation.</li>
      </ul>
    </td>
  </tr>
</table>

## Install

Raven requires OpenCode 1.15.12 or newer. Add it to `opencode.jsonc`:

```jsonc
{
  "plugin": ["opencode-raven"]
}
```

Restart OpenCode, then run `/raven` to verify the loaded version, model, routing, MCP health, and estimated savings.

OpenCode resolves the package from npm and caches it automatically.

## Example

<p align="center">
  <img src="example.gif" alt="Raven automatically delegating web research while reducing main-session context" />
</p>

In this run, Raven handled the search-heavy web research in a child session and returned only the compact findings, keeping roughly 71K tokens of estimated tool and search context from flooding the main session. Actual savings vary by task, model, and tool output.

## How It Works

**Raven works automatically.** Ask OpenCode for what you need as usual. You do not need to mention Raven, run a command, or manually call a delegation tool.

1. Your agent attempts to use a routed search, fetch, shell-discovery, or MCP tool.
2. Raven blocks the noisy direct call and gives the agent the exact `raven_seek` retry.
3. The selected Raven agent creates a session attached directly to the root session or resumes one for a related follow-up.
4. Raven performs retrieval work and returns compact evidence to the calling agent, which retains analysis and judgment.

The main model receives Raven's final answer instead of its raw tool output. Each result includes a Raven session ID that the main agent can pass back for a context-aware follow-up. Child sessions remain available in OpenCode's session/subagent view for inspection.

For direct search control, mention `@Raven` in any chat. This sends the request to the search agent, but it is optional and not required for automatic routing.

Under the hood, Raven registers two public delegation tools and one internal bridge:

| Tool | Purpose |
|------|---------|
| `raven_seek` | Creates or resumes a Raven Search session for narrowly scoped evidence retrieval. |
| `raven_mcp` | Creates or resumes a Raven MCP session for configured on-demand MCP capabilities. |
| `raven_mcp_bridge` | Internal bridge used only by the Raven MCP agent. |

For a related follow-up, the main agent can reuse the ID returned by the earlier call:

```text
raven_seek(query="Research the available options")
raven_seek(query="Compare the first two in more detail", sessionId="ses_...")
```

Raven accepts a resumed session only when it belongs to the same root session tree and matching Raven agent. Do not pass session IDs between `raven_seek` and `raven_mcp`. Delegated sessions attach directly to the root so they remain visible in the main session's child switcher even when delegation starts inside another child.

OpenCode's built-in tools already exist; Raven routes selected calls instead of replacing those tools. Global MCPs also remain globally registered, so their schemas still enter the main session even when Raven routes their calls.

On-demand MCPs are different: Raven discovers and calls them internally, so their full schemas are not registered globally. Enabled servers are probed after startup to discover tools and health, then per-session connections are opened when Raven uses them. "On-demand" describes schema exposure and normal use, not the absence of a startup health probe.

## Configuration

Raven creates its global configuration here:

```txt
~/.config/opencode/opencode-raven/raven-config.json
```

Manual edits require an OpenCode restart. Route and timeout commands apply immediately unless the command says otherwise.

| Field | Fresh-install default | Description |
|-------|-----------------------|-------------|
| `raven_seek.model` | From `Raven.md` | Search-agent model override. |
| `raven_seek.reasoning_effort` | `low` | Search-agent reasoning option. |
| `raven_seek.instructions` | `""` | Extra search-agent instructions. |
| `raven_seek.routeTools` | Search/fetch tools plus `bash` | Exact tools routed through Raven Search. |
| `raven_seek.routeToolKeywords` | `[]` | Case-insensitive routed tool-name substrings. |
| `raven_seek.excludeAgents` | `[]` | Agents allowed to bypass search routing. |
| `raven_seek.excludeTools` | `[]` | Exact tools never routed through Raven Search. |
| `raven_seek.timeout` | `600` | Search delegation timeout in seconds. |
| `raven_mcp.model` | From `RavenMcp.md` | MCP-agent model override. |
| `raven_mcp.reasoning_effort` | `low` | MCP-agent reasoning option. |
| `raven_mcp.instructions` | `""` | Extra MCP-agent instructions. |
| `raven_mcp.timeout` | `600` | MCP delegation and fallback connection timeout in seconds. |
| `raven_mcp.descriptionDetail` | `"full"` | Full or minimized generated MCP guidance. |
| `raven_mcp.onDemandMcpServers` | Context7, Exa, Grep.app | Remote HTTP/SSE or local stdio MCP definitions. |

Existing flat configuration is migrated automatically on startup without a version field. Shared model, reasoning effort, instructions, and timeout values seed both sections; routing and MCP fields move to their corresponding sections.

## On-Demand MCPs

Fresh installs include:

| MCP | Endpoint | Authentication |
|-----|----------|----------------|
| Context7 | `https://mcp.context7.com/mcp` | Optional key for higher limits |
| Exa | `https://mcp.exa.ai/mcp` | Optional key for higher limits |
| Grep.app | `https://mcp.grep.app` | Public API |

Provider access policies can change. `/raven mcp` shows the result of Raven's current startup probe.

Merge changes into the existing `raven_mcp.onDemandMcpServers` object; replacing it removes omitted defaults. Header and environment values support `{env:VARIABLE}` placeholders.

Custom remote MCP or keyed endpoint:

```jsonc
{
  "raven_mcp": {
    "onDemandMcpServers": {
      "myDocs": {
        "type": "remote",
        "url": "https://example.com/mcp",
        "headers": { "Authorization": "Bearer {env:MY_DOCS_TOKEN}" }
      }
    }
  }
}
```

Custom local stdio MCP:

```jsonc
{
  "raven_mcp": {
    "onDemandMcpServers": {
      "myLocal": {
        "type": "local",
        "command": ["bunx", "some-mcp-server"],
        "environment": { "API_KEY": "{env:MY_LOCAL_KEY}" },
        "cwd": "C:\\path\\to\\workspace",
        "timeout": 60000
      }
    }
  }
}
```

Per-server `timeout` values are milliseconds. Local servers inherit the OpenCode process environment. Set `enabled: false` to keep an entry without probing or loading it.

Generated MCP metadata and main-model guidance live beside `raven-config.json`. Refresh them with `/raven mcp refresh [server]`.

## Routing

Default routed tools are `grep`, `glob`, `webfetch`, `fetch`, `websearch`, and search-like `bash` commands.

Global MCPs are automatically routed when their OpenCode tool names use the normal `<server>_<tool>` prefix. Use a keyword for suffix-style names:

```txt
/raven route keyword add exa
```

Route or unroute exact tools:

```txt
/raven route tool add linear_search_issues
/raven route tool remove bash
```

`raven_seek.excludeTools` leaves selected tools direct even if their MCP prefix is routed. `raven_seek.excludeAgents` bypasses routing for selected agents.

When `bash` is routed, Raven intercepts primary discovery commands such as `rg`, recursive `grep`, `find -name`, `dir /s`, and `Get-ChildItem -Recurse`, including common quoted shell wrappers. Bounded output filters such as `command | grep ...` remain direct.

## Commands

| Command | Action |
|---------|--------|
| `/raven` | Show status, routing, MCP health, version, model, timeout, and stats. |
| `/raven help` | Show command help. |
| `/raven route` | Show and edit routed tools and keywords. |
| `/raven mcp` | Show on-demand MCP health and generated metadata. |
| `/raven mcp refresh [server]` | Recheck MCP health and regenerate metadata. |
| `/raven mcp detail full|minimized` | Set generated guidance detail; restart afterward. |
| `/raven seek model <provider/model>` | Change the search model; restart afterward. |
| `/raven seek effort <value>` | Change search reasoning effort; restart afterward. |
| `/raven seek timeout <seconds>` | Change the search delegation timeout. |
| `/raven mcp model <provider/model>` | Change the MCP model; restart afterward. |
| `/raven mcp effort <value>` | Change MCP reasoning effort; restart afterward. |
| `/raven mcp timeout <seconds>` | Change the MCP delegation timeout. |
| `/raven stats` | Show estimated context avoided. |
| `/raven update` | Check npm, clear Raven's OpenCode package cache when needed, and show restart instructions. |

## Security And Privacy

Raven is optimized for autonomous retrieval:

- Raven Search has read, search, unrestricted shell, external-directory, and globally configured MCP access without normal permission prompts.
- Raven MCP has only the internal on-demand MCP bridge and cannot use shell, local search, or edit tools.
- Its `edit` tool is denied, but shell access is not a read-only sandbox and can modify the system.
- Queries are sent to Raven's configured model provider.
- Remote MCP requests are sent to their services; local MCP entries launch local commands and inherit environment values.
- Startup performs an npm update check and probes enabled on-demand MCPs.

Review `Raven.md` and your MCP commands before using Raven in sensitive environments.

## Context Estimates

`/raven stats` reports delegated-session context and avoided on-demand MCP schema bytes. These are heuristic estimates based on OpenCode token metadata and serialized schemas, not billing measurements or guaranteed savings.

## Troubleshooting

- Search provider or quota failure: run `/raven seek model <provider/model>`, then restart OpenCode.
- MCP-agent provider or quota failure: run `/raven mcp model <provider/model>`, then restart OpenCode.
- MCP failure: run `/raven mcp`, then `/raven mcp refresh <server>` after correcting its URL, command, environment, or credentials.
- Stale plugin version: run `/raven update`, restart OpenCode, and follow the cache-clearing instructions it prints if needed.
- Remove Raven: delete `"opencode-raven"` from `plugin`, restart, then optionally remove `~/.config/opencode/opencode-raven/`.

See [CHANGELOG.md](CHANGELOG.md) for release history.

## Disclaimer

opencode-raven is an independent project and is not affiliated with the OpenCode team. Released under the [MIT License](LICENSE).
