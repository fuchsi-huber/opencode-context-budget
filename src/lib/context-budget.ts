import path from "node:path"

export const DEFAULT_THRESHOLDS = [50, 75, 90] as const

export type Threshold = number

export function normalizeThresholds(value: unknown): number[] {
  if (!Array.isArray(value)) return [...DEFAULT_THRESHOLDS]
  const list = value
    .filter(
      (item): item is number =>
        typeof item === "number" && Number.isFinite(item) && item > 0 && item <= 100,
    )
    .map((item) => Math.round(item))
  const unique = [...new Set(list)].sort((a, b) => a - b)
  return unique.length ? unique : [...DEFAULT_THRESHOLDS]
}

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

export function thresholdFor(percent: number, thresholds: readonly number[]): number | undefined {
  for (let index = thresholds.length - 1; index >= 0; index--) {
    if (percent >= thresholds[index]) return thresholds[index]
  }
  return undefined
}

export function nextThreshold(threshold: number, thresholds: readonly number[]): number | undefined {
  const index = thresholds.indexOf(threshold)
  if (index >= 0) return thresholds[index + 1]
  return nextThresholdAfter(threshold, thresholds)
}

export function nextThresholdAfter(value: number, thresholds: readonly number[]): number | undefined {
  return thresholds.find((threshold) => threshold > value)
}

