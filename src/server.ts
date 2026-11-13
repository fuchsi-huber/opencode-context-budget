import type { Plugin, ToolContext } from "@opencode-ai/plugin"
import {
  formatSnapshot,
  formatThresholdNotice,
  nextAutomaticThreshold,
  snapshotFromMessages,
  thresholdFor,
} from "./lib/context-budget.ts"

const TOOL_DESCRIPTION =
  "Return the context-window usage shown in the UI sidebar: used tokens, context limit, remaining tokens, percentage, the next automatic warning threshold, and when the value was last updated. Use this before large reads, edits, or long multi-step tasks when you need to know how much context remains."

type SessionState = {
  threshold: number
}

export default (async ({ client }) => {
  const sessions = new Map<string, SessionState>()

  async function load(sessionID: string) {
    const [messages, providers] = await Promise.all([
      client.session.messages({ path: { id: sessionID } }),
      client.config.providers(),
    ])

    if (!messages.data) throw new Error("OpenCode returned no session messages")

    return {
      entries: messages.data,
      providers: providers.data?.providers ?? [],
    }
  }

  return {
    tool: {
      context_remaining: {
        description: TOOL_DESCRIPTION,
        args: {},
        async execute(_args: Record<string, never>, context: ToolContext) {
          try {
            const { entries, providers } = await load(context.sessionID)
            const snapshot = snapshotFromMessages(entries, providers)
            if (!snapshot) {
              return "No context usage has been reported in this session yet. The UI sidebar also has no context value until a model request reports token usage."
            }
            const nextNotice = nextAutomaticThreshold(
              snapshot.percent,
              sessions.get(context.sessionID)?.threshold ?? 0,
            )
            return formatSnapshot(snapshot, nextNotice)
          } catch (error) {
            return `Unable to read context usage: ${error instanceof Error ? error.message : String(error)}`
          }
        },
      },
    },

    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return

      try {
        const { entries, providers } = await load(input.sessionID)
        const snapshot = snapshotFromMessages(entries, providers)
        if (!snapshot || snapshot.percent === undefined) return

        const previousThreshold = sessions.get(input.sessionID)?.threshold ?? 0
        const reached = thresholdFor(snapshot.percent)
        if (reached === undefined || reached <= previousThreshold) return

        sessions.set(input.sessionID, { threshold: reached })
        output.system.push(formatThresholdNotice(snapshot, reached))
      } catch {
        // Context reporting must never break a model request.
      }
    },

    event: async ({ event }) => {
      if (event.type === "session.compacted") sessions.delete(event.properties.sessionID)
      if (event.type === "session.deleted") sessions.delete(event.properties.info.id)
    },
  }
}) satisfies Plugin
