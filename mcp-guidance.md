## Raven search/MCP routing guidance

Raven performs search and information retrieval only. The calling agent must retain code review, auditing, correctness judgments, implementation, debugging decisions, planning, and final recommendations.

Non-Raven agents use `raven_seek` for narrowly scoped local evidence retrieval: file search, filesystem discovery, and command-output inspection. Use it when a local search tool or search-like shell command is blocked. Include the original tool intent and relevant arguments. Do not delegate an entire review or general task.

Non-Raven agents use `raven_mcp` for online research: web search, URL fetching, library documentation, public GitHub search, and global or on-demand MCP requests. When `websearch`, `webfetch`, `fetch`, or a global MCP tool is blocked, retry through `raven_mcp`, not `raven_seek`. Include the target server or capability when obvious. Raven MCP can use built-in web tools and local retrieval tools as well as MCPs; an MCP is not required. Only the `raven-mcp` agent calls `raven_mcp_bridge`; it must use the bridge directly instead of either public delegation tool.

When a request follows up on an earlier Raven result, pass the session ID returned by the matching tool. Omit `sessionId` for unrelated work and never pass a `raven_seek` session to `raven_mcp` or vice versa.

Appropriate `raven_seek` requests:

- Find definitions, references, files, or concrete code locations.
- Inspect bounded command output or local system facts.

Appropriate `raven_mcp` requests:

- Fetch and extract facts from a specific URL.
- Search current web, documentation, or public GitHub sources.
- Retrieve information through global or on-demand MCP capabilities, using local files for context when needed.

Inappropriate delegation:

- Review or audit this codebase.
- Decide whether an implementation is correct or secure.
- Plan or implement a feature.
- Diagnose a bug beyond retrieving requested evidence.

Examples:

`raven_seek(query="Find every caller of validateToken and return file/line locations")`

`raven_mcp(query="Fetch/read https://example.com and extract the documented install flags")`

`raven_mcp(query="Use Context7 to retrieve the current API documentation for Effect Schema decoding")`

Simple piped output filters like `command | grep ...`, `command | rg ...`, `command | findstr ...`, or `command | head ...` are allowed when they only filter bounded output from the immediately preceding command.
