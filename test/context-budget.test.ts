import test from "node:test"
import assert from "node:assert/strict"

import {
  compactionPlan,
  deliberateCompactionAvailable,
  describeDeliberateThreshold,
  formatCompactionPolicy,
  formatDeliberateCompaction,
  formatSnapshot,
  formatThresholdNotice,
  nextAutomaticThreshold,
  snapshotFromMessages,
  thresholdFor,
  usageTotal,
} from "../src/lib/context-budget.ts"

const providers = [
  {
    id: "openrouter",
    models: {
      "test-model": { limit: { context: 100_000 } },
      "compaction-model": { limit: { context: 1_000_000, input: 1_000_000, output: 32_000 } },
    },
  },
]

function assistant(
  id: string,
  tokens: object,
  completed = 1_700_000_000_000,
  modelID = "test-model",
) {
  return {
    info: {
      id,
      role: "assistant" as const,
      providerID: "openrouter",
      modelID,
      time: { created: completed - 1_000, completed },
      tokens,
    },
    parts: [{ type: "text" }],
  }
}

test("usageTotal adds every provider-reported token bucket", () => {
  assert.equal(
    usageTotal({ input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 } }),
    42,
  )
  assert.equal(usageTotal(undefined), 0)
})

test("snapshotFromMessages uses the latest assistant response with output tokens", () => {
  const entries = [
    assistant("old", { input: 90_000, output: 1_000 }),
    assistant("latest", { input: 40_000, output: 10_000, cache: { read: 1_000, write: 0 } }),
  ]

  const snapshot = snapshotFromMessages(entries, providers)
  assert.ok(snapshot)
  assert.equal(snapshot?.messageID, "latest")
  assert.equal(snapshot?.tokens, 51_000)
  assert.equal(snapshot?.limit, 100_000)
  assert.equal(snapshot?.remaining, 49_000)
  assert.equal(snapshot?.percent, 51)
})

test("snapshotFromMessages returns undefined until usage is reported", () => {
  assert.equal(snapshotFromMessages([], providers), undefined)
  assert.equal(
    snapshotFromMessages([assistant("pending", { input: 5_000, output: 0 })], providers),
    undefined,
  )
})

test("thresholds are reported once at 50, 75, and 90 percent", () => {
  assert.equal(thresholdFor(49), undefined)
  assert.equal(thresholdFor(51), 50)
  assert.equal(thresholdFor(75), 75)
  assert.equal(thresholdFor(99), 90)
})

test("nextAutomaticThreshold prefers a due threshold, otherwise the next one", () => {
  assert.equal(nextAutomaticThreshold(10, 0), 50)
  assert.equal(nextAutomaticThreshold(55, 50), 75)
  assert.equal(nextAutomaticThreshold(undefined, 0), 50)
  assert.equal(nextAutomaticThreshold(undefined, 90), undefined)
})

test("formatted output includes usage, remaining budget, and the next warning", () => {
  const snapshot = snapshotFromMessages(
    [assistant("latest", { input: 80_000, output: 10_000 })],
    providers,
  )
  assert.ok(snapshot)

  const text = formatSnapshot(snapshot!, nextAutomaticThreshold(snapshot!.percent, 0))
  assert.match(text, /Used: 90k \/ 100k tokens \(90% used\)/)
  assert.match(text, /Remaining: 10k tokens/)
  assert.match(text, /Next automatic notification: on the next model request \(the 90% threshold is already crossed\)/)

  const upcoming = formatSnapshot(snapshot!, nextAutomaticThreshold(snapshot!.percent, 90))
  assert.match(upcoming, /Next automatic notification: none/)

  const pending = formatSnapshot(snapshot!, 90)
  assert.match(pending, /Next automatic notification: on the next model request/)

  const finalText = formatSnapshot(snapshot!, undefined)
  assert.match(finalText, /Next automatic notification: none/)

  const notice = formatThresholdNotice(snapshot!, 90)
  assert.match(notice, /context indicator is at 90%/)
  assert.match(notice, /final configured threshold/)
})

function compactionSnapshot(tokens: number) {
  const snapshot = snapshotFromMessages(
    [assistant("latest", { input: tokens, output: 1_000 }, undefined, "compaction-model")],
    providers,
  )
  assert.ok(snapshot)
  return snapshot!
}

test("compactionPlan mirrors the built-in reserved buffer", () => {
  const snapshot = compactionSnapshot(500_000)
  const plan = compactionPlan(snapshot, {})
  assert.ok(plan)
  assert.equal(plan?.enabled, true)
  assert.equal(plan?.due, false)
  assert.equal(plan?.triggerRemaining, 20_000)
  assert.equal(plan?.triggerPercent, 98)
})

test("compactionPlan honors a custom reserved buffer", () => {
  const plan = compactionPlan(compactionSnapshot(500_000), { reserved: 50_000 })
  assert.ok(plan)
  assert.equal(plan?.triggerRemaining, 50_000)
  assert.equal(plan?.triggerPercent, 95)
})

test("compactionPlan reports disabled and due states", () => {
  const snapshot = compactionSnapshot(500_000)
  assert.equal(compactionPlan(snapshot, { auto: false })?.enabled, false)
  assert.equal(compactionPlan(compactionSnapshot(990_000), {})?.due, true)
})

test("deliberate compaction is gated by percent or remaining tokens", () => {
  const snapshot = compactionSnapshot(700_000)
  assert.equal(snapshot.percent, 70)
  assert.equal(snapshot.remaining, 299_000)

  assert.equal(deliberateCompactionAvailable(snapshot, { percent: 50 }), true)
  assert.equal(deliberateCompactionAvailable(snapshot, { percent: 75 }), false)
  assert.equal(deliberateCompactionAvailable(snapshot, { remainingTokens: 400_000 }), true)
  assert.equal(deliberateCompactionAvailable(snapshot, { remainingTokens: 200_000 }), false)
  assert.equal(deliberateCompactionAvailable(snapshot, { percent: 75, remainingTokens: 400_000 }), true)
  assert.equal(describeDeliberateThreshold({ percent: 50 }), "50% used")
  assert.equal(describeDeliberateThreshold({ remainingTokens: 200_000 }), "200k tokens remaining")
})

test("compaction lines describe built-in and deliberate compaction", () => {
  const snapshot = compactionSnapshot(700_000)
  const policy = formatCompactionPolicy(compactionPlan(snapshot, {}))
  assert.match(policy, /at ~20k tokens remaining \(~98% used\)/)

  const due = formatCompactionPolicy(compactionPlan(compactionSnapshot(990_000), {}))
  assert.match(due, /due now/)

  const available = formatDeliberateCompaction(snapshot, { percent: 50 })
  assert.match(available, /available now \(optional\)/)
  assert.match(available, /save important state to files or todos/)
  assert.match(available, /Do not interrupt current work just to compact/)

  const later = formatDeliberateCompaction(snapshot, { percent: 80 })
  assert.match(later, /available from 80% used/)
})

