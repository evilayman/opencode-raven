# Changelog

## 1.2.5

### Added
- **`/raven update`** — checks npm for a newer Raven version, clears opencode's cached Raven plugin package when needed, and prompts the user to restart.
- **Startup update notification** — Raven checks npm at startup and shows a TUI toast when an update is available.
- **Config auto-migration** — existing `raven-config.json` files are normalized on startup so newly-added default fields are populated automatically.

### Changed
- **Update docs** — README now includes `/raven update`, manual `bun`/`npm` update commands, and opencode cache-clearing instructions.

## 1.2.4

### Added
- **Session tree visibility** — Raven sessions created by `raven_seek` now appear in the session tree (`Ctrl+X Down`) via `parentID` linking.

### Changed
- **`tool.execute.after`** — no longer a stub; now counts output bytes from direct `@Raven` task calls for accurate stats.

## 1.2.3

### Added
- **`raven_seek` timeout** — configurable timeout (default 180s). Session kept alive on timeout for inspection. `/raven timeout <seconds>` command.
- **Session debugger** — `scripts/debug-raven.ts` auto-detects the latest session and shows tool calls, timing, status, and errors.

### Changed
- **`raven_seek` timing** — every response includes elapsed time and token count.

### Fixed
- **`cmd /c` bypass** — `cmd /c dir`, `cmd /c findstr`, `cmd /c find`, `cmd /c where`, `cmd /c tree` now blocked.
- **`raven_seek` wording** — tool description, reroute messages, and guidance clarify Raven handles ALL search types (local codebase, web, docs, GitHub).
- **Case-insensitive bash blocking** — `SEARCH_BASH_RE` now case-insensitive.
- **Unrestricted bash for Raven** — `bash: allow` instead of restrictive whitelist. Raven can now use `dir`, `ls`, `Get-ChildItem` for fast filesystem searches instead of slow `glob`.
- **External directory access** — `external_directory: allow` prevents silent permission-prompt hangs in `raven_seek` sessions.

## 1.2.2

### Added
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
