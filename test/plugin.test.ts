import test from "node:test"
import assert from "node:assert/strict"

import plugin from "../src/server.ts"

const model = {
  id: "m",
  modelID: "m",
  providerID: "p",
  limit: { context: 1_000_000, output: 32_000 },
}

type SessionInfo = {
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  model: { providerID: string; id: string }
  time: { updated: number; idle?: number }
}

function session(input = 700_000): SessionInfo {
  return {
    tokens: { input, output: 1_000, reasoning: 0, cache: { read: 0, write: 0 } },
    model: { providerID: "p", id: "m" },
    time: { updated: 1_700_000_000_000, idle: 1_700_000_000_000 },
  }
}

function emptySession(): SessionInfo {
  return {
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    model: { providerID: "p", id: "m" },
    time: { updated: 1_700_000_000_000 },
  }
}

function makeContext(
  options: Record<string, unknown> = {},
  info: SessionInfo = session(),
  transcript: any[] = [],
) {
  const tools = new Map<string, any>()
  const compactions: any[] = []
  const queue: any[] = []
  let contextHook: ((event: any) => Promise<void> | void) | undefined
  let closed = false

  const ctx = {
    options,
    location: { directory: "/tmp" },
    session: {
      get: async () => info,
      context: async () => transcript,
      hook: async (name: string, callback: any) => {
        if (name === "context") contextHook = callback
        return { dispose: async () => {} }
      },
      compact: async (input: any) => {
        compactions.push(input)
        return { id: "compact" }
      },
    },
    model: {
      list: async () => ({ location: {}, data: [model] }),
      default: async () => ({ location: {}, data: model }),
    },
    tool: {
      transform: async (callback: any) => {
        callback({
          add: (tool: any) => tools.set(tool.name, tool),
          get: () => undefined,
          list: () => [],
          update: () => {},
          remove: () => {},
          namespace: () => {},
        })
        return { dispose: async () => {} }
      },
    },
    event: {
      subscribe: (input?: { signal?: AbortSignal }) => ({
        [Symbol.asyncIterator]() {
          return {
            next: async () => {
              while (!closed && !input?.signal?.aborted) {
                if (queue.length) return { done: false, value: queue.shift() }
                await new Promise((resolve) => setTimeout(resolve, 1))
              }
              return { done: true, value: undefined }
            },
          }
        },
      }),
    },
  }

  return {
    ctx,
    tools,
    compactions,
    getContextHook: () => contextHook,
    pushEvent: (event: any) => queue.push(event),
    close: () => {
      closed = true
    },
  }
}

type Fake = ReturnType<typeof makeContext>

async function withPlugin(
  input: { options?: Record<string, unknown>; session?: SessionInfo; transcript?: any[] },
  run: (fake: Fake) => Promise<void>,
) {
  const fake = makeContext(input.options, input.session, input.transcript)
  const cleanup = await plugin.setup(fake.ctx as never)
  try {
    await run(fake)
  } finally {
    fake.close()
    await cleanup?.()
  }
}

const toolContext = { sessionID: "s1" } as never

test("registers context_remaining and leaves compact_session disabled by default", async () => {
  await withPlugin({}, async (fake) => {
    assert.equal(fake.tools.has("context_remaining"), true)
    assert.equal(fake.tools.has("compact_session"), false)
  })
})

test("context_remaining reports usage and deliberate compaction availability", async () => {
  await withPlugin({ options: { agentCompact: { percent: 50 } } }, async (fake) => {
    const result = await fake.tools.get("context_remaining").execute({}, toolContext)
    assert.match(result.content, /Used: 701k \/ 1000k tokens \(70% used\)/)
    assert.match(result.content, /Remaining: 299k tokens/)
    assert.match(result.content, /Deliberate compaction: available now \(optional\)/)
  })
})

test("context_remaining explains when no usage exists", async () => {
  await withPlugin({ session: emptySession() }, async (fake) => {
    const result = await fake.tools.get("context_remaining").execute({}, toolContext)
    assert.match(result.content, /No context usage has been reported/)
  })
})

