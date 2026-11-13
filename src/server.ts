import { Plugin } from "@opencode/plugin"
import {
  analyzeTranscript,
  breakdown,
  deliberateCompactionAvailable,
  describeDeliberateThreshold,
  estimateEtaTurns,
  estimatePostCompaction,
  estimateTextTokens,
  formatAsOf,
  formatBreakdown,
  formatDeliberateCompaction,
  formatPostCompaction,
  formatSnapshot,
  formatThresholdNotice,
  formatTokens,
  latestStep,
  nextAutomaticThreshold,
  normalizeThresholds,
  snapshotFromUsage,
  thresholdFor,
  type ContextSnapshot,
  type DeliberateCompactionConfig,
  type RequestSizes,
} from "./lib/context-budget.ts"

const TOOL_DESCRIPTION =
  "Return the context-window usage shown in the UI sidebar: used tokens, context limit, remaining tokens, percentage, an estimated breakdown by system/tools, user, assistant, and tool output, the next automatic warning threshold with an ETA in turns, a post-compaction estimate, and the turn the value is current as of. Use this before large reads, edits, or long multi-step tasks when you need to know how much context remains."

const COMPACT_DESCRIPTION =
  "Request compaction of the current session to free context. Optional: call only when context_remaining reports that deliberate compaction is available, and only at a natural stopping point (not in the middle of a multi-step task). Before calling, save important findings or plans to files or todos, because compaction replaces earlier conversation detail with a summary. Compaction runs at the next safe step boundary, so end your response after calling it."

const EMPTY_INPUT = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const

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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default Plugin.define({
  id: "opencode-context-budget",
  async setup(ctx) {
    const agentCompact = parseAgentCompact((ctx.options as Record<string, unknown>).agentCompact)
    const thresholds = normalizeThresholds((ctx.options as Record<string, unknown>).thresholds)
    const notified = new Map<string, number>()
    const requests = new Map<string, RequestSizes>()

    async function inspect(sessionID: string): Promise<{
      current: ContextSnapshot
      transcript: Awaited<ReturnType<typeof ctx.session.context>>
    } | undefined> {
      const [session, models, transcript] = await Promise.all([
        ctx.session.get({ sessionID }),
        ctx.model.list(),
        ctx.session
          .context({ sessionID })
          .catch(() => [] as Awaited<ReturnType<typeof ctx.session.context>>),
      ])
      const ref = session.model ?? (await ctx.model.default()).data ?? undefined
      // The latest step carries the model the limit applies to, matching the UI.
      const step = latestStep(transcript)
      const stepProvider = step?.providerID ?? ref?.providerID
      const stepModel = step?.modelID ?? ref?.id
      const model = stepProvider && stepModel
        ? models.data.find((item) => item.providerID === stepProvider && item.id === stepModel)
        : undefined

      // The latest model step is the current context size; session tokens are cumulative.
      const tokens = step?.tokens ?? session.tokens

      const current = snapshotFromUsage({
        tokens,
        contextLimit: model?.limit.context,
        updatedAt: session.time.idle ?? session.time.updated,
        providerID: stepProvider,
        modelID: stepModel,
      })

      return current.tokens > 0 ? { current, transcript } : undefined
    }

    async function snapshot(sessionID: string): Promise<ContextSnapshot | undefined> {
      return (await inspect(sessionID))?.current
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "context_remaining",
        description: TOOL_DESCRIPTION,
        input: EMPTY_INPUT,
        execute: async (_input, context) => {
          try {
            const found = await inspect(context.sessionID)
            if (!found) {
              return {
                content:
                  "No context usage has been reported in this session yet. The UI sidebar also has no context value until a model request reports token usage.",
              }
            }
            const current = found.current

            const next = nextAutomaticThreshold(
              current.percent,
              notified.get(context.sessionID) ?? 0,
              thresholds,
            )
            const request = requests.get(context.sessionID)
            const extra: string[] = []
            let asOf: string | undefined
            let eta: number | undefined

            try {
              const analysis = analyzeTranscript(found.transcript)
              const table = breakdown(current, analysis, request)
              if (table) extra.push(...formatBreakdown(table))
              eta = estimateEtaTurns(current, analysis, next)
              asOf = formatAsOf(analysis)
            } catch {
              // The breakdown is best-effort; the totals still work without it.
            }

            const afterCompaction = estimatePostCompaction(current, request)
            if (afterCompaction !== undefined) {
              extra.push(formatPostCompaction(afterCompaction, current.tokens))
            }
            if (agentCompact) extra.push(formatDeliberateCompaction(current, agentCompact))

            return {
              content: formatSnapshot(current, {
                nextNotice: next,
                nextNoticeTurns: eta,
                extraLines: extra,
                asOf,
              }),
            }
          } catch (error) {
            return { content: `Unable to read context usage: ${message(error)}` }
          }
        },
      })

      if (agentCompact) {
        editor.add({
          name: "compact_session",
          description: COMPACT_DESCRIPTION,
          input: EMPTY_INPUT,
          execute: async (_input, context) => {
            try {
              const current = await snapshot(context.sessionID)
              if (!current) {
                return {
                  content:
                    "No context usage has been reported in this session yet, so compaction is not available.",
                }
              }
              if (!deliberateCompactionAvailable(current, agentCompact)) {
                return {
                  content: `Deliberate compaction is not available yet. It becomes available at ${describeDeliberateThreshold(
                    agentCompact,
                  )}. Current: ${
                    current.percent !== undefined ? `${current.percent}% used, ` : ""
                  }${current.remaining !== undefined ? `${formatTokens(current.remaining)} tokens remaining` : "remaining unknown"}.`,
                }
              }
              await ctx.session.compact({ sessionID: context.sessionID })
              return {
                content:
                  "Compaction requested. It runs at the next safe step boundary. Do not start new work; anything not saved to files or todos may be lost.",
              }
            } catch (error) {
              return { content: `Unable to request compaction: ${message(error)}` }
            }
          },
        })
      }
    })

    await ctx.session.hook("context", async (event) => {
      try {
        requests.set(event.sessionID, {
          system: estimateTextTokens(event.system.map((part) => part.text).join("\n")),
          tools: estimateTextTokens(JSON.stringify(event.tools)),
        })

        const current = await snapshot(event.sessionID)
        if (!current || current.percent === undefined) return

        const previous = notified.get(event.sessionID) ?? 0
        const reached = thresholdFor(current.percent, thresholds)
        if (reached === undefined || reached <= previous) return

        notified.set(event.sessionID, reached)
        const extra =
          agentCompact && deliberateCompactionAvailable(current, agentCompact)
            ? [formatDeliberateCompaction(current, agentCompact)]
            : []
        event.system.push({
          type: "text",
          text: formatThresholdNotice(current, reached, thresholds, extra),
        })
      } catch {
        // Context reporting must never break a model request.
      }
    })

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: ["session.compaction.ended", "session.deleted"],
          signal: controller.signal,
        })) {
          notified.delete(event.data.sessionID)
          requests.delete(event.data.sessionID)
        }
      } catch {
        // The subscription is best-effort.
      }
    })()

    return () => controller.abort()
  },
})
