## Raven tool/MCP routing guidance

Do not call tools or MCPs that Raven blocks directly. Raven may route search/fetch tools, docs/web/GitHub MCPs, user-configured tool/MCP prefixes, or on-demand MCP capabilities through `raven_seek` to save context.

Use `raven_seek(query="...")` as the next tool call for blocked tool/MCP requests. Include the original tool/MCP name, intent, and relevant arguments.

When a request follows up on an earlier Raven result, pass the Raven session ID returned by that call as `sessionId` so Raven retains its research context. Omit `sessionId` for unrelated work.

For on-demand MCP requests, include the target MCP server and likely tool name in the `raven_seek` query when the listed capabilities make that obvious. Do not call `raven_mcp` directly unless you are Raven.

Raven commonly handles:

- local codebase search
- filesystem discovery
- reading a specific URL or webpage
- web search and current information
- docs/library/API lookup
- public GitHub examples
- user-configured MCP requests
- on-demand MCPs configured in Raven, without exposing their full schemas to the main session
- command-output or local system inspection that would otherwise use grep/rg/head over command output

Examples:

`raven_seek(query="Search the repo for where auth tokens are validated")`

`raven_seek(query="Fetch/read https://example.com and summarize the install instructions")`

`raven_seek(query="Check whether archivemount/libarchive supports ISO or UDF. Use docs, web, or command output as needed.")`

`raven_seek(query="Use the Linear MCP to find open bugs assigned to me and summarize the top 3")`

`raven_seek(query="Compare the first two bugs in more detail", sessionId="ses_...")`

Simple piped output filters like `command | grep ...`, `command | rg ...`, `command | findstr ...`, or `command | head ...` are allowed when they only filter bounded output from the immediately preceding command.
