import test from "node:test"
import assert from "node:assert/strict"

import {
  DEFAULT_THRESHOLDS,
  analyzeTranscript,
  breakdown,
  deliberateCompactionAvailable,
  describeDeliberateThreshold,
  formatDeliberateCompaction,
  estimateEtaTurns,
  estimatePostCompaction,
  formatAsOf,
  formatSnapshot,
  formatThresholdNotice,
  latestStep,
  latestStepUsage,
  nextAutomaticThreshold,
  normalizeThresholds,
  snapshotFromUsage,
  thresholdFor,
  usageTotal,
} from "../src/lib/context-budget.ts"

test("usageTotal adds every provider-reported token bucket", () => {
  assert.equal(
    usageTotal({ input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 } }),
    42,
  )
  assert.equal(usageTotal(undefined), 0)
})

test("snapshotFromUsage computes usage, limit, remaining, and percentage", () => {
  const snapshot = snapshotFromUsage({
    tokens: { input: 40_000, output: 10_000, cache: { read: 1_000, write: 0 } },
    contextLimit: 100_000,
    updatedAt: 1_700_000_000_000,
    providerID: "openrouter",
    modelID: "test-model",
  })

  assert.equal(snapshot.tokens, 51_000)
  assert.equal(snapshot.limit, 100_000)
  assert.equal(snapshot.remaining, 49_000)
  assert.equal(snapshot.percent, 51)
  assert.match(snapshot.updatedDescription, /session last updated at/)
})

test("snapshotFromUsage tolerates a missing limit and timestamp", () => {
  const snapshot = snapshotFromUsage({ tokens: { input: 5_000, output: 1_000 } })
  assert.equal(snapshot.tokens, 6_000)
  assert.equal(snapshot.limit, undefined)
  assert.equal(snapshot.percent, undefined)
  assert.equal(snapshot.remaining, undefined)
  assert.match(snapshot.updatedDescription, /did not record a timestamp/)
})

test("thresholds are reported at 50, 75, and 90 percent", () => {
  assert.equal(thresholdFor(49, DEFAULT_THRESHOLDS), undefined)
  assert.equal(thresholdFor(51, DEFAULT_THRESHOLDS), 50)
  assert.equal(thresholdFor(75, DEFAULT_THRESHOLDS), 75)
  assert.equal(thresholdFor(99, DEFAULT_THRESHOLDS), 90)
})

test("nextAutomaticThreshold prefers a due threshold, otherwise the next one", () => {
  assert.equal(nextAutomaticThreshold(10, 0, DEFAULT_THRESHOLDS), 50)
  assert.equal(nextAutomaticThreshold(55, 50, DEFAULT_THRESHOLDS), 75)
  assert.equal(nextAutomaticThreshold(undefined, 0, DEFAULT_THRESHOLDS), 50)
  assert.equal(nextAutomaticThreshold(undefined, 90, DEFAULT_THRESHOLDS), undefined)
})

test("thresholds are configurable and normalized", () => {
  assert.deepEqual(normalizeThresholds(undefined), [50, 75, 90])
  assert.deepEqual(normalizeThresholds([90, 50, 75, 50]), [50, 75, 90])
  assert.deepEqual(normalizeThresholds([60, "80", 0, 120, 60.4]), [60])
  assert.deepEqual(normalizeThresholds([]), [50, 75, 90])
  assert.deepEqual(normalizeThresholds([80, 60]), [60, 80])

  assert.equal(thresholdFor(65, [60, 80]), 60)
  assert.equal(thresholdFor(85, [60, 80]), 80)
  assert.equal(nextAutomaticThreshold(65, 60, [60, 80]), 80)
  assert.equal(nextAutomaticThreshold(50, 0, [60, 80]), 60)
})

