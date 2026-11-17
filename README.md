<div align="center">
  <h1>opencode-raven</h1>
  <p><strong>Keep noisy tool work out of your main OpenCode context.</strong></p>
  <p><strong>Supports OpenCode V2 (2.0.26+) and OpenCode V1 (1.18.29+), in one package.</strong></p>
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
      <p>Raven delegates local search to Raven Search and app/tool work to Raven Act, returning compact results to the calling session.</p>
      <ul>
        <li>Routes local search and filesystem discovery through lightweight <code>raven_seek</code>.</li>
        <li>Uses one configurable <code>raven_act</code> operator for MCP-first online research and requested app, website, and tool operations.</li>
        <li>Keeps optional on-demand MCP schemas out of the main model's tool list.</li>
        <li>Combines MCP and registered CLI bridges in the same operator session, with Raven's existing auto-approval.</li>
        <li>Preconfigures Context7, Exa, and Grep.app endpoints.</li>
        <li>Tracks estimated main-session context avoided by delegation.</li>
      </ul>
    </td>
  </tr>
</table>

## Install

**Raven 2.4.0 supports OpenCode V2 (2.0.26+).** OpenCode V1 (1.18.29+) remains supported in the same package—no separate plugin is needed.

### OpenCode V2

In OpenCode's **Install plugin** feature, enter `opencode-raven`.

Or install globally from the CLI:

```sh
opencode plugin add opencode-raven
```

Either way, OpenCode manages the plugin configuration and automatically loads Raven's terminal companion—no separate terminal plugin install is needed.

For manual configuration, use the v2 `plugins` key in `opencode.jsonc` instead:

```jsonc
{
  "plugins": ["opencode-raven"]
}
```

### OpenCode V1

Use the v1 `plugin` key in `opencode.jsonc`:

```jsonc
{
  "plugin": ["opencode-raven"]
}
```

Restart OpenCode, then run `/raven` to verify the loaded version, model, routing, MCP health, and estimated savings. A fresh install may ask for one additional restart after selecting its model.

OpenCode resolves the package from npm and caches it automatically.

### Upgrading From OpenCode 1 To 2

Keep using `opencode-raven`; change its OpenCode config entry from `plugin` to `plugins`. Raven's existing `~/.config/opencode/opencode-raven/raven-config.json` is shared by both versions, including models, on-demand MCPs, routing settings, and stats. Quit and restart OpenCode after upgrading.

OpenCode 1 uses Raven's `server()` entrypoint; OpenCode 2 uses `setup()` and automatically loads the terminal companion. The terminal companion displays `/raven` command results in a scrollable dialog (arrow keys, Page Up/Down, or mouse wheel; Esc to close) and delivers startup/update warnings as toasts, without sending a prompt to the model. The v2 server also exposes the typed `opencode-raven/rpc` command contract for other clients.

The v1 minimum is 1.18.29 because earlier versions cannot load the shared object entrypoint. See OpenCode's [plugin migration guide](https://opencode.ai/v2/docs/build/plugins/migrate-v1) for the upstream lifecycle and config changes.

For local development, v1 can load `file:///path/to/opencode-raven/index.ts`; v2 requires the package directory, `file:///path/to/opencode-raven`.

### Upgrading from 2.3.x

Existing `raven_mcp` and `raven_cli` settings automatically migrate into
`raven_act`, including MCP definitions, CLI registrations, and custom instructions.
Update custom prompts and integrations to call `raven_act` instead of `raven_mcp`
or `raven_cli`. Start a new Act session; old agent sessions remain inspectable but
cannot be resumed under the new agent.

On V2, **Act now defaults to foreground execution**; set `background: true` when
you want a background task. `raven_seek` remains background-first. The published
`/raven mcp model|effort|timeout` commands still work as aliases for `/raven act`
settings.

