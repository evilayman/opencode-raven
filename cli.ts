import { z } from "zod"
import { delimiter, extname, isAbsolute, resolve } from "node:path"
import { accessSync, constants, statSync } from "node:fs"
import { spawn } from "node:child_process"

const text = z.string().refine((value) => !value.includes("\0"), "NUL bytes are not supported")
const milliseconds = z.number().int().min(1).max(2_147_483_647)

// No executable discovery or help probes occur while loading this registry.
export const cliDefinition = z.object({
  command: z.array(text).min(1).refine((parts) => !!parts[0].trim(), "Executable must not be empty"),
  description: z.string().optional(),
  instructions: z.string().optional(),
  enabled: z.boolean().optional(),
  environment: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), text).optional(),
  cwd: text.optional(),
  helpArgs: z.array(text).optional(),
  timeout: milliseconds.optional(),
  maxOutputBytes: z.number().int().min(1024).max(10_485_760).optional(),
}).strict()

export type CliDefinition = z.infer<typeof cliDefinition>

export function parseCliRegistry(value: unknown): Record<string, CliDefinition> {
  if (value === undefined) return {}
  const entries = z.record(z.string().regex(/^[a-zA-Z0-9_-]+$/), cliDefinition).parse(value)
  const names = new Set<string>()
  for (const name of Object.keys(entries)) {
    if (names.has(name.toLowerCase())) throw new Error(`Duplicate CLI name (case-insensitive): ${name}`)
    names.add(name.toLowerCase())
  }
  return entries
}

function expand(value: string): string {
  return value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => {
    if (process.env[name] === undefined) throw new Error(`Missing environment variable ${name}`)
    return process.env[name]!
  })
}

export function prepareCli(definition: CliDefinition, args: string[], directory: string, cwd?: string) {
  z.array(text).parse(args)
  if (cwd !== undefined) text.parse(cwd)
  const command = definition.command.map(expand)
  return {
    command: [...command, ...args],
    cwd: resolve(directory, expand(cwd ?? definition.cwd ?? ".")),
    env: { ...process.env, ...Object.fromEntries(Object.entries(definition.environment ?? {}).map(([key, value]) => [key, expand(value)])) },
  }
}

// Availability is a filesystem check, never a help/version probe or execution.
export function inspectCli(definition: CliDefinition, directory: string): { executable?: string; cwd?: string; error?: string } {
  try {
    const invocation = prepareCli(definition, [], directory)
    if (!statSync(invocation.cwd).isDirectory()) return { error: "Working directory is not a directory" }
    const command = invocation.command[0]
    const hasPath = isAbsolute(command) || /[\\/]/.test(command)
    const env = (name: string) => Object.entries(invocation.env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
    const paths = hasPath ? [resolve(invocation.cwd, command)]
      : (env("PATH") ?? "").split(delimiter).filter(Boolean).map((path) => resolve(invocation.cwd, path.replace(/^"|"$/g, ""), command))
    // Batch/PowerShell scripts cannot run under Raven's shell:false executor.
    const extensions = process.platform === "win32" && !extname(command) ? ["", ".exe", ".com"] : [""]
    for (const path of paths) {
      for (const extension of extensions) {
        const candidate = path + extension
        if (process.platform === "win32" && ![".exe", ".com"].includes(extname(candidate).toLowerCase())) continue
        try {
          if (!statSync(candidate).isFile()) continue
          accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK)
          return { executable: candidate, cwd: invocation.cwd }
        } catch { /* Try the next PATH candidate. */ }
      }
    }
    return { cwd: invocation.cwd, error: "Executable not found or not directly runnable; scripts need an explicit interpreter" }
  } catch (error) {
    // Do not echo expanded command arguments or environment values.
    return { error: error instanceof Error && error.message.startsWith("Missing environment variable ")
      ? error.message : "Working directory or CLI configuration is unavailable" }
  }
}

export type CliInvocation = ReturnType<typeof prepareCli>

export function cliExecutor() {
  const running = new Set<{ stop(): void; done: Promise<unknown> }>()
  let disposed = false
  return {
    async run(invocation: CliInvocation, definition: CliDefinition, signal: AbortSignal) {
      if (disposed) throw new Error("Raven CLI has been disposed")
      signal.throwIfAborted()
      const limit = definition.maxOutputBytes ?? 65_536
      const timeout = definition.timeout ?? 120_000
      let stdout = Buffer.alloc(0)
      let stderr = Buffer.alloc(0)
      let total = 0
      let truncated = false
      let timedOut = false
      let cancelled = false
      let terminationUnconfirmed = false
      let killTimer: ReturnType<typeof setTimeout> | undefined
      let finish!: (code: number | null) => void
      // Use argv directly, never a shell string. Scripts require an explicit
      // interpreter in command (for example ["bun", "/path/to/tool.ts"]).
      const child = spawn(invocation.command[0], invocation.command.slice(1), {
        cwd: invocation.cwd, env: invocation.env, shell: false,
        windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      })
      const done = new Promise<number | null>((accept, reject) => {
        finish = accept
        child.once("error", reject)
        child.once("close", accept)
      })
      const stop = () => {
        if (!child.pid || killTimer) return
        // Never let an unkillable process or inherited output handle make
        // cancellation/unload wait indefinitely. Report uncertainty explicitly.
        killTimer = setTimeout(() => {
          terminationUnconfirmed = true
          child.stdout.destroy()
          child.stderr.destroy()
          child.unref()
          finish(child.exitCode)
        }, 5000)
        if (process.platform === "win32") {
          if (child.exitCode !== null || child.signalCode !== null) {
            // Do not taskkill a potentially recycled PID after the parent exits.
            // Descendants may still own its output handles.
            return
          }
          // taskkill handles descendants too; never interpolate user arguments.
          const killer = spawn(`${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`, ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
          killer.once("error", () => { child.kill("SIGKILL") })
          killer.unref()
        } else {
          try { process.kill(-child.pid, "SIGKILL") } catch { child.kill("SIGKILL") }
        }
      }
      const job = { stop: () => { cancelled = true; stop() }, done }
      running.add(job)
      const collect = (chunk: Buffer, error: boolean) => {
        const kept = chunk.subarray(0, Math.max(0, limit - total))
        total += kept.length
        if (error) stderr = Buffer.concat([stderr, kept])
        else stdout = Buffer.concat([stdout, kept])
        if (kept.length < chunk.length) truncated = true
      }
      child.stdout.on("data", (chunk: Buffer) => collect(chunk, false))
      child.stderr.on("data", (chunk: Buffer) => collect(chunk, true))
      const abort = () => { cancelled = true; stop() }
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
      const timer = setTimeout(() => { timedOut = true; stop() }, timeout)
      try {
        const exitCode = await done
        return {
          exitCode, signal: child.signalCode, timedOut, cancelled, truncated, terminationUnconfirmed,
          stdout: stdout.toString("utf-8"), stderr: stderr.toString("utf-8"),
        }
      } finally {
        clearTimeout(timer)
        if (killTimer) clearTimeout(killTimer)
        signal.removeEventListener("abort", abort)
        running.delete(job)
      }
    },
    async dispose() {
      disposed = true
      for (const job of running) job.stop()
      await Promise.allSettled([...running].map((job) => job.done))
    },
  }
}
