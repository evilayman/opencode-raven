import type { Plugin as V1Plugin } from "@opencode-ai/plugin"
import type { Plugin as V2Plugin } from "@opencode/plugin"
import createRavenRuntime from "./raven-core"

// Object entrypoints are supported by OpenCode 1.18.29+. Each host selects its
// own lifecycle; the v2 SDK is never loaded by a v1 installation.
export default {
  id: "opencode-raven",
  server: (async (input) => createRavenRuntime(input)) satisfies V1Plugin,
  async setup(context) {
    const { setupRaven } = await import("./v2")
    return setupRaven(context)
  },
} satisfies V2Plugin.Plugin & { server: V1Plugin }
