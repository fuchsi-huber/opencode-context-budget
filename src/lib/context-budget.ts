export const THRESHOLDS = [50, 75, 90] as const

export type Threshold = (typeof THRESHOLDS)[number]

export type Usage = {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export type UsageLike = {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}

export type ContextSnapshot = {
  tokens: number
  limit?: number
  remaining?: number
  percent?: number
  updatedAt?: number
  updatedDescription: string
  providerID: string
  modelID: string
}

export type DeliberateCompactionConfig = {
  percent?: number
  remainingTokens?: number
}

export type SnapshotInput = {
  tokens: UsageLike
  contextLimit?: number
  updatedAt?: number
  providerID?: string
  modelID?: string
}

const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0

export const formatTokens = (value: number) =>
  value < 1_000 ? String(value) : `${Math.floor(value / 1_000)}k`

const formatTimestamp = (value: number) => {
  if (!Number.isFinite(value) || value < 0) return "an unrecorded time"
  return new Date(value).toISOString()
}

export function normalizeUsage(tokens?: UsageLike): Usage {
  return {
    input: count(tokens?.input),
    output: count(tokens?.output),
    reasoning: count(tokens?.reasoning),
    cache: {
      read: count(tokens?.cache?.read),
      write: count(tokens?.cache?.write),
    },
  }
}

export function usageTotal(tokens?: UsageLike): number {
  const value = normalizeUsage(tokens)
  return value.input + value.output + value.reasoning + value.cache.read + value.cache.write
}

export function snapshotFromUsage(input: SnapshotInput): ContextSnapshot {
  const tokens = usageTotal(input.tokens)
  const limit = input.contextLimit && input.contextLimit > 0 ? input.contextLimit : undefined
  const percent = limit ? Math.round((tokens / limit) * 100) : undefined
  const remaining = limit ? Math.max(0, limit - tokens) : undefined

  return {
    tokens,
    limit,
    remaining,
    percent,
    updatedAt: input.updatedAt,
    updatedDescription:
      input.updatedAt !== undefined
        ? `session last updated at ${formatTimestamp(input.updatedAt)}`
        : "OpenCode did not record a timestamp for this update",
    providerID: input.providerID ?? "unknown",
    modelID: input.modelID ?? "unknown",
  }
}

export function thresholdFor(percent: number): Threshold | undefined {
  for (let index = THRESHOLDS.length - 1; index >= 0; index--) {
    if (percent >= THRESHOLDS[index]) return THRESHOLDS[index]
  }
  return undefined
}

export function nextThreshold(threshold: Threshold): Threshold | undefined {
  const index = THRESHOLDS.indexOf(threshold)
  return index >= 0 ? THRESHOLDS[index + 1] : undefined
}

export function nextThresholdAfter(value: number): Threshold | undefined {
  return THRESHOLDS.find((threshold) => threshold > value)
}

export function nextAutomaticThreshold(
  percent: number | undefined,
  notified: number,
): Threshold | undefined {
  if (percent !== undefined) {
    const due = thresholdFor(percent)
    if (due !== undefined && due > notified) return due
  }
  return nextThresholdAfter(notified)
}

export function deliberateCompactionAvailable(
  snapshot: ContextSnapshot,
  config: DeliberateCompactionConfig,
): boolean {
  const percentHit =
    config.percent !== undefined && snapshot.percent !== undefined && snapshot.percent >= config.percent
  const tokensHit =
    config.remainingTokens !== undefined &&
    snapshot.remaining !== undefined &&
    snapshot.remaining <= config.remainingTokens
  return percentHit || tokensHit
}

export function describeDeliberateThreshold(config: DeliberateCompactionConfig): string {
  if (config.percent !== undefined && config.remainingTokens !== undefined) {
    return `${config.percent}% used or ${formatTokens(config.remainingTokens)} tokens remaining`
  }
  if (config.percent !== undefined) return `${config.percent}% used`
  if (config.remainingTokens !== undefined) return `${formatTokens(config.remainingTokens)} tokens remaining`
  return "50% used"
}

export function formatDeliberateCompaction(
  snapshot: ContextSnapshot,
  config: DeliberateCompactionConfig | undefined,
): string {
  if (!config) return "Deliberate compaction: disabled."
  if (deliberateCompactionAvailable(snapshot, config)) {
    return "Deliberate compaction: available now (optional). At a natural stopping point, save important state to files or todos, then call compact_session. Do not interrupt current work just to compact."
  }
  return `Deliberate compaction: available from ${describeDeliberateThreshold(config)}.`
}

export function formatSnapshot(
  snapshot: ContextSnapshot,
  nextNotice?: Threshold,
  extraLines: string[] = [],
): string {
  const lines = [
    "Context (matches the UI sidebar)",
    `Used: ${formatTokens(snapshot.tokens)}${
      snapshot.limit ? ` / ${formatTokens(snapshot.limit)}` : ""
    } tokens${snapshot.percent !== undefined ? ` (${snapshot.percent}% used)` : ""}`,
  ]

  if (snapshot.remaining !== undefined) {
    lines.push(`Remaining: ${formatTokens(snapshot.remaining)} tokens`)
  }

  lines.push(
    nextNotice === undefined
      ? "Next automatic notification: none (the final threshold has already been reached)."
      : snapshot.percent !== undefined && nextNotice <= snapshot.percent
        ? `Next automatic notification: on the next model request (the ${nextNotice}% threshold is already crossed).`
        : `Next automatic notification: when context reaches ${nextNotice}%.`,
  )
  lines.push(...extraLines)
  lines.push(`Updated: ${snapshot.updatedDescription}.`)
  lines.push(`Model: ${snapshot.providerID}/${snapshot.modelID}`)
  lines.push("Source: latest provider-reported token usage, not a tokenizer estimate.")

  return lines.join("\n")
}

export function formatThresholdNotice(
  snapshot: ContextSnapshot,
  threshold: Threshold,
  extraLines: string[] = [],
): string {
  const next = nextThreshold(threshold)
  const nextText = next
    ? `You will be notified again when the context reaches ${next}%.`
    : "This is the final configured threshold; no further automatic notice will be sent."

  return [
    `[Context budget] The UI context indicator is at ${snapshot.percent}%.`,
    `Used: ${formatTokens(snapshot.tokens)}${snapshot.limit ? ` / ${formatTokens(snapshot.limit)}` : ""} tokens`,
    ...(snapshot.remaining !== undefined
      ? [`Remaining: ${formatTokens(snapshot.remaining)} tokens`]
      : []),
    `Based on the latest provider-reported usage. ${nextText}`,
    ...extraLines,
    "Use the context_remaining tool at any time to check the current value and when it was last updated.",
  ].join("\n")
}
