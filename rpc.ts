import type { Rpc } from "@opencode/plugin"
import { z } from "zod"

// Portable contract shared by the v2 server, terminal companion, and clients.
export const RavenRpc = {
  id: "opencode-raven",
  methods: {
    command: {
      input: z.object({ arguments: z.string() }),
      output: z.object({ text: z.string() }),
    },
  },
  events: {
    notice: {
      schema: z.object({
        kind: z.enum(["command", "toast"]),
        message: z.string(),
        title: z.string().optional(),
        sessionID: z.string().optional(),
        variant: z.enum(["info", "success", "warning", "error"]).optional(),
        duration: z.number().optional(),
      }),
    },
  },
} as const satisfies Rpc.PortableDefinition

export default RavenRpc
