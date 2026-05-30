## MCP usage guidance — delegate to Raven (subagent_type="raven") for these:

- **Context7** — library/framework/SDK/API docs. Prefer over memory when docs may be version-specific or recently changed.
- **Exa AI** — live web search, news, company/product research, webpages, tool comparisons. Use when answers depend on recent updates, pricing, releases, or online sources.
- **Grep.app** — public GitHub code examples, real-world usage patterns, config examples. Use when docs are unclear or implementation examples would help.

## Built-in search tools (grep, glob, search-like bash) are blocked and routed to Raven automatically.

Use task(subagent_type="raven") to delegate search to Raven.
If task delegation is unavailable, use the raven_seek tool as a fallback.
