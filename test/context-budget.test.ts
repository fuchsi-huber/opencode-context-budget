import test from "node:test"
import assert from "node:assert/strict"

import {
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
    },
  },
]

function assistant(id: string, tokens: object, completed = 1_700_000_000_000) {
  return {
    info: {
      id,
      role: "assistant" as const,
      providerID: "openrouter",
      modelID: "test-model",
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
  assert.match(text, /Next automatic notification: when context reaches 90%/)

  const finalText = formatSnapshot(snapshot!, undefined)
  assert.match(finalText, /Next automatic notification: none/)

  const notice = formatThresholdNotice(snapshot!, 90)
  assert.match(notice, /context indicator is at 90%/)
  assert.match(notice, /final configured threshold/)
})
