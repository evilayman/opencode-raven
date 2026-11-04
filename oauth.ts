import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js"
import { OAuthClientInformationSchema, OAuthTokensSchema, type OAuthClientInformationMixed, type OAuthClientMetadata, type OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { join } from "node:path"

export interface McpOAuthOptions {
  clientId?: string
  clientSecret?: string
  clientMetadataUrl?: string
  scope?: string
  callbackPort?: number
}

interface Credentials {
  redirectUrl?: string
  client?: OAuthClientInformationMixed
  tokens?: OAuthTokens
}

export class McpAuthRequiredError extends Error {
  constructor(name: string) {
    super(`MCP ${name} needs authentication. Run /raven mcp auth ${name} to sign in.`)
    this.name = "McpAuthRequiredError"
  }
}

// Each endpoint/client configuration has its own credentials. Tokens never enter
// raven-config.json, generated metadata, RPC responses, or model context.
class McpOAuthProvider implements OAuthClientProvider {
  private verifier?: string
  private discovery?: OAuthDiscoveryState
  private valid = true
  authorizationUrl?: string
  interactive?: { redirectUrl: string; state: string }

  constructor(readonly name: string, readonly file: string, readonly options: McpOAuthOptions) {}

  private read(): Credentials {
    if (!this.valid) throw new McpAuthRequiredError(this.name)
    try {
      const value = JSON.parse(readFileSync(this.file, "utf-8"))
      const redirect = value.redirectUrl ? new URL(value.redirectUrl) : undefined
      if (redirect && (redirect.protocol !== "http:" || redirect.hostname !== "127.0.0.1"
        || redirect.pathname !== "/oauth/callback" || !redirect.port || redirect.search || redirect.hash || redirect.username || redirect.password)) {
        throw new Error("Invalid callback URL")
      }
      return {
        redirectUrl: redirect?.href,
        client: value.client ? OAuthClientInformationSchema.parse(value.client) : undefined,
        tokens: value.tokens ? OAuthTokensSchema.parse(value.tokens) : undefined,
      }
    } catch (error: any) {
      if (error?.code === "ENOENT") return {}
      // Do not include parser errors: they can contain credential values.
      throw new Error(`Cannot read OAuth credentials for ${this.name}. Use /raven mcp logout ${this.name} to clear them.`)
    }
  }

  private write(value: Credentials) {
    if (!this.valid) throw new McpAuthRequiredError(this.name)
    const temporary = `${this.file}.${randomBytes(8).toString("hex")}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" })
      renameSync(temporary, this.file)
      chmodSync(this.file, 0o600)
    } finally {
      try { unlinkSync(temporary) } catch (error: any) { if (error?.code !== "ENOENT") throw error }
    }
  }

  get redirectUrl() { return this.interactive?.redirectUrl ?? this.read().redirectUrl ?? "http://127.0.0.1:19847/oauth/callback" }
  get callbackPort() { const redirect = this.read().redirectUrl; return redirect ? Number(new URL(redirect).port) : 0 }
  get clientMetadataUrl() { return this.options.clientMetadataUrl }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Raven for OpenCode", redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
      token_endpoint_auth_method: this.options.clientSecret ? "client_secret_post" : "none",
      ...(this.options.scope ? { scope: this.options.scope } : {}),
    }
  }
  state() {
    if (!this.interactive) throw new McpAuthRequiredError(this.name)
    return this.interactive.state
  }
  clientInformation() {
    // A health probe may refresh saved tokens but must not register clients or
    // begin an interactive grant, even when the SDK encounters a 401.
    const saved = this.read()
    if (!this.interactive && !saved.tokens) throw new McpAuthRequiredError(this.name)
    return this.options.clientId
      ? { client_id: this.options.clientId, ...(this.options.clientSecret ? { client_secret: this.options.clientSecret } : {}) }
      : saved.client
  }
  saveClientInformation(client: OAuthClientInformationMixed) { this.write({ ...this.read(), client }) }
  tokens() { return this.read().tokens }
  saveTokens(tokens: OAuthTokens) { this.write({ ...this.read(), tokens }) }
  redirectToAuthorization(url: URL) {
    if (!this.interactive) throw new McpAuthRequiredError(this.name)
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) {
      throw new Error("OAuth authorization requires HTTPS (except loopback servers).")
    }
    this.authorizationUrl = url.href
  }
  saveCodeVerifier(value: string) {
    if (!this.interactive) throw new McpAuthRequiredError(this.name)
    this.verifier = value
  }
  codeVerifier() {
    if (!this.verifier) throw new Error("OAuth sign-in expired. Start a new sign-in.")
    return this.verifier
  }
  discoveryState() { return this.discovery }
  saveDiscoveryState(value: OAuthDiscoveryState) { this.discovery = value }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all" || scope === "discovery") this.discovery = undefined
    if (scope === "all" || scope === "verifier") this.verifier = undefined
    if (scope === "discovery" || scope === "verifier") return
    const saved = this.read()
    if (scope === "all" || scope === "client") delete saved.client
    if (scope === "all" || scope === "tokens") delete saved.tokens
    this.write(saved)
  }
  prepareSignIn(redirectUrl: string, state: string) {
    const saved = this.read()
    if (saved.redirectUrl !== redirectUrl) delete saved.client
    delete saved.tokens
    this.write({ ...saved, redirectUrl })
    this.interactive = { redirectUrl, state }
  }
  stop() { this.valid = false; this.verifier = undefined; this.interactive = undefined }
  clear() {
    this.stop()
    try { unlinkSync(this.file) } catch (error: any) { if (error?.code !== "ENOENT") throw error }
  }
}

type SignIn = { authorizationUrl: string; completed: Promise<void> }
type Attempt = { controller: AbortController; ready: Promise<SignIn> }

export class McpOAuth {
  private providers = new Map<string, McpOAuthProvider>()
  private attempts = new Map<string, Attempt>()

  constructor(private directory: string) {}

  private key(name: string, url: string, options: McpOAuthOptions) {
    return createHash("sha256").update(JSON.stringify([name.toLowerCase(), new URL(url).href,
      options.clientId, options.clientSecret, options.clientMetadataUrl, options.scope, options.callbackPort])).digest("hex")
  }
  provider(name: string, url: string, options: McpOAuthOptions = {}): OAuthClientProvider {
    const key = this.key(name, url, options)
    let provider = this.providers.get(key)
    if (!provider) {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      provider = new McpOAuthProvider(name, join(this.directory, `${key}.json`), options)
      this.providers.set(key, provider)
    }
    return provider
  }

  signIn(name: string, url: string, options: McpOAuthOptions = {}): Promise<SignIn> {
    const key = this.key(name, url, options)
    const existing = this.attempts.get(key)
    if (existing) return existing.ready
    const attempt = { controller: new AbortController() } as Attempt
    this.attempts.set(key, attempt)
    attempt.ready = this.start(name, url, options, attempt.controller).then((result) => {
      // Install rejection handlers before returning the background completion.
      void result.completed.catch(() => {}).finally(() => {
        if (this.attempts.get(key) === attempt) this.attempts.delete(key)
      })
      return result
    }).catch((error) => {
      if (this.attempts.get(key) === attempt) this.attempts.delete(key)
      throw error
    })
    return attempt.ready
  }

  private async start(name: string, url: string, options: McpOAuthOptions, controller: AbortController): Promise<SignIn> {
    const cached = this.provider(name, url, options) as McpOAuthProvider
    const provider = new McpOAuthProvider(name, cached.file, options)
    const discovery = cached.discoveryState()
    if (discovery) provider.saveDiscoveryState(discovery)
    const state = randomBytes(32).toString("hex")
    const port = options.callbackPort ?? provider.callbackPort
    const timer = setTimeout(() => controller.abort(new Error("OAuth sign-in timed out. Run the auth command again.")), 5 * 60_000)
    timer.unref?.()
    const signal = controller.signal
    let server: Server | undefined
    const cleanup = () => {
      clearTimeout(timer)
      server?.close()
      server?.closeAllConnections()
      provider.stop()
    }
    // OAuth discovery and token exchange must also stop on timeout/logout.
    const fetchFn = (input: string | URL, init?: RequestInit) => {
      const target = new URL(input)
      if (target.username || target.password || (target.protocol !== "https:"
        && !(target.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)))) {
        throw new Error("OAuth endpoints require HTTPS (except loopback servers).")
      }
      return fetch(input, { ...init, redirect: "error", signal: AbortSignal.any([
        signal, AbortSignal.timeout(30_000), ...(init?.signal ? [init.signal] : []),
      ]) })
    }
    let rejectCode!: (reason: unknown) => void
    let acceptCode!: (code: string) => void
    const code = new Promise<string>((resolve, reject) => { acceptCode = resolve; rejectCode = reject })
    void code.catch(() => {})
    const abort = () => {
      rejectCode(signal.reason ?? new Error("OAuth sign-in cancelled."))
      cleanup()
    }
    signal.addEventListener("abort", abort, { once: true })
    try {
      signal.throwIfAborted()
      let received = false
      server = createServer((request, response) => {
        response.setHeader("Content-Type", "text/plain; charset=utf-8")
        response.setHeader("Cache-Control", "no-store")
        response.setHeader("Referrer-Policy", "no-referrer")
        const callback = new URL(provider.redirectUrl)
        let incoming: URL
        try { incoming = new URL(request.url ?? "/", callback.origin) }
        catch { response.writeHead(400).end("Invalid OAuth callback."); return }
        const incomingState = Buffer.from(incoming.searchParams.get("state") ?? "")
        const expected = Buffer.from(state)
        if (request.method !== "GET" || request.headers.host !== callback.host || incoming.origin !== callback.origin
          || incoming.pathname !== callback.pathname || incomingState.length !== expected.length || !timingSafeEqual(incomingState, expected)) {
          response.writeHead(400).end("Invalid OAuth callback.")
          return
        }
        if (received) { response.writeHead(409).end("Authorization already received."); return }
        const authorizationCode = incoming.searchParams.get("code")
        if (incoming.searchParams.has("error")) {
          received = true
          response.end("Authorization was declined. Return to OpenCode and start a new sign-in.")
          rejectCode(new Error("OAuth authorization was declined. Run the auth command to try again."))
        } else if (!authorizationCode || authorizationCode.length > 8192) {
          response.writeHead(400).end("Missing authorization code.")
        } else {
          received = true
          response.end("Authorization received. Return to OpenCode to confirm sign-in.")
          acceptCode(authorizationCode)
        }
      })
      server.on("error", rejectCode)
      await new Promise<void>((resolve, reject) => {
        const cancel = () => reject(new Error("OAuth sign-in cancelled."))
        signal.addEventListener("abort", cancel, { once: true })
        const failed = (error: Error) => { signal.removeEventListener("abort", cancel); reject(error) }
        server!.once("error", failed)
        server!.listen({ host: "127.0.0.1", port, signal }, () => {
          signal.removeEventListener("abort", cancel)
          server!.off("error", failed)
          resolve()
        })
      })
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("Cannot start OAuth callback listener.")
      provider.prepareSignIn(`http://127.0.0.1:${address.port}/oauth/callback`, state)
      const result = await auth(provider, { serverUrl: url, scope: options.scope, fetchFn })
      if (result !== "REDIRECT" || !provider.authorizationUrl) throw new Error("OAuth server did not return a sign-in URL.")
      const completed = (async () => {
        try {
          const authorizationCode = await code
          signal.throwIfAborted()
          const result = await auth(provider, { serverUrl: url, authorizationCode, fetchFn })
          if (result !== "AUTHORIZED") throw new Error("OAuth sign-in did not complete.")
        } catch {
          throw new Error(`OAuth sign-in to ${name} was cancelled, declined, expired, or failed. Run /raven mcp auth ${name} to retry.`)
        } finally {
          signal.removeEventListener("abort", abort)
          cleanup()
        }
      })()
      return { authorizationUrl: provider.authorizationUrl, completed }
    } catch (error) {
      controller.abort()
      signal.removeEventListener("abort", abort)
      cleanup()
      // OAuth server error bodies can contain secrets. Expose only safe guidance.
      if ((error as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
        throw new Error(`OAuth callback port ${port} is in use. Set a free oauth.callbackPort for ${name} and retry.`)
      }
      throw new Error(`Cannot start OAuth sign-in for ${name}. Check its URL, OAuth client settings, and callback port.`)
    }
  }

  logout(name: string, url: string, options: McpOAuthOptions = {}) {
    const key = this.key(name, url, options)
    this.cancel(name, url, options)
    const provider = this.provider(name, url, options) as McpOAuthProvider
    provider.clear()
    this.providers.delete(key)
  }

  cancel(name: string, url: string, options: McpOAuthOptions = {}) {
    const key = this.key(name, url, options)
    this.attempts.get(key)?.controller.abort(new Error("OAuth sign-in cancelled."))
    this.attempts.delete(key)
  }

  async status(name: string, url: string, options: McpOAuthOptions = {}) {
    return {
      authorizing: this.attempts.has(this.key(name, url, options)),
      authenticated: !!(await this.provider(name, url, options).tokens()),
    }
  }

  dispose() {
    for (const attempt of this.attempts.values()) attempt.controller.abort(new Error("Raven unloaded; OAuth sign-in cancelled."))
    this.attempts.clear()
    for (const provider of this.providers.values()) provider.stop()
    this.providers.clear()
  }
}
