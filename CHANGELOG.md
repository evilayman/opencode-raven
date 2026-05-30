# Changelog

## 1.2.2

### Added
- **`excludeTools`** — per-tool allowlist in config. Tools listed never get blocked.
- **`websearch`** — built-in web search tool now intercepted.
- **Session + global stats** — session counter (resets on restart) and all-time counter (persists).

### Changed
- **Stats refactored** — tracks `raven_seek` context processed (actual output size) instead of blocked tool counts and estimates. Cleaner, more meaningful.
- **No more error throttling** — full `REROUTE_MSG` on every blocked tool call.
- **Bytes from real measurements only** — dropped static estimates, numbers reflect actual Raven output.

## 1.2.1

### Added
- **`/raven stats`** — per-session and global tracking of blocked calls, bytes saved, and token estimates. Global stats persist across restarts.
- **`excludeTools`** — per-tool allowlist in config. Tools listed in `excludeTools` never get blocked, even for non-excluded agents.

## 1.2.0

### Added
- **Agent allowlist** — `excludeAgents` in config lets specific agents bypass search tool blocking and prompt injection (case-insensitive).
- **WebFetch/fetch blocking** — `webfetch` and `fetch` tools are now intercepted, routing all web page fetches through Raven.
- **Reasoning effort config** — `reasoning_effort` in config overrides Raven.md default. `/raven effort <value>` command.
- **Error recovery in raven_seek** — rate limits, quota exhaustion, token overflow, model unavailable, and timeouts return actionable recovery guidance instead of raw errors.
- **Parallel search in Raven** — Raven.md instructs Raven to run independent tool calls in parallel within a single session.
- **Global config** — config moved to `~/.config/opencode/raven-config.json`, shared across all projects. Auto-creates on first run.

### Changed
- **raven_seek is primary path** — all guidance now points to `raven_seek` only. `task(subagent_type="raven")` delegation path removed from instructions.
- **Subagent prompt injection** — `<raven_guidance>` injected into every non-Raven, non-excluded subagent prompt at spawn time via `task`/`subtask` hooks.
- **Throttled error messages** — full error shown once per session, silent on repeats. Prevents context flooding.
- **Improved error message** — clean `REROUTE_MSG` with actionable `raven_seek` path.

### Fixed
- **Bash false positives** — quoted content stripped before regex matching. `echo "use grep here"` no longer triggers blocking.
- **Allowlist reliability** — `sessionAgents` map tracks session→agent for reliable allowlist lookups (vs `input.agent` which isn't populated on `tool.execute.before`).

### Removed
- **Dead `tool.execute.after` nullify code** — replaced with stub for future analytics.

## 1.1.1

### Added
- `raven_seek` tool — fallback for agents that can't use `task` delegation.
- MCP API key configuration instructions in README.

### Changed
- README restructured with image-left, text-right header.

### Fixed
- Exa MCP works without API key.
- MCP table shows Context7 and Exa offer higher limits with free keys.

## 1.0.0

- Initial release. Search tool interception, Raven subagent, Context7/Exa/Grep.app MCPs.