test("deliberate compaction is gated by percent or remaining tokens", () => {
  const snapshot = snapshotFromUsage({ tokens: { input: 700_000, output: 1_000 }, contextLimit: 1_000_000 })

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

test("formatted snapshot includes usage, remaining budget, and the next notice", () => {
  const snapshot = snapshotFromUsage({ tokens: { input: 80_000, output: 10_000 }, contextLimit: 100_000 })

  const text = formatSnapshot(snapshot, {
    nextNotice: nextAutomaticThreshold(snapshot.percent, 0, DEFAULT_THRESHOLDS),
  })
  assert.match(text, /Used: 90k \/ 100k tokens \(90% used\)/)
  assert.match(text, /Remaining: 10k tokens/)
  assert.match(text, /Next automatic notification: on the next model request \(the 90% threshold is already crossed\)/)

  const upcoming = formatSnapshot(snapshot, {
    nextNotice: nextAutomaticThreshold(snapshot.percent, 90, DEFAULT_THRESHOLDS),
  })
  assert.match(upcoming, /Next automatic notification: none/)

  const finalText = formatSnapshot(snapshot)
  assert.match(finalText, /Next automatic notification: none/)
})

test("deliberate compaction lines are optional and low-pressure", () => {
  const snapshot = snapshotFromUsage({ tokens: { input: 700_000, output: 1_000 }, contextLimit: 1_000_000 })

  const available = formatDeliberateCompaction(snapshot, { percent: 50 })
  assert.match(available, /available now \(optional\)/)
  assert.match(available, /save important state to files or todos/)
  assert.match(available, /Do not interrupt current work just to compact/)

  const later = formatDeliberateCompaction(snapshot, { percent: 80 })
  assert.match(later, /available from 80% used/)
})

test("threshold notices include the extra deliberate compaction line", () => {
  const snapshot = snapshotFromUsage({ tokens: { input: 800_000, output: 10_000 }, contextLimit: 1_000_000 })
  const notice = formatThresholdNotice(snapshot, 75, DEFAULT_THRESHOLDS, [
    "Deliberate compaction: available now (optional).",
  ])
  assert.match(notice, /context indicator is at 81%/)
  assert.match(notice, /Deliberate compaction: available now/)
  assert.match(notice, /final configured threshold|notified again/)
})

test("threshold notices use the configured threshold list", () => {
  const snapshot = snapshotFromUsage({ tokens: { input: 650_000 }, contextLimit: 1_000_000 })
  const notice = formatThresholdNotice(snapshot, 60, [60, 80])
  assert.match(notice, /context indicator is at 65%/)
  assert.match(notice, /notified again when the context reaches 80%/)
})

function transcriptFixture() {
  return [
    { type: "user", text: "please read and fix a.ts and b.ts" },
    {
      type: "assistant",
      tokens: { input: 10_000, output: 1_000 },
      content: [
        { type: "text", text: "reading files" },
        {
          type: "tool",
          name: "read",
          state: {
            status: "completed",
            input: { path: "src/a.ts" },
            content: [{ type: "text", text: "A".repeat(4000) }],
          },
        },
        {
          type: "tool",
          name: "read",
          state: {
            status: "completed",
            input: { path: "src/b.ts" },
            content: [{ type: "text", text: "B".repeat(2000) }],
          },
        },
      ],
    },
    {
      type: "assistant",
      tokens: { input: 20_000, output: 2_000 },
      content: [
        {
          type: "tool",
          name: "edit",
          state: {
            status: "completed",
            input: { path: "src/a.ts" },
            content: [{ type: "text", text: "ok" }],
          },
        },
      ],
    },
    { type: "user", text: "thanks" },
    {
      type: "assistant",
      tokens: { input: 30_000, output: 1_000 },
      content: [
        {
          type: "tool",
          name: "read",
          state: {
            status: "completed",
            input: { path: "src/a.ts" },
            content: [{ type: "text", text: "A2".repeat(1000) }],
          },
        },
      ],
    },
  ]
}

test("analyzeTranscript groups tool output and counts turns", () => {
  const analysis = analyzeTranscript(transcriptFixture())
  assert.equal(analysis.turn, 2)
  assert.ok(analysis.tools.some((tool) => tool.name === "read"))
  assert.ok(analysis.tools.some((tool) => tool.name === "edit"))
  assert.ok(analysis.growthPerTurn !== undefined && analysis.growthPerTurn > 0)
})

test("breakdown scales to the provider total", () => {
  const snapshot = snapshotFromUsage({ tokens: { input: 100_000 }, contextLimit: 1_000_000 })
  const analysis = analyzeTranscript(transcriptFixture())
  const table = breakdown(snapshot, analysis, { system: 2_000, tools: 1_000 })
  assert.ok(table)
  const total = table!.system + table!.user + table!.assistant + table!.toolOutput
  assert.ok(Math.abs(total - snapshot.tokens) <= 4)
  assert.ok(table!.tools.length > 0)
})

test("ETA and post-compaction estimates use the analysis and request sizes", () => {
  const snapshot = snapshotFromUsage({ tokens: { input: 700_000 }, contextLimit: 1_000_000 })
  const analysis = {
    ...analyzeTranscript(transcriptFixture()),
    growthPerTurn: 25_000,
  }
  assert.equal(estimateEtaTurns(snapshot, analysis, 75), 2)
  assert.equal(estimatePostCompaction(snapshot, { system: 10_000, tools: 5_000 }), 32_000)
  assert.equal(estimatePostCompaction(snapshot, undefined), undefined)

  const asOf = formatAsOf({ ...analysis, pendingTokens: 3_000 })
  assert.match(asOf, /during turn 2/)
  assert.match(asOf, /~3k pending/)
})

test("latestStepUsage ignores cumulative session totals", () => {
  const entries = [
    {
      type: "assistant",
      model: { providerID: "openrouter", id: "old" },
      tokens: { input: 500, output: 10, cache: { read: 10_000, write: 0 } },
    },
    { type: "user", text: "next" },
    {
      type: "assistant",
      model: { providerID: "openrouter", id: "~deepseek/deepseek-flash-latest" },
      tokens: { input: 732, output: 186, reasoning: 131, cache: { read: 281_600, write: 0 } },
    },
  ]
  const step = latestStep(entries)
  assert.ok(step)
  assert.equal(step.modelID, "~deepseek/deepseek-flash-latest")
  const usage = latestStepUsage(entries)
  assert.ok(usage)
  assert.equal(usageTotal(usage), 282_649)

  assert.equal(latestStepUsage([{ type: "assistant", tokens: { input: 0, output: 0 } }]), undefined)
  assert.equal(latestStepUsage([]), undefined)
})

test("threshold notice points at what the tool provides", () => {
  const snapshot = snapshotFromUsage({ tokens: { input: 560_000 }, contextLimit: 1_000_000 })
  const notice = formatThresholdNotice(snapshot, 50, DEFAULT_THRESHOLDS)
  assert.match(notice, /context_remaining tool for the system\/user\/assistant\/tool-output breakdown/)
  assert.match(notice, /per-tool totals/)
  assert.match(notice, /ETA to the next threshold/)
  assert.match(notice, /post-compaction estimate/)
})