test("context hook injects each threshold notice once per session", async () => {
  await withPlugin({ options: { agentCompact: { percent: 50 } } }, async (fake) => {
    const hook = fake.getContextHook()
    assert.ok(hook)

    const first: any[] = []
    await hook!({ sessionID: "s1", system: first })
    assert.equal(first.length, 1)
    assert.match(first[0].text, /context indicator is at 70%/)
    assert.match(first[0].text, /Deliberate compaction: available now/)

    const second: any[] = []
    await hook!({ sessionID: "s1", system: second })
    assert.equal(second.length, 0)
  })
})

test("custom thresholds control notices", async () => {
  await withPlugin({ options: { thresholds: [60, 80] } }, async (fake) => {
    const hook = fake.getContextHook()
    assert.ok(hook)

    const system: any[] = []
    await hook!({ sessionID: "s1", system })
    assert.equal(system.length, 1)
    assert.match(system[0].text, /context indicator is at 70%/)
    assert.match(system[0].text, /notified again when the context reaches 80%/)
  })
})

test("compaction events reset threshold state", async () => {
  await withPlugin({}, async (fake) => {
    const hook = fake.getContextHook()
    assert.ok(hook)

    const first: any[] = []
    await hook!({ sessionID: "s1", system: first })
    assert.equal(first.length, 1)

    const second: any[] = []
    await hook!({ sessionID: "s1", system: second })
    assert.equal(second.length, 0)

    fake.pushEvent({ type: "session.compaction.ended", data: { sessionID: "s1" } })
    await new Promise((resolve) => setTimeout(resolve, 20))

    const third: any[] = []
    await hook!({ sessionID: "s1", system: third })
    assert.equal(third.length, 1)
  })
})

test("compact_session calls session.compact when available", async () => {
  await withPlugin({ options: { agentCompact: { percent: 50 } } }, async (fake) => {
    const result = await fake.tools.get("compact_session").execute({}, toolContext)
    assert.match(result.content, /Compaction scheduled/)
    assert.deepEqual(fake.compactions, [{ sessionID: "s1" }])
  })
})

test("compact_session refuses before the threshold", async () => {
  await withPlugin({ options: { agentCompact: { percent: 90 } }, session: session(100_000) }, async (fake) => {
    const result = await fake.tools.get("compact_session").execute({}, toolContext)
    assert.match(result.content, /not available yet/)
    assert.equal(fake.compactions.length, 0)
  })
})

test("context_remaining includes an estimated breakdown and post-compaction projection", async () => {
  const transcript = [
    {
      type: "assistant",
      tokens: { input: 600_000, output: 1_000 },
      content: [
        {
          type: "tool",
          name: "read",
          state: {
            status: "completed",
            input: { path: "src/a.ts" },
            content: [{ type: "text", text: "A".repeat(40_000) }],
          },
        },
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
  ]

  await withPlugin({ transcript }, async (fake) => {
    await fake.getContextHook()!({
      sessionID: "s1",
      system: [{ type: "text", text: "S".repeat(40_000) }],
      tools: { read: { description: "Read a file" } },
    })
    const result = await fake.tools.get("context_remaining").execute({}, toolContext)
    assert.match(result.content, /Breakdown \(est\.\):/)
    assert.match(result.content, /After compaction: 601k → ~/i)
    assert.match(result.content, /As of:/)
  })
})

test("uses the latest step, not cumulative session totals", async () => {
  const cumulative = session(70_000_000)
  const transcript = [
    {
      type: "assistant",
      tokens: { input: 732, output: 186, reasoning: 131, cache: { read: 281_600, write: 0 } },
      content: [{ type: "text", text: "done" }],
    },
  ]

  await withPlugin({ session: cumulative, transcript }, async (fake) => {
    const result = await fake.tools.get("context_remaining").execute({}, toolContext)
    assert.match(result.content, /Used: 282k \/ 1000k tokens \(28% used\)/)
    assert.doesNotMatch(result.content, /6724%/)
  })
})
