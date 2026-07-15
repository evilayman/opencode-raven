import { Database } from "bun:sqlite"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir, tmpdir } from "node:os"

const DB = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "opencode.db")
const LOG = join(tmpdir(), "raven-sessions.log")

// ── Resolve session ID ──
const arg = Bun.argv[2]
let SID: string | null = null

if (arg && /^ses_[A-Za-z0-9]+$/.test(arg)) {
  SID = arg
  console.log(`=== Manual session: ${SID} ===\n`)
} else {
  try {
    const log = readFileSync(LOG, "utf-8")
    const lines = log.trim().split("\n")
    const last = lines[lines.length - 1]
    const m = last.match(/ (ses_\w+)(?:\s|$)/)
    if (m) {
      SID = m[1]
      console.log(`=== Latest session: ${SID} ===\n`)
    }
  } catch {}
}

if (!SID) {
  console.error("No session found. Usage: bun scripts/debug-raven.ts [session-id]")
  process.exit(1)
}

const db = new Database(DB, { readonly: true })

// ── Show parts (tool calls, reasoning, text) ──
const parts = db.query("SELECT * FROM part WHERE session_id = ? ORDER BY time_created").all(SID)
console.log(`Parts: ${parts.length}\n`)

for (const p of parts) {
  const data = JSON.parse((p as any).data)
  const ts = new Date((p as any).time_created).toISOString()
  if (data.type === "tool") {
    const s = data.state || {}
    const start = s.time?.start || 0
    const end = s.time?.end || (s.status === "running" ? Date.now() : start)
    const elapsed = ((end - start) / 1000).toFixed(1)
    const marker = s.status === "running" ? "⚠ RUNNING" : s.status === "error" ? "✖ ERROR" : "✓"
    console.log(`[${ts}] ${marker} ${data.tool} | ${elapsed}s`)
    if (s.input) {
      const inp = s.input
      const cmd = inp.command || inp.pattern || inp.filePath || JSON.stringify(inp)
      console.log(`  ${String(cmd).slice(0, 200)}`)
    }
    if (s.error) console.log(`  error: ${s.error}`)
    if (s.metadata?.interrupted) console.log(`  (aborted)`)
    if (s.output && s.output !== "(no output)") {
      const out = String(s.output).slice(0, 300)
      console.log(`  output: ${out}`)
    }
  } else if (data.type === "reasoning") {
    console.log(`[${ts}] 💭 ${String(data.text).slice(0, 200)}`)
  } else if (data.type === "text") {
    console.log(`[${ts}] 📝 ${String(data.text).slice(0, 300)}`)
  }
}

// ── Show message summary ──
const msgs = db.query("SELECT * FROM message WHERE session_id = ? ORDER BY time_created").all(SID)
console.log(`\nMessages: ${msgs.length}`)
for (const m of msgs) {
  const data = JSON.parse((m as any).data)
  const error = data.error ? ` [${data.error.name}: ${data.error.data?.message}]` : ""
  console.log(`  ${data.role}${error}`)
}
