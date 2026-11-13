import test from "node:test"
import assert from "node:assert/strict"

import plugin from "../src/server.ts"

const providers = [
  {
    id: "openrouter",
    models: {
      m: { limit: { context: 1_000_000, input: 1_000_000, output: 32_000 } },
    },
  },
]

function entriesWith(input: number) {
  return [
    {
      info: {
        id: "msg",
        role: "assistant" as const,
        providerID: "openrouter",
        modelID: "m",
        time: { created: 1_699_999_999_000, completed: 1_700_000_000_000 },
        tokens: { input, output: 1_000 },
      },
      parts: [{ type: "text" }],
    },
  ]
}

type SummarizeInput = { path: { id: string }; body: { providerID: string; modelID: string } }

function fakeClient(
  entries: ReturnType<typeof entriesWith>,
  summarize: (input: SummarizeInput) => Promise<{ data: boolean }> = async () => ({ data: true }),
) {
  return {
    session: {
      messages: async () => ({ data: entries }),
      summarize,
    },
    config: {
      providers: async () => ({ data: { providers } }),
    },
  }
}

const context = { sessionID: "s1", directory: "/tmp" } as never

test("config hook reads native compaction settings without changing them", async () => {
  const hooks = await plugin({ client: fakeClient(entriesWith(500_000)) } as never, {})
  const config: { compaction?: { auto?: boolean; reserved?: number } } = {
    compaction: { auto: true, reserved: 50_000 },
  }
  await hooks.config?.(config as never)
  assert.deepEqual(config.compaction, { auto: true, reserved: 50_000 })

  const tool = hooks.tool?.context_remaining
  assert.ok(tool)
  const result = String(await tool.execute({}, context))
  assert.match(result, /Automatic compaction \(built-in\): at ~50k tokens remaining/)
})

test("config hook respects native auto compaction being disabled", async () => {
  const hooks = await plugin({ client: fakeClient(entriesWith(500_000)) } as never, {})
  const config: { compaction?: { auto?: boolean; reserved?: number } } = { compaction: { auto: false } }
  await hooks.config?.(config as never)
  assert.deepEqual(config.compaction, { auto: false })

  const tool = hooks.tool?.context_remaining
  assert.ok(tool)
  const result = String(await tool.execute({}, context))
  assert.match(result, /Automatic compaction \(built-in\): disabled/)
})

test("compact_session is only registered when deliberate compaction is enabled", async () => {
  const off = await plugin({ client: fakeClient(entriesWith(0)) } as never, {})
  assert.equal("compact_session" in (off.tool ?? {}), false)

  const on = await plugin({ client: fakeClient(entriesWith(0)) } as never, { agentCompact: true })
  assert.equal("compact_session" in (on.tool ?? {}), true)
})

test("compact_session refuses before the threshold", async () => {
  const hooks = await plugin({ client: fakeClient(entriesWith(100_000)) } as never, { agentCompact: { percent: 50 } })
  const tool = hooks.tool?.compact_session
  assert.ok(tool)
  const result = await tool.execute({}, context)
  assert.match(String(result), /not available yet/)
  assert.match(String(result), /50% used/)
})

test("compact_session schedules and runs compaction on the next idle event", async () => {
  const calls: SummarizeInput[] = []
  const client = fakeClient(entriesWith(700_000), async (input) => {
    calls.push(input)
    return { data: true }
  })
  const hooks = await plugin({ client } as never, { agentCompact: { percent: 50 } })
  await hooks.config?.({} as never)

  const tool = hooks.tool?.compact_session
  assert.ok(tool)
  const result = await tool.execute({}, context)
  assert.match(String(result), /Compaction scheduled/)
  assert.equal(calls.length, 0)

  const system = { system: [] as string[] }
  await hooks["experimental.chat.system.transform"]?.({ sessionID: "s1" } as never, system)
  assert.equal(system.system.length, 1)

  await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "s1" } } } as never)
  assert.deepEqual(calls, [{ path: { id: "s1" }, body: { providerID: "openrouter", modelID: "m" } }])
})

test("context_remaining includes built-in and deliberate compaction status", async () => {
  const hooks = await plugin({ client: fakeClient(entriesWith(700_000)) } as never, { agentCompact: { percent: 50 } })
  await hooks.config?.({} as never)

  const tool = hooks.tool?.context_remaining
  assert.ok(tool)
  const result = String(await tool.execute({}, context))
  assert.match(result, /Automatic compaction \(built-in\): at ~20k tokens remaining \(~98% used\)/)
  assert.match(result, /Deliberate compaction: available now \(optional\)/)
})
