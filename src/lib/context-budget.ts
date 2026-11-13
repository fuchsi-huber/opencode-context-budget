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

export type MessageInfoLike = {
  id: string
  role: "user" | "assistant"
  time?: { created?: number; completed?: number }
  modelID?: string
  providerID?: string
  tokens?: UsageLike
}

export type MessageEntryLike = {
  info: MessageInfoLike
  parts?: Array<{ type?: string }>
}

export type ModelLimit = {
  context?: number
  input?: number
  output?: number
}

export type ModelLike = {
  limit?: ModelLimit
}

export type ProviderLike = {
  id: string
  models?: Record<string, ModelLike>
}

export type ContextSnapshot = {
  tokens: number
  limit?: number
  inputLimit?: number
  outputLimit?: number
  remaining?: number
  percent?: number
  updatedAt?: number
  updatedDescription: string
  messageID: string
  providerID: string
  modelID: string
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

export function findUiUsage(
  entries: readonly MessageEntryLike[],
  beforeIndex = entries.length,
): MessageEntryLike | undefined {
  for (let index = beforeIndex - 1; index >= 0; index--) {
    const entry = entries[index]
    if (entry.info.role !== "assistant") continue
    if (count(entry.info.tokens?.output) <= 0) continue
    return entry
  }
  return undefined
}

export function findLastUserIndex(entries: readonly MessageEntryLike[]): number {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (entry.info.role !== "user") continue
    if (entry.parts?.some((part) => part?.type === "compaction")) continue
    return index
  }
  return -1
}

export function findLastUser(entries: readonly MessageEntryLike[]): MessageInfoLike | undefined {
  const index = findLastUserIndex(entries)
  return index >= 0 ? entries[index].info : undefined
}

export function findModelLimit(
  providers: readonly ProviderLike[],
  providerID: string | undefined,
  modelID: string | undefined,
): ModelLimit | undefined {
  if (!providerID || !modelID) return undefined
  const provider = providers.find((item) => item.id === providerID)
  return provider?.models?.[modelID]?.limit
}

export function findContextLimit(
  providers: readonly ProviderLike[],
  providerID: string | undefined,
  modelID: string | undefined,
): number | undefined {
  return findModelLimit(providers, providerID, modelID)?.context
}

export function snapshotFromMessages(
  entries: readonly MessageEntryLike[],
  providers: readonly ProviderLike[],
  beforeIndex = entries.length,
): ContextSnapshot | undefined {
  const entry = findUiUsage(entries, beforeIndex)
  if (!entry) return undefined

  const tokens = usageTotal(entry.info.tokens)
  const limits = findModelLimit(providers, entry.info.providerID, entry.info.modelID)
  const limit = limits?.context
  const percent = limit ? Math.round((tokens / limit) * 100) : undefined
  const remaining = limit ? Math.max(0, limit - tokens) : undefined
  const completed = entry.info.time?.completed
  const created = entry.info.time?.created
  const updatedAt = completed

  const updatedDescription = completed
    ? `assistant response completed at ${formatTimestamp(completed)}`
    : created
      ? `current response is still in progress (started at ${formatTimestamp(created)}); the value was updated by its most recent completed model step, whose individual timestamp OpenCode does not expose`
      : "OpenCode did not record a timestamp for this update"

  return {
    tokens,
    limit,
    inputLimit: limits?.input,
    outputLimit: limits?.output,
    remaining,
    percent,
    updatedAt,
    updatedDescription,
    messageID: entry.info.id,
    providerID: entry.info.providerID ?? "unknown",
    modelID: entry.info.modelID ?? "unknown",
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

export const OUTPUT_TOKEN_MAX = 32_000
export const DEFAULT_COMPACTION_RESERVED = 20_000

export type CompactionSettings = {
  auto?: boolean
  reserved?: number
}

export type CompactionPlan = {
  enabled: boolean
  due: boolean
  triggerTokens: number
  triggerRemaining: number
  triggerPercent: number
}

export type DeliberateCompactionConfig = {
  percent?: number
  remainingTokens?: number
}

export function maxOutputTokens(outputLimit: number | undefined): number {
  const value = typeof outputLimit === "number" && outputLimit > 0 ? outputLimit : OUTPUT_TOKEN_MAX
  return Math.min(value, OUTPUT_TOKEN_MAX) || OUTPUT_TOKEN_MAX
}

export function usableTokens(
  snapshot: Pick<ContextSnapshot, "limit" | "inputLimit" | "outputLimit">,
  settings: CompactionSettings,
): number | undefined {
  if (!snapshot.limit) return undefined
  const output = maxOutputTokens(snapshot.outputLimit)
  const reserved = settings.reserved ?? Math.min(DEFAULT_COMPACTION_RESERVED, output)
  if (snapshot.inputLimit) return Math.max(0, snapshot.inputLimit - reserved)
  return Math.max(0, snapshot.limit - output)
}

export function compactionPlan(
  snapshot: ContextSnapshot,
  settings: CompactionSettings,
): CompactionPlan | undefined {
  if (settings.auto === false) {
    return { enabled: false, due: false, triggerTokens: 0, triggerRemaining: 0, triggerPercent: 0 }
  }
  const usable = usableTokens(snapshot, settings)
  if (usable === undefined || !snapshot.limit) return undefined
  return {
    enabled: true,
    due: snapshot.tokens >= usable,
    triggerTokens: usable,
    triggerRemaining: Math.max(0, snapshot.limit - usable),
    triggerPercent: Math.min(100, Math.max(0, Math.round((usable / snapshot.limit) * 100))),
  }
}

export function formatCompactionPolicy(plan: CompactionPlan | undefined): string {
  if (!plan) return "Automatic compaction (built-in): status unavailable (context limit unknown)."
  if (!plan.enabled) return "Automatic compaction (built-in): disabled."
  if (plan.due) {
    return `Automatic compaction (built-in): due now (below the ~${formatTokens(plan.triggerRemaining)} tokens remaining trigger); it runs when the current step finishes.`
  }
  return `Automatic compaction (built-in): at ~${formatTokens(plan.triggerRemaining)} tokens remaining (~${plan.triggerPercent}% used).`
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
