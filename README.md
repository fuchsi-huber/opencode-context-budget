# opencode-context-budget

An [OpenCode](https://opencode.ai) plugin that tells agents how much of the
model's context window is left.

It adds:

- **`context_remaining` tool** – returns used tokens, context limit, remaining
  tokens, percentage, the next automatic warning threshold, automatic
  compaction status, and when the value was last updated.
- **Automatic threshold notices** – injects a short system message when the
  context indicator reaches 50%, 75%, and 90%.
- **Optional deliberate compaction** – a `compact_session` tool agents can call
  at a safe stopping point. Compaction is scheduled and runs after the turn.
- **Built-in compaction reporting** – reports when OpenCode's own automatic
  compaction will run. The plugin reads OpenCode's `compaction` config and does
  not modify it.

The numbers come from the latest provider-reported token usage, so they match
the context indicator in the OpenCode UI sidebar (they are not a tokenizer
estimate).

## Automatic compaction

OpenCode already has automatic compaction. This plugin does **not** run a second
compaction system; it reports the built-in one and leaves the settings alone.
Configure it in `opencode.json(c)`:

```jsonc
{
  "compaction": {
    "auto": true,
    "reserved": 50000
  }
}
```

`compaction.reserved` is the token buffer OpenCode leaves before triggering
compaction (default: `min(20000, maxOutputTokens)`), so `50000` means "compact
when about 50k tokens remain". It is a token buffer, not a percentage, because
the buffer is global while context limits vary per model. If `compaction.auto`
is `false`, the plugin reports `Automatic compaction (built-in): disabled.`

There is currently no dedicated CLI command for these settings; edit the config
file (see below). Verify the resolved values with:

```sh
opencode debug config
```

## Options

Options are passed with the tuple form of the `plugin` config entry:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "/home/you/code/opencode-context-budget",
      {
        "agentCompact": { "percent": 50 }
      }
    ]
  ]
}
```

### `agentCompact`

Registers the `compact_session` tool. It is available once either threshold is
reached (whichever comes first):

```jsonc
"agentCompact": { "percent": 50 }                // available from 50% used
"agentCompact": { "remainingTokens": 200000 }    // available when <= 200k remain
"agentCompact": true                             // same as { "percent": 50 }
"agentCompact": false                            // disabled (default)
```

Availability is intentionally **not** a separate alert. The usual 50/75/90
notices mention it only once it is available, and the wording is optional, not
urgent: the agent may compact if it already happens to be at a natural stopping
point, but should not interrupt a multi-step task just to compact.

## Install

This package targets OpenCode 1.x (the `plugin` config key and the
`@opencode-ai/plugin` plugin API). OpenCode 2 uses a different plugin API.

### Option 1: clone and reference the directory

```sh
git clone <this-repo-url> ~/code/opencode-context-budget
```

Then add the directory to your global config, `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/home/you/code/opencode-context-budget"]
}
```

Use the absolute path to the cloned repository. The directory contains a
`package.json` whose `exports["./server"]` points at the plugin entry, so it can
be loaded as a plugin package.

To pass options, replace the plain string with the tuple form shown under
[Options](#options). The `opencode plugin` CLI writes the plain string form, so
edit the config by hand if you want to set `agentCompact`.

### Option 2: let the OpenCode CLI install it

```sh
opencode plugin /home/you/code/opencode-context-budget --global
```

Or install straight from a Git host once the repository is pushed:

```sh
opencode plugin github:you/opencode-context-budget --global
```

The CLI installs the package and writes the entry into your config for you.

### Option 3: install from npm

Once published:

```sh
opencode plugin opencode-context-budget --global
```

Restart OpenCode after changing the config; plugins are loaded at startup.

## Verify

Start a session and ask the agent to call `context_remaining`, or check the
plugin list / logs. With deliberate compaction enabled the output looks like:

```text
Context (matches the UI sidebar)
Used: 700k / 1.0M tokens (70% used)
Remaining: 300k tokens
Next automatic notification: when context reaches 75%.
Automatic compaction (built-in): at ~20k tokens remaining (~98% used).
Deliberate compaction: available now (optional). At a natural stopping point, save important state to files or todos, then call compact_session. Do not interrupt current work just to compact.
Updated: assistant response completed at 2026-11-13T11:23:51.031Z.
Model: openrouter/~deepseek/deepseek-flash-latest
Source: latest provider-reported token usage, not a tokenizer estimate.
```

## How it works

- `src/server.ts` is the plugin entry. It registers `context_remaining` (and
  optionally `compact_session`), reads the effective native `compaction` config
  in the `config` hook, and hooks `experimental.chat.system.transform` to push
  threshold notices. It never modifies the `compaction` settings.
- `src/lib/context-budget.ts` contains the pure logic: reading assistant token
  usage, resolving the model's context limit from the provider list, computing
  percentages/remaining budget, mirroring OpenCode's built-in overflow formula,
  and formatting messages.
- Deliberate compaction is scheduled by the tool and executed on the next
  `session.idle` event. It cannot safely call the compaction endpoint
  synchronously from inside a tool: OpenCode serializes runs per session, so
  awaiting compaction mid-turn would wait on the run that is waiting for the
  tool.
- Threshold notices are sent at most once per session and threshold. Session
  state is cleared on `session.compacted` and `session.deleted`.
- The plugin has no runtime dependencies. It only uses type-only imports from
  `@opencode-ai/plugin`, which OpenCode already provides.

## Development

```sh
npm install
npm test
npm run typecheck
```

The plugin runs directly from TypeScript because OpenCode runs on Bun. There is
no build step.

## License

MIT
