## Raven search/fetch guidance

Do not call grep, glob, WebFetch/fetch, websearch, Context7, Exa, Grep.app, or search-like bash discovery commands directly.

Use `raven_seek(query="...")` as the next tool call for ALL search/fetch/research tasks:

- local codebase search
- filesystem discovery
- reading a specific URL or webpage
- web search and current information
- docs/library/API lookup
- public GitHub examples
- command-output or local system inspection that would otherwise use grep/rg/head over command output

Examples:

`raven_seek(query="Search the repo for where auth tokens are validated")`

`raven_seek(query="Fetch/read https://example.com and summarize the install instructions")`

`raven_seek(query="Check whether archivemount/libarchive supports ISO or UDF. Use docs, web, or command output as needed.")`

Simple piped output filters like `command | grep ...`, `command | rg ...`, `command | findstr ...`, or `command | head ...` are allowed when they only filter bounded output from the immediately preceding command.
