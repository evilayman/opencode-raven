## Raven Search and Act guidance

Raven Search retrieves local evidence. Raven Act operates apps, websites, and tools
through MCP and registered CLI adapters, including online research and explicitly
requested state-changing work. The calling agent retains planning, code review,
auditing, correctness judgments, and final recommendations.

Non-Raven agents use `raven_seek` for narrowly scoped local evidence retrieval: file search, filesystem discovery, and command-output inspection. Use it when a local search tool or search-like shell command is blocked. Include the original tool intent and relevant arguments. Do not delegate an entire review or general task.

When a blocked shell call mixes search with other execution, use the error's identified search fragments to formulate only the evidence lookup. The whole blocked call has not executed. Do not send the entire command to Raven; keep image generation, builds, and other non-retrieval work in the main agent's shell tool. Preserve ordering, variable state, exit codes, and required steps when separating the lookup from execution.

Use `raven_act` for research and operations on apps, websites, and tools. Include
the target service or registered CLI, task, paths, and authorized changes.
MCP (HTTP/SSE/stdio) and CLI are transport adapters, not separate agents.
The same Act session can use both; the operator discovers detailed schemas/help
only as needed. Only `raven-act` calls `raven_mcp_bridge` and `raven_cli_bridge`.

When `websearch`, `webfetch`, `fetch`, or a global MCP tool is blocked, retry through `raven_act`, not `raven_seek`. For online retrieval, Act attempts suitable MCPs first: honor a suitable caller-named MCP; otherwise Context7 for supported library/API docs, Exa for web research/page fetching, and Grep.app for public code examples. Built-in web fallbacks require a reported failure or coverage gap. App/CLI operations do not require unrelated web research.

Act preserves Raven's auto-approval: otherwise-asking checks are approved while
explicit denials remain final. MCPs and CLIs may modify local or external state.
Stay within the user's request; never automatically replay uncertain operations.
Reuse `sessionId` for related follow-ups across either bridge. Never pass session
IDs between `raven_seek` and `raven_act`, or repeat a pending request.

Appropriate `raven_seek` requests:

- Find definitions, references, files, or concrete code locations.
- Inspect bounded command output or local system facts.

Appropriate `raven_act` requests:

- Fetch and extract facts from a specific URL.
- Search current web, documentation, or public GitHub sources.
- Retrieve information through global or on-demand MCP capabilities, using local files for context when needed.
- Perform a requested app/service operation through MCP or a registered CLI.
- Combine MCP and CLI steps in one explicitly scoped task.

Inappropriate Search delegation (the caller retains these responsibilities):

- Review or audit this codebase.
- Decide whether an implementation is correct or secure.
- Plan or implement a feature.
- Diagnose a bug beyond retrieving requested evidence.

Examples:

`raven_seek(query="Find every caller of validateToken and return file/line locations")`

`raven_act(query="Use Exa to fetch/read https://example.com and extract the documented install flags")`

`raven_act(query="Use registered blender to render scene.blend into renders/; do not overwrite the scene")`

Simple piped output filters like `command | grep ...`, `command | rg ...`, `command | findstr ...`, or `command | head ...` are allowed when they only filter bounded output from the immediately preceding command.
