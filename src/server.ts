import type { Plugin, ToolContext } from "@opencode-ai/plugin"
import {
  compactionPlan,
  deliberateCompactionAvailable,
  describeDeliberateThreshold,
  formatCompactionPolicy,
  formatDeliberateCompaction,
  formatSnapshot,
  formatThresholdNotice,
  formatTokens,
  nextAutomaticThreshold,
  snapshotFromMessages,
  thresholdFor,
  type CompactionSettings,
  type DeliberateCompactionConfig,
  type MessageEntryLike,
  type ContextSnapshot,
} from "./lib/context-budget.ts"

const TOOL_DESCRIPTION =
  "Return the context-window usage shown in the UI sidebar: used tokens, context limit, remaining tokens, percentage, the next automatic warning threshold, automatic compaction status, and when the value was last updated. Use this before large reads, edits, or long multi-step tasks when you need to know how much context remains."

const COMPACT_DESCRIPTION =
  "Compact the current session to free context. Optional: call only when context_remaining reports that deliberate compaction is available, and only at a natural stopping point (not in the middle of a multi-step task). Before calling, save important findings or plans to files or todos, because compaction replaces earlier conversation detail with a summary. Compaction is scheduled and runs after this turn, so end your response after calling it."

type SessionState = {
  threshold: number
  pendingCompact?: { providerID: string; modelID: string }
}

type ConfigWithCompaction = {
  compaction?: { auto?: boolean; reserved?: number; [key: string]: unknown }
}

function positiveTokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

function percentValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100
    ? Math.round(value)
    : undefined
}

function parseAgentCompact(value: unknown): DeliberateCompactionConfig | undefined {
  if (value === undefined || value === false || value === null) return undefined
  if (value === true) return { percent: 50 }
  if (typeof value === "object") {
    const raw = value as Record<string, unknown>
    const percent = percentValue(raw.percent)
    const remainingTokens = positiveTokens(raw.remainingTokens)
    if (percent === undefined && remainingTokens === undefined) return { percent: 50 }
    return {
      ...(percent !== undefined ? { percent } : {}),
      ...(remainingTokens !== undefined ? { remainingTokens } : {}),
    }
  }
  return undefined
}

function modelFor(
  entries: readonly MessageEntryLike[],
  snapshot: ContextSnapshot,
): { providerID: string; modelID: string } | undefined {
  if (snapshot.providerID !== "unknown" && snapshot.modelID !== "unknown") {
    return { providerID: snapshot.providerID, modelID: snapshot.modelID }
  }
  for (let index = entries.length - 1; index >= 0; index--) {
    const info = entries[index].info
    if (info.providerID && info.modelID) {
      return { providerID: info.providerID, modelID: info.modelID }
    }
  }
  return undefined
}

export default (async ({ client }, rawOptions) => {
  const options = (rawOptions ?? {}) as Record<string, unknown>
  const agentCompact = parseAgentCompact(options.agentCompact)
  const sessions = new Map<string, SessionState>()
  let settings: CompactionSettings = { auto: true }

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

  function compactionLines(snapshot: ContextSnapshot, includeDeliberate: boolean): string[] {
    const lines = [formatCompactionPolicy(compactionPlan(snapshot, settings))]
    if (includeDeliberate && agentCompact) {
      lines.push(formatDeliberateCompaction(snapshot, agentCompact))
    }
    return lines
  }

  return {
    config: async (cfg) => {
      const config = cfg as unknown as ConfigWithCompaction
      settings = { auto: config.compaction?.auto !== false, reserved: config.compaction?.reserved }
    },

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
            return formatSnapshot(snapshot, nextNotice, compactionLines(snapshot, true))
          } catch (error) {
            return `Unable to read context usage: ${error instanceof Error ? error.message : String(error)}`
          }
        },
      },

      ...(agentCompact
        ? {
            compact_session: {
              description: COMPACT_DESCRIPTION,
              args: {},
              async execute(_args: Record<string, never>, context: ToolContext) {
                try {
                  const { entries, providers } = await load(context.sessionID)
                  const snapshot = snapshotFromMessages(entries, providers)
                  if (!snapshot) {
                    return "No context usage has been reported in this session yet, so compaction is not available."
                  }
                  if (!deliberateCompactionAvailable(snapshot, agentCompact)) {
                    return `Deliberate compaction is not available yet. It becomes available at ${describeDeliberateThreshold(
                      agentCompact,
                    )}. Current: ${
                      snapshot.percent !== undefined ? `${snapshot.percent}% used, ` : ""
                    }${snapshot.remaining !== undefined ? `${formatTokens(snapshot.remaining)} tokens remaining` : "remaining unknown"}.`
                  }
                  const model = modelFor(entries, snapshot)
                  if (!model) {
                    return "Unable to determine the current provider/model, so the session cannot be compacted."
                  }
                  const state = sessions.get(context.sessionID) ?? { threshold: 0 }
                  if (state.pendingCompact) {
                    return "A compaction is already scheduled for this session."
                  }
                  state.pendingCompact = model
                  sessions.set(context.sessionID, state)
                  return "Compaction scheduled. It will run after this turn ends. Do not start new work; anything not saved to files or todos may be lost."
                } catch (error) {
                  return `Unable to schedule compaction: ${error instanceof Error ? error.message : String(error)}`
                }
              },
            },
          }
        : {}),
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

        const state = sessions.get(input.sessionID) ?? { threshold: 0 }
        state.threshold = reached
        sessions.set(input.sessionID, state)
        const extra = compactionLines(
          snapshot,
          agentCompact !== undefined && deliberateCompactionAvailable(snapshot, agentCompact),
        )
        output.system.push(formatThresholdNotice(snapshot, reached, extra))
      } catch {
        // Context reporting must never break a model request.
      }
    },

    event: async ({ event }) => {
      if (event.type === "session.compacted") {
        sessions.delete(event.properties.sessionID)
        return
      }
      if (event.type === "session.deleted") {
        sessions.delete(event.properties.info.id)
        return
      }
      if (event.type !== "session.idle") return

      const sessionID = event.properties.sessionID
      const state = sessions.get(sessionID)
      if (!state?.pendingCompact) return

      const target = state.pendingCompact
      state.pendingCompact = undefined
      try {
        await client.session.summarize({ path: { id: sessionID }, body: target })
      } catch {
        // A failed compaction must not break the session; the user can retry.
      }
    },
  }
}) satisfies Plugin