export function nextAutomaticThreshold(
  percent: number | undefined,
  notified: number,
  thresholds: readonly number[],
): number | undefined {
  if (percent !== undefined) {
    const due = thresholdFor(percent, thresholds)
    if (due !== undefined && due > notified) return due
  }
  return nextThresholdAfter(notified, thresholds)
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

export type TranscriptContent = {
  type: string
  text?: string
  uri?: string
  name?: string
  state?: {
    status?: string
    input?: unknown
    content?: ReadonlyArray<{ type?: string; text?: string; uri?: string }>
  }
}

export type TranscriptEntry = {
  type: string
  tokens?: UsageLike
  text?: string
  summary?: string
  content?: ReadonlyArray<TranscriptContent>
}

export type ToolBreakdown = {
  name: string
  tokens: number
}

export type TranscriptAnalysis = {
  turn: number
  pendingTokens: number
  userTokens: number
  assistantTokens: number
  toolOutputTokens: number
  otherTokens: number
  tools: ToolBreakdown[]
  growthPerTurn?: number
  reclaimableTokens: number
  reclaimableFiles: number
  reclaimableReads: number
}

export function estimateTextTokens(text: string | undefined): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

function contentTokens(
  content: ReadonlyArray<{ type?: string; text?: string; uri?: string }> | undefined,
): number {
  if (!content) return 0
  let total = 0
  for (const part of content) {
    if (part.type === "text") total += estimateTextTokens(part.text)
    else if (part.type === "file") total += estimateTextTokens(part.uri)
  }
  return total
}

function toolContentTokens(state: TranscriptContent["state"]): number {
  return contentTokens(state?.content)
}

function filePathOf(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined
  const record = input as Record<string, unknown>
  for (const key of ["path", "filePath", "file", "filename"]) {
    const value = record[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

function patchPaths(input: unknown): string[] {
  if (!input || typeof input !== "object") return []
  const text = (input as Record<string, unknown>).patchText
  if (typeof text !== "string") return []
  const paths: string[] = []
  for (const match of text.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) {
    const value = match[1]?.trim()
    if (value) paths.push(value)
  }
  return paths
}

const MUTATING_TOOLS = new Set(["edit", "write", "patch"])

export function analyzeTranscript(
  entries: readonly TranscriptEntry[],
  directory: string,
): TranscriptAnalysis {
  let turn = 0
  let userTokens = 0
  let assistantTokens = 0
  let toolOutputTokens = 0
  let otherTokens = 0
  const tools = new Map<string, number>()
  const reads: Array<{ order: number; path: string; tokens: number }> = []
  const mutations = new Map<string, number>()
  const turnTotals: Array<{ turn: number; tokens: number }> = []
  let lastAssistantIndex = -1
  let toolOrder = 0

  const resolve = (raw: string) => {
    try {
      return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(directory, raw)
    } catch {
      return raw
    }
  }

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]

    if (entry.type === "assistant") {
      for (const part of entry.content ?? []) {
        if (part.type === "text" || part.type === "reasoning") {
          assistantTokens += estimateTextTokens(part.text)
          continue
        }
        if (part.type !== "tool") continue

        const order = toolOrder++
        const tokens = toolContentTokens(part.state)
        toolOutputTokens += tokens
        const name = part.name ?? "unknown"
        tools.set(name, (tools.get(name) ?? 0) + tokens)

        const file = filePathOf(part.state?.input)
        if (file) {
          const normalized = resolve(file)
          if (name === "read") reads.push({ order, path: normalized, tokens })
          if (MUTATING_TOOLS.has(name)) mutations.set(normalized, order)
        } else if (name === "patch") {
          for (const patchPath of patchPaths(part.state?.input)) {
            mutations.set(resolve(patchPath), order)
          }
        }
      }

      const stepTotal = usageTotal(entry.tokens)
      if (stepTotal > 0) {
        lastAssistantIndex = index
        const previous = turnTotals[turnTotals.length - 1]
        if (previous?.turn === turn) previous.tokens = stepTotal
        else turnTotals.push({ turn, tokens: stepTotal })
      }
      continue
    }

    if (entry.type === "user") {
      turn += 1
      userTokens += estimateTextTokens(entry.text)
      continue
    }

    if (entry.type === "shell") {
      const tokens = estimateTextTokens(entry.text)
      toolOutputTokens += tokens
      tools.set("shell", (tools.get("shell") ?? 0) + tokens)
      continue
    }

    if (entry.type === "system" || entry.type === "synthetic" || entry.type === "skill") {
      otherTokens += estimateTextTokens(entry.text)
      continue
    }

    if (entry.type === "compaction") {
      otherTokens += estimateTextTokens(entry.summary)
    }
  }

  let reclaimableTokens = 0
  let reclaimableReads = 0
  const staleFiles = new Set<string>()
  for (const read of reads) {
    const mutatedAt = mutations.get(read.path)
    if (mutatedAt === undefined || mutatedAt <= read.order) continue
    reclaimableTokens += read.tokens
    reclaimableReads += 1
    staleFiles.add(read.path)
  }

  let pendingTokens = 0
  for (let index = lastAssistantIndex + 1; index < entries.length; index++) {
    const entry = entries[index]
    if (entry.type === "assistant") {
      for (const part of entry.content ?? []) {
        if (part.type === "text" || part.type === "reasoning") {
          pendingTokens += estimateTextTokens(part.text)
        } else if (part.type === "tool") {
          pendingTokens += toolContentTokens(part.state)
        }
      }
    } else if (entry.type === "compaction") {
      pendingTokens += estimateTextTokens(entry.summary)
    } else {
      pendingTokens += estimateTextTokens(entry.text)
    }
  }

  const deltas: number[] = []
  for (let index = 1; index < turnTotals.length; index++) {
    const delta = turnTotals[index].tokens - turnTotals[index - 1].tokens
    if (delta > 0) deltas.push(delta)
  }
  const recent = deltas.slice(-5)
  const growthPerTurn = recent.length
    ? Math.round(recent.reduce((total, value) => total + value, 0) / recent.length)
    : undefined

  return {
    turn,
    pendingTokens,
    userTokens,
    assistantTokens,
    toolOutputTokens,
    otherTokens,
    tools: [...tools.entries()]
      .map(([name, tokens]) => ({ name, tokens }))
      .sort((a, b) => b.tokens - a.tokens),
    growthPerTurn,
    reclaimableTokens,
    reclaimableFiles: staleFiles.size,
    reclaimableReads,
  }
}

export type RequestSizes = {
  system: number
  tools: number
}

export type Breakdown = {
  system: number
  user: number
  assistant: number
  toolOutput: number
  tools: ToolBreakdown[]
}

export function breakdown(
  snapshot: ContextSnapshot,
  analysis: TranscriptAnalysis,
  request: RequestSizes | undefined,
): Breakdown | undefined {
  const rawSystem = (request?.system ?? 0) + (request?.tools ?? 0) + analysis.otherTokens
  const rawUser = analysis.userTokens
  const rawAssistant = analysis.assistantTokens
  const rawToolOutput = analysis.toolOutputTokens
  const rawTotal = rawSystem + rawUser + rawAssistant + rawToolOutput
  if (rawTotal <= 0 || snapshot.tokens <= 0) return undefined

  const scale = snapshot.tokens / rawTotal
  return {
    system: Math.round(rawSystem * scale),
    user: Math.round(rawUser * scale),
    assistant: Math.round(rawAssistant * scale),
    toolOutput: Math.round(rawToolOutput * scale),
    tools: analysis.tools
      .map((tool) => ({ name: tool.name, tokens: Math.round(tool.tokens * scale) }))
      .filter((tool) => tool.tokens > 0)
      .slice(0, 6),
  }
}

export function formatBreakdown(value: Breakdown): string[] {
  const lines = [
    `Breakdown (est.): system+tools ${formatTokens(value.system)} · user ${formatTokens(value.user)} · assistant ${formatTokens(
      value.assistant,
    )} · tool output ${formatTokens(value.toolOutput)}`,
  ]
  if (value.tools.length) {
    lines.push(
      `  tools: ${value.tools.map((tool) => `${tool.name} ${formatTokens(tool.tokens)}`).join(" · ")}`,
    )
  }
  return lines
}

export function formatReclaimable(analysis: TranscriptAnalysis): string | undefined {
  if (analysis.reclaimableTokens <= 0) return undefined
  const files = analysis.reclaimableFiles === 1 ? "1 file" : `${analysis.reclaimableFiles} files`
  return `Reclaimable (est.): ~${formatTokens(analysis.reclaimableTokens)} from read outputs of ${files} changed since.`
}

export function estimateEtaTurns(
  snapshot: ContextSnapshot,
  analysis: TranscriptAnalysis,
  nextNotice: number | undefined,
): number | undefined {
  if (!nextNotice || !snapshot.limit || !analysis.growthPerTurn || analysis.growthPerTurn <= 0) {
    return undefined
  }
  const target = (snapshot.limit * nextNotice) / 100
  const needed = target - snapshot.tokens
  if (needed <= 0) return undefined
  return Math.max(1, Math.ceil(needed / analysis.growthPerTurn))
}

export const DEFAULT_COMPACTION_KEEP_TOKENS = 15_000
export const SUMMARY_OVERHEAD_TOKENS = 2_000

export function estimatePostCompaction(
  snapshot: ContextSnapshot,
  request: RequestSizes | undefined,
): number | undefined {
  const fixed =
    (request?.system ?? 0) +
    (request?.tools ?? 0) +
    DEFAULT_COMPACTION_KEEP_TOKENS +
    SUMMARY_OVERHEAD_TOKENS
  return snapshot.tokens > fixed ? fixed : undefined
}

export function formatPostCompaction(tokens: number): string {
  return `After compaction: ~${formatTokens(tokens)} tokens (est.; default 15k keep window).`
}

export function formatAsOf(analysis: TranscriptAnalysis): string {
  const pending =
    analysis.pendingTokens > 0 ? ` (+~${formatTokens(analysis.pendingTokens)} pending, est.)` : ""
  const state = analysis.pendingTokens > 0 ? "during" : "end of"
  return `As of: ${state} turn ${analysis.turn}, before this request${pending}.`
}

export type SnapshotFormatOptions = {
  nextNotice?: number
  nextNoticeTurns?: number
  extraLines?: string[]
  asOf?: string
}

export function formatSnapshot(
  snapshot: ContextSnapshot,
  options: SnapshotFormatOptions = {},
): string {
  const { nextNotice, nextNoticeTurns, extraLines = [], asOf } = options
  const lines = [
    "Context (matches the UI sidebar)",
    `Used: ${formatTokens(snapshot.tokens)}${
      snapshot.limit ? ` / ${formatTokens(snapshot.limit)}` : ""
    } tokens${snapshot.percent !== undefined ? ` (${snapshot.percent}% used)` : ""}`,
  ]

  if (snapshot.remaining !== undefined) {
    lines.push(`Remaining: ${formatTokens(snapshot.remaining)} tokens`)
  }

  if (asOf) lines.push(asOf)

  const eta =
    nextNoticeTurns !== undefined
      ? ` (in ~${nextNoticeTurns} turn${nextNoticeTurns === 1 ? "" : "s"} at the current rate)`
      : ""
  lines.push(
    nextNotice === undefined
      ? "Next automatic notification: none (the final threshold has already been reached)."
      : snapshot.percent !== undefined && nextNotice <= snapshot.percent
        ? `Next automatic notification: on the next model request (the ${nextNotice}% threshold is already crossed).`
        : `Next automatic notification: when context reaches ${nextNotice}%${eta}.`,
  )
  lines.push(...extraLines)
  if (!asOf) lines.push(`Updated: ${snapshot.updatedDescription}.`)
  lines.push(`Model: ${snapshot.providerID}/${snapshot.modelID}`)
  lines.push(
    "Source: provider-reported totals; breakdown, reclaimable, and ETA are estimates.",
  )

  return lines.join("\n")
}

export function formatThresholdNotice(
  snapshot: ContextSnapshot,
  threshold: number,
  thresholds: readonly number[],
  extraLines: string[] = [],
): string {
  const next = nextThreshold(threshold, thresholds)
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
    "Use the context_remaining tool at any time to check the breakdown and the current value.",
  ].join("\n")
}