See [On-Demand CLIs](#on-demand-clis) for registration examples and
[Configuration](#configuration) for migration precedence and shared settings.

### First-Time Setup

On first start, Raven checks OpenCode's connected provider catalog and automatically selects an available zero-cost, tool-capable model from the `opencode` provider for both Raven agents. Free-model availability is controlled by the provider and can change.

If a free model is found, Raven writes it to the config and asks you to restart OpenCode once to load it. After restarting, `/raven` shows it with `(auto)`. Raven rechecks auto-selected models after startup and replaces one only when it is no longer available. A model you set manually is never replaced.

If no suitable free model is available, Raven shows a setup warning and leaves search routing inactive rather than silently using a paid model. Open OpenCode's model picker to choose an available model, then run:

```txt
/raven seek model <provider/model>
/raven act model <provider/model>
```

Reload OpenCode afterward. You can retry free-model detection at any time with `/raven seek model auto` and `/raven act model auto`.

## Example

<p align="center">
  <img src="example.gif" alt="Raven automatically delegating web research while reducing main-session context" />
</p>

In this run, Raven handled the search-heavy web research in a child session and returned only the compact findings, keeping roughly 71K tokens of estimated tool and search context from flooding the main session. Actual savings vary by task, model, and tool output.

## How It Works

**Raven works automatically.** Ask OpenCode for what you need as usual. You do not need to mention Raven, run a command, or manually call a delegation tool.

1. Your agent attempts to use a routed search, fetch, shell-discovery, or MCP tool.
2. Raven blocks the noisy direct call and gives the agent the exact retry: `raven_seek` for local searches, or `raven_act` for web research and global MCP tools. Registered CLI work also uses `raven_act`.
3. The selected Raven agent creates a session attached directly to the root session or resumes one for a related follow-up.
4. Raven retrieves evidence or performs the explicitly requested operation, returning compact results to the calling agent, which retains planning and judgment.

The main model receives Raven's final answer instead of its raw tool output. Each result includes a Raven session ID that the main agent can pass back for a context-aware follow-up. Child sessions remain available in OpenCode's session/subagent view for inspection.

### Background Tasks (OpenCode V2)

On V2, `raven_seek` **runs in the background by default**. `raven_act` defaults to **foreground** execution and accepts `background: true` for explicitly requested background work. A background response contains a child-session handle, not the result. Raven delivers compact results or a failure notice to that same calling session, including when the caller is itself a child session.

```text
raven_act(query="Find the current API documentation")
raven_act(query="Retrieve library examples", background=true)
raven_seek(query="Find the definition needed for my next step", background=false)
```

Use `background: false` when the next step depends on the answer. Do not poll, repeat a pending retrieval, or finalize conclusions that need its findings. Wait for the completion message before reusing its `sessionId` for a follow-up.

Background retrieval keeps Raven's configured timeouts, permissions, continuation checks, and context estimates. Returning the handle ends the calling tool, not the child retrieval. To stop it, open the returned child session and interrupt it. Deleting the calling session also cancels its pending retrievals.

Results are delivered through V2's durable synthetic inbox input, which can resume the calling agent and therefore cause another model turn. Undelivered results are retained in plugin storage and retried when that location's plugin next loads. A plugin/service restart cancels running work; Raven reports the interruption instead of automatically replaying searches or potentially stateful MCP/CLI calls. V1 keeps foreground behavior. Never replay an uncertain operation merely because its result was interrupted or delivered late.

Raven manages its own background child sessions using the public plugin APIs. This does not add native Ctrl+B background support to Raven's custom tools.

For direct search control, mention `@Raven` in any chat. This sends the request to the search agent, but it is optional and not required for automatic routing.

Under the hood, Raven registers two public delegation tools and two internal bridges:

| Tool | Purpose |
|------|---------|
| `raven_seek` | Creates or resumes a lightweight Raven Search session for local file search, discovery, and command-output inspection. |
| `raven_act` | Creates or resumes one operator session for online research and explicitly requested app/service/tool operations through MCP and registered CLIs. |
| `raven_mcp_bridge` | Internal MCP adapter used only by Raven Act (remote HTTP/SSE or local stdio). |
| `raven_cli_bridge` | Internal CLI discovery, help, and execution adapter used only by Raven Act. |

On OpenCode V2, Raven auto-approves permission checks for the public `raven_seek` and `raven_act` delegation tools instead of prompting on every call. Inside either Raven agent, any permission check that would otherwise ask is automatically approved, including skill loading, MCP calls, and CLI execution. Explicit deny rules still apply. These execution-time approvals do not add a blanket agent permission or change the main agent's permissions or access restrictions on the internal bridges. State-changing operations can execute without a confirmation prompt.

For a related follow-up, the main agent can reuse the ID returned by the earlier call:

```text
raven_act(query="Inspect the scene through the configured Unity MCP")
raven_act(query="Use the registered Unity CLI to perform the requested build", sessionId="ses_...")
```

Raven accepts a resumed session only when it belongs to the same root session tree and matching Raven agent. MCP and CLI steps share the same `raven_act` history; do not pass IDs between `raven_seek` and `raven_act`. Delegated sessions attach directly to the root so they remain visible in the main session's child switcher even when delegation starts inside another child.

OpenCode's built-in tools already exist; Raven routes selected calls instead of replacing those tools. Global MCPs also remain globally registered, so their schemas still enter the main session even when Raven routes their calls.

On-demand MCPs are different: Raven discovers and calls them internally, so their full schemas are not registered globally. Enabled servers are probed after startup to discover tools and health, then per-session connections are opened when Raven uses them. "On-demand" describes schema exposure and normal use, not the absence of a startup health probe.

On OpenCode V2, reopening the TUI triggers a fresh background health and tool-discovery check even if the shared service is still running. This runs once per workspace per TUI launch; returning from sessions or reactivating the plugin does not repeat it. Overlapping attachment checks share the same refresh. Use `/raven mcp refresh [server_name]` to retry manually without restarting the service.

Automatic and manual MCP refreshes use top-right notifications for progress and results, without opening a command dialog or a session tab.

## Configuration

Raven creates its global configuration here:

```txt
~/.config/opencode/opencode-raven/raven-config.json
```

Manual edits require an OpenCode restart. Route and timeout commands apply immediately unless the command says otherwise.

| Field | Fresh-install default | Description |
|-------|-----------------------|-------------|
| `raven_seek.model` | Auto-detected free OpenCode model, otherwise unset | Search-agent model. Manual values are preserved. |
| `raven_seek.autoSelectedModel` | Managed by Raven | Tracks whether the Search model can be safely refreshed automatically. |
| `raven_seek.reasoning_effort` | `low` | Search-agent reasoning option. |
| `raven_seek.instructions` | `""` | Extra search-agent instructions. |
| `raven_seek.routeTools` | Search/fetch tools plus `bash` | Exact tools routed through Raven Search. |
| `raven_seek.routeToolKeywords` | `[]` | Case-insensitive routed tool-name substrings. |
| `raven_seek.excludeAgents` | `[]` | Agents allowed to bypass search routing. |
| `raven_seek.excludeTools` | `[]` | Exact tools never routed through Raven Search. |
| `raven_seek.timeout` | `600` | Search delegation timeout in seconds. |
| `raven_act.model` | Auto-detected free OpenCode model, otherwise unset | Shared operator model for MCP and CLI. Manual values are preserved. |
| `raven_act.autoSelectedModel` | Managed by Raven | Tracks whether the operator model can be safely refreshed automatically. |
| `raven_act.reasoning_effort` | `low` | Operator reasoning option. |
| `raven_act.instructions` | `""` | Extra operator instructions shared across both bridges. |
| `raven_act.timeout` | `600` | Shared delegation and fallback MCP connection timeout in seconds. |
| `raven_act.descriptionDetail` | `"full"` | Full or minimized generated MCP guidance. |
| `raven_act.onDemandMcpServers` | Context7, Exa, Grep.app | Remote HTTP/SSE or local stdio MCP definitions. |
| `raven_act.onDemandClis` | `{}` | Named external CLI definitions; none installed or probed automatically. |

Existing flat configuration and the former `raven_mcp`/`raven_cli` sections migrate
automatically into `raven_seek` and `raven_act`. The operator keeps MCP definitions,
CLI registrations, and both sets of custom instructions. Explicit `raven_act`
values take precedence; otherwise former MCP agent settings win over former CLI
agent settings because there is now one model/timeout. Legacy `/raven mcp
model|effort|timeout` commands remain aliases for the shared Act settings.
The old `raven_mcp` and `raven_cli` delegation tools are replaced by `raven_act`;
old agent sessions cannot be resumed as Act sessions. Start a new Act task.

## On-Demand MCPs

Fresh installs include:

| MCP | Endpoint | Authentication |
|-----|----------|----------------|
| Context7 | `https://mcp.context7.com/mcp` | Optional key for higher limits |
| Exa | `https://mcp.exa.ai/mcp` | Optional key for higher limits |
| Grep.app | `https://mcp.grep.app` | Public API |

Provider access policies can change. `/raven mcp` shows the result of Raven's current startup probe.

Merge changes into the existing `raven_act.onDemandMcpServers` object; replacing it removes omitted defaults. Header and environment values support `{env:VARIABLE}` placeholders.

Custom remote MCP or keyed endpoint:

```jsonc
{
  "raven_act": {
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
  "raven_act": {
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

### Integration manager (OpenCode V2)

Run `/raven-integrations` or `/raven integrations` to open Raven's searchable
integration manager. Remote MCPs, local stdio MCPs, and registered CLIs share one
list, labeled **MCP · HTTP**, **MCP · STDIO**, or **CLI**. Select an entry for actions:

- Sign in through the browser, continue a pending sign-in, or sign out.
- Refresh an MCP connection and discovered tools, or check a CLI executable.
- Enable or disable it immediately, saving the setting in Raven's configuration.
- View descriptions, discovered tool counts, executable paths, and errors in details.

Disabled entries are hidden by default; choose **Show disabled** to manage them.
**Ready · on demand** means MCP discovery succeeded; it does
not claim a permanent connection. **Connected** means Raven currently holds an
open connection. **Available** for a CLI means its executable and working directory
passed filesystem checks—not that an Editor/app is connected or authenticated.
No CLI command, help, or version probe runs during startup or refresh.
Choose **Refresh all integrations** or run `/raven integrations refresh`
to recheck enabled integrations. To check one, append its name or a typed ID
such as `mcp:basecamp` or `cli:unity` (required when names collide).
Disabling closes cached connections and cancels pending sign-in without deleting
saved credentials. Signing out asks for confirmation before clearing credentials.

The sign-in action opens the browser on the TUI's machine and also displays the
sign-in URL as a fallback. On a remote setup, the browser still needs access to the
server's loopback callback. Escape closes the manager; an explicit **Back** action
returns from an entry's action menu to the integration list.

Startup and refresh first show **Refreshing integrations…**, then a short success
message when checks pass; otherwise only affected integrations are listed with
type labels and concise failure reasons. A separate refresh error is reserved
for plugin/service/transport problems, not ordinary connection failures. Long failure lists are
capped; open the manager for full details. Disabled entries do not cause warnings.
`/raven` shows a compact model/integration overview and context-savings totals;
use `/raven route`, `/raven stats`, or entry details for expanded information.

This menu manages Raven's on-demand MCPs and registered CLIs. OpenCode's native
`/mcps` menu and globally registered servers are unchanged. OpenCode V1 supports
text-based `/raven integrations` and `/raven integrations refresh`.
The former `/raven-mcps` command has been removed; `/raven mcp` remains available
for MCP-specific commands and opens the unified manager on V2.

### OAuth sign-in

Remote on-demand MCPs support OAuth directly through Raven; they do not need to
be registered as global OpenCode MCPs. For example, merge Basecamp into the existing
`raven_act.onDemandMcpServers` configuration:

```jsonc
{
  "basecamp": {
    "enabled": true,
    "type": "remote",
    "url": "https://mcp.basecamp.com/mcp",
    "description": "Basecamp projects, to-dos, messages, and schedules."
  }
}
```

After loading the updated Raven configuration, run `/raven mcp auth basecamp`.
Open the displayed URL in a browser and approve access. Raven waits up to five
minutes for the loopback callback, exchanges the authorization code using PKCE,
then refreshes tool discovery and shows a completion notification. Startup probes
and agent calls never initiate an interactive sign-in; authentication failures
show the sign-in command instead. An expired access token is refreshed by the MCP
SDK when the server rejects it, if a valid refresh token is available.

OAuth is enabled by default for remote servers without an explicit `Authorization`
header. Set `"oauth": false` to disable it. Servers without dynamic registration
can use pre-registered client settings:

```jsonc
{
  "type": "remote",
  "url": "https://example.com/mcp",
  "oauth": {
    "clientId": "{env:MY_MCP_CLIENT_ID}",
    "clientSecret": "{env:MY_MCP_CLIENT_SECRET}",
    "scope": "read",
    "callbackPort": 19847
  }
}
```

All settings are optional. Public clients should omit `clientSecret`.
`clientMetadataUrl` is also supported for servers accepting URL-based client IDs.
For a pre-registered client, register `http://127.0.0.1:19847/oauth/callback` (or
your configured port). Otherwise Raven picks a free port on first sign-in and
reuses that port for subsequent sign-ins. The callback listener binds only to
`127.0.0.1`, validates a random state value, and closes on completion, cancellation,
timeout, or plugin unload. OAuth endpoints must use HTTPS, except loopback servers.
When OpenCode runs remotely, the browser must be able to reach its loopback
callback, for example through port forwarding.

Credentials are stored separately under `~/.config/opencode/opencode-raven/oauth/`,
with per-endpoint/client isolation and atomic writes. Files use owner-only Unix
permissions; on Windows they inherit the user's directory ACLs. They contain
unencrypted tokens and must be treated as secrets; they are not written to Raven's
configuration, generated guidance, or RPC output. Do not commit or share them.
Raven's OAuth sign-in is separate from OpenCode's native `/mcps` sign-in.

Use `/raven mcp logout basecamp` to cancel a pending sign-in, clear the saved
credentials, and close Raven's cached connections. Logout does not revoke the
provider's grant; revoke it in the provider's account settings if needed. Avoid
configuring the same server globally and on-demand, which exposes duplicate tools.

## On-Demand CLIs

Register trusted tools in `raven_act.onDemandClis` in the existing
`~/.config/opencode/opencode-raven/raven-config.json`. CLI and MCP definitions share
one operator configuration. A CLI needs no MCP server, bespoke integration,
installation, executable lookup, or startup help probe.

```json
{
  "raven_act": {
    "onDemandClis": {
      "unity": {
        "command": ["C:\\Tools\\UnityCLI\\unity-cli.exe"],
        "description": "Unity command-line automation",
        "instructions": "Use the installed tool's help to discover supported operations.",
        "helpArgs": ["--help"],
        "timeout": 300000
      },
      "blender": {
        "command": ["C:\\Program Files\\Blender Foundation\\Blender\\blender.exe"],
        "description": "Blender rendering and automation",
        "helpArgs": ["--help"],
        "timeout": 300000,
        "maxOutputBytes": 65536
      }
    }
  }
}
```

These are placeholder paths, not bundled integrations. Replace them with your
installed executables and supported help arguments. Any external CLI can be
registered, not just Unity or Blender. CLI names use letters, digits, `_`, or `-`.

| Definition field | Meaning |
|------------------|---------|
| `command` | Required argv prefix: executable followed by fixed arguments. Not a shell string. |
| `description` | Short capability summary shown to the calling model. |
| `instructions` | Optional detailed usage notes fetched by Act's CLI `describe` operation. |
| `enabled` | Defaults to `true`; `false` retains the definition without allowing calls. |
| `environment` | Extra environment values; inherits the service environment and supports `{env:NAME}`. Values are omitted from discovery output. |
| `cwd` | Default working directory, relative to the session directory or absolute. Supports `{env:NAME}`. |
| `helpArgs` | Defaults to `["--help"]`; replaces call arguments for `help`. `[]` is allowed. |
| `timeout` | Per-process timeout in **milliseconds**, default `120000`. |
| `maxOutputBytes` | Combined stdout/stderr cap, default `65536`, range `1024`–`10485760`. Excess output is drained and discarded, with truncation reported. |

Executable/fixed command arguments support `{env:NAME}` too. Call arguments are
literal strings: spaces stay inside each argument; pipes, wildcards, redirections,
and shell substitutions are not interpreted. For scripts, register the interpreter
explicitly, for example `["bun", "C:\\Tools\\my-cli.ts"]`. On Windows use an
executable/interpreter, not a bare `.cmd`, `.bat`, or PowerShell script.

You can register and manage tools without reloading OpenCode:

```text
/raven cli add blender {"command":["blender"],"description":"Blender rendering and automation"}
/raven cli
/raven cli disable blender
/raven cli enable blender
/raven cli remove blender
```

`add` refuses to overwrite an existing name. After editing the JSON yourself,
run `/raven cli reload` to apply registry and timeout changes immediately.
Disabling or removing a definition blocks subsequent calls; it does not cancel
an already-running process. Interrupt its Act child session to stop that work.
Invalid definitions fail closed without overwriting the configuration or
disabling working MCPs. Use `/raven act model <provider/model>` for the shared
operator model and `/raven act timeout <seconds>` for the overall task timeout.
Each CLI definition's `timeout` remains a per-process limit in milliseconds.

Ask the main agent for a specific operation, including input/output paths and
what may change. It delegates through:

```text
raven_act(query="Use registered blender in D:\\Art to render scene.blend to D:\\Art\\renders. Only create render outputs; do not overwrite the scene.")
```

Only the `raven-act` agent can use `raven_cli_bridge`. Its operations are
`list_tools`, `describe`, `help`, and `run`. Listing/description do not launch
processes. Help and execution use the registered executable, permission checks,
cancellation, a timeout, and bounded stdout/stderr with exit status. The caller
receives a compact summary and a resumable Act session ID, usable across MCP and
CLI follow-ups. Search session IDs remain separate.

**Execution keeps Raven's auto-approval.** Otherwise-asking checks inside Raven
Act are approved on V2; explicit denials still block execution. V1 and newer V2
hosts check the resolved executable/argv/cwd immediately before spawning. Older V2
hosts without `permission.assert` gate every bridge call (including discovery)
under `raven_cli_execute` instead. Permission rules may explicitly allow or deny
this action.

Registered CLIs are trusted local programs, **not a sandbox**: their arguments can
write files, execute scripts, reach the network, or change external state. Do not
register shell/interpreter wrappers unless you intend that access. Never put
secrets in descriptions, instructions, command arguments, or logs. Environment
values are not exposed by discovery, but the program itself may print them.
Cancellation, timeout, and plugin unload attempt to stop the process tree; they
cannot undo changes or stop work already submitted to external services. Raven
waits up to five seconds for termination after a stop request and reports
`terminationUnconfirmed` if cleanup cannot be confirmed. It never automatically
replays a failed or interrupted CLI operation.

## Routing

Default routed tools are `grep`, `glob`, `webfetch`, `fetch`, `websearch`, and search-like `bash` commands. On OpenCode 2, Raven also recognizes the native `shell` tool; `bash` and `shell` are routing aliases, so existing routing settings continue to work. Exact `excludeTools` entries use the host's actual tool name.

Local search tools route to `raven_seek`; `webfetch`, `fetch`, `websearch`, and recognized global MCP tools route to `raven_act`. Each route uses its target agent's configured model and recovery instructions.

Raven Act's prompt and capability guidance require MCP-first **online retrieval**: honor a suitable caller-named MCP; otherwise use Context7 for supported library/API documentation, Exa for web research, official-site discovery and page fetching (including documentation outside Context7 coverage), and Grep.app for public code examples. Exact URLs also use a suitable MCP fetch capability first. Built-in web tools remain available only as a reported fallback when no suitable MCP is available, retrieval fails, or evidence is insufficient. This is an agent instruction, not a runtime tool lock; local context retrieval and app/CLI operations do not require unrelated web research.

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

For blocked shell calls, the error identifies the matching search command and its original command fragment, even when it occurs late in a longer job. The whole tool call is blocked before execution; Raven does not automatically split or run any part of it. Delegate only the lookup to `raven_seek`, with its working directory and desired facts. Keep image generation, builds, and other non-retrieval work in the main agent's shell tool, preserving ordering, variable state, and exit-code dependencies when splitting mixed commands.

## Commands

| Command | Action |
|---------|--------|
| `/raven` | Compact models, typed integration statuses, and context-savings totals. |
| `/raven help` | Show command help. |
| `/raven route` | Show and edit routed tools and keywords. |
| `/raven-integrations` | Open the unified integration manager on V2 (also in the command palette). |
| `/raven integrations` | Open the integration manager on V2; show compact text status on V1. |
| `/raven integrations refresh [id]` | Check MCP connections and CLI executable availability; use `mcp:name` or `cli:name` to disambiguate. |
| `/raven mcp` | Open the unified manager on V2; show MCP-specific text status on V1. |
| `/raven mcp auth <server>` | Display a browser sign-in URL for a remote on-demand MCP. |
| `/raven mcp logout <server>` | Cancel sign-in, clear saved OAuth credentials, and close cached connections. |
| `/raven mcp refresh [server]` | Recheck MCP health and regenerate metadata. |
| `/raven mcp detail full|minimized` | Set generated guidance detail; restart afterward. |
| `/raven seek model <provider/model>\|auto` | Change or auto-detect the search model; restart afterward. |
| `/raven seek effort <value>` | Change search reasoning effort; restart afterward. |
| `/raven seek timeout <seconds>` | Change the search delegation timeout. |
| `/raven act` | Show the unified operator and its MCP/CLI capabilities. |
| `/raven act model <provider/model>\|auto` | Change or auto-detect the shared operator model; reload OpenCode afterward. |
| `/raven act effort <value>` | Change operator reasoning effort; reload OpenCode afterward. |
| `/raven act timeout <seconds>` | Change the shared MCP/CLI delegation timeout. |
| `/raven cli` | Show CLI status and registration help. |
| `/raven cli add <name> <JSON>` | Register a trusted executable/argv prefix without launching it. |
| `/raven cli enable\|disable\|remove <name>` | Manage registered CLIs immediately. |
| `/raven cli reload` | Validate and reload manually edited CLI definitions/timeouts. |
| `/raven stats` | Show estimated context avoided. |
| `/raven update` | Check npm, clear Raven's OpenCode package cache when needed, and show restart instructions. |

## Security And Privacy

Raven is optimized for autonomous retrieval and explicitly requested operations:

- Raven Search has read, search, unrestricted shell, external-directory, and globally configured MCP access without normal permission prompts.
- Raven Act has the same retrieval access as Raven Search, plus the internal MCP/CLI bridges. It can perform requested state-changing operations without normal confirmation prompts. Its MCP-first research instructions are not access restrictions.
- Both agents deny edit tools and nested delegation, but shell access is not a read-only sandbox and can modify the system. MCP tools may also modify external systems; V2 auto-approval trusts the Raven agents rather than enforcing read-only execution.
- Queries are sent to Raven's configured model provider.
- Remote MCP requests are sent to their services; local MCP entries launch local commands and inherit environment values.
- Startup performs an npm update check and probes enabled on-demand MCPs.
- Registered CLIs inherit the service environment and can modify files or external state. Registration and output limits are not a sandbox.

Review `Raven.md`, `RavenAct.md`, and your MCP/CLI commands before using Raven in sensitive environments.

## Context Estimates

`/raven stats` reports delegated-session context and avoided on-demand MCP schema bytes. These are heuristic estimates based on OpenCode token metadata and serialized schemas, not billing measurements or guaranteed savings.

## Troubleshooting

- First-time model warning: select a model in OpenCode's model picker, run `/raven seek model <provider/model>` and `/raven act model <provider/model>`, then reload OpenCode. Use `auto` as the model value to retry free-model detection.
- Search provider or quota failure: run `/raven seek model <provider/model>`, then restart OpenCode.
- Operator provider or quota failure: run `/raven act model <provider/model>`, then reload OpenCode.
- MCP failure: run `/raven mcp`, then `/raven mcp refresh <server>` after correcting its URL, command, environment, or credentials.
- OAuth required or expired: run `/raven mcp auth <server>` and approve access in the browser. If its callback port is busy, configure a free `oauth.callbackPort`. Use `/raven mcp logout <server>` to clear credentials and cancel an unfinished sign-in.
- Stale plugin version: run `/raven update`, restart OpenCode, and follow the cache-clearing instructions it prints if needed.
- Remove Raven: delete `"opencode-raven"` from `plugin`, restart, then optionally remove `~/.config/opencode/opencode-raven/`.

On OpenCode 2, remove it from `plugins` instead. `/raven update` uses v1 cache-clearing behavior only on OpenCode 1; on v2 it checks the version and provides restart/pinned-version instructions while leaving cache management to OpenCode.

## Development Checks

```sh
bun install
bun test
bun run typecheck
bun scripts/smoke-compat.ts v1 /path/to/opencode-v1
bun scripts/smoke-compat.ts v2 /path/to/opencode-v2
```

The native smoke checks use isolated configuration and data directories. The v2 check uses a deterministic local model endpoint to exercise routed main-agent search, direct Raven child search, delegation completion, and command/RPC output without calling a paid model provider.

See [CHANGELOG.md](CHANGELOG.md) for release history.

## Publishing

`.github/workflows/publish.yml` publishes through [npm trusted publishing](https://docs.npmjs.com/trusted-publishers), without a stored npm token. Bun runs checks and creates the package; npm on Node 24 handles the OIDC-authenticated upload.

Enable two-factor authentication on the npm owner account first (npm requires it to manage trusted publishers). Then use the package's **Settings → Trusted publishing**:

- Provider: **GitHub Actions**
- Organization/user: `evilayman`
- Repository: `opencode-raven`
- Workflow filename: `publish.yml`
- Environment: leave blank
- Allowed actions: enable **npm publish** for direct releases

Alternatively, configure the same trust relationship from an authenticated terminal:

```sh
bunx --bun npm trust github opencode-raven --repo evilayman/opencode-raven --file publish.yml --allow-publish --yes
```

Complete any account-side 2FA/browser approval yourself; do not put npm tokens, authenticator secrets, or recovery codes in the repository.

After the package version and changelog are committed to `master`, push a matching `v<version>` tag, or run **Publish npm package** manually on `master` from GitHub Actions. Tags must point to a commit on `master` and match the stable version in `package.json`. The manual option also releases a version whose tag predates this workflow.

The workflow checks types and existing tests, packs the package, and publishes once as `latest`. Existing versions are skipped without changing tags. A successful upload is not retried if registry validation or propagation is pending; the workflow summary distinguishes upload acceptance from verified availability.

## Disclaimer

opencode-raven is an independent project and is not affiliated with the OpenCode team. Released under the [MIT License](LICENSE).
