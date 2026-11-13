# opencode-context-budget

An [OpenCode](https://opencode.ai) 2.x plugin that tells agents how much of the
model's context window is left.

## What it does

- **`context_remaining` tool** — provider-reported usage plus estimated
  breakdowns (system/tools, user, assistant, tool output), reclaimable stale
  file reads, a burn-rate ETA in turns, a post-compaction estimate, and the turn
  the value is current as of.
- **Automatic threshold notices** — adds a short system message when context
  usage reaches the configured thresholds (default 50%, 75%, and 90%).
- **Optional `compact_session` tool** — lets an agent request a deliberate
  compaction at a safe stopping point.

The numbers come from the latest provider-reported token usage, so they match
the context indicator in the OpenCode UI sidebar (they are not a tokenizer
estimate).

## Compatibility

This package targets OpenCode 2.x: the `plugins` config key and the
`@opencode/plugin` API. The package declares `opencode >=2.0.0`.

## Installation

This plugin is distributed from GitHub; it is not published on npm.

### Install with the OpenCode CLI (recommended)

```sh
opencode plugin add github:fuchsi-huber/opencode-context-budget
```

The CLI installs the package and adds it to your global config. It writes the
plain-string form of the plugin entry. To pass options, edit the config and use
the object form shown under [Configuration](#configuration).

### Clone and reference the directory (fallback)

```sh
git clone https://github.com/fuchsi-huber/opencode-context-budget.git ~/code/opencode-context-budget
```

Add the absolute path to `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/home/you/code/opencode-context-budget"]
}
```

Configured local plugin paths must be directories. The package entry is
`src/server.ts`.

Restart OpenCode after changing the config; plugins are loaded at startup.

## Configuration

### Plugin options

Options use the object form of the `plugins` entry:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:fuchsi-huber/opencode-context-budget",
      "options": {
        "thresholds": [50, 75, 90],
        "agentCompact": { "percent": 50 }
      }
    }
  ]
}
```

For a local clone, use the absolute directory as `package`.

#### `thresholds`

Percentages at which the plugin injects a context notice. Defaults to
`[50, 75, 90]`.

```jsonc
"thresholds": [50, 75, 90] // default
"thresholds": [60, 80]     // two notices
```

Values must be numbers greater than 0 and at most 100. They are rounded to
integers, deduplicated, and sorted. An empty or invalid list falls back to the
default thresholds.

#### `agentCompact`

Controls registration and gating of the `compact_session` tool. It is disabled
by default.

```jsonc
"agentCompact": { "percent": 50 }             // available from 50% used (default gate for `true`)
"agentCompact": { "remainingTokens": 200000 } // available when 200k or fewer tokens remain
"agentCompact": true                          // same as { "percent": 50 }
"agentCompact": false                         // disabled (default)
```

If both `percent` and `remainingTokens` are set, the tool becomes available when
either condition is met. An object with neither a valid `percent` nor a valid
`remainingTokens` behaves like `true`. `percent` must be greater than 0 and at
most 100; `remainingTokens` must be a positive number.

`agentCompact` does not create a separate notification milestone. The normal
threshold notices mention deliberate compaction only when it is currently
available.

## Agent-facing output

Example `context_remaining` result with deliberate compaction enabled:

```text
Context (matches the UI sidebar)
Used: 700k / 1000k tokens (70% used)
Remaining: 300k tokens
As of: end of turn 12, before this request (+~3k pending, est.).
Next automatic notification: when context reaches 75% (in ~8 turns at the current rate).
Breakdown (est.): system+tools 42k · user 8k · assistant 55k · tool output 595k
  tools: read 320k · grep 150k · shell 80k · edit 45k
Reclaimable (est.): ~30k from read outputs of 4 files changed since.
After compaction: ~65k tokens (est.; default 15k keep window).
Deliberate compaction: available now (optional). At a natural stopping point, save important state to files or todos, then call compact_session. Do not interrupt current work just to compact.
Model: openrouter/~deepseek/deepseek-flash-latest
Source: provider-reported totals; breakdown, reclaimable, and ETA are estimates.
```

Before any model request reports token usage, the tool explains that no context
value is available yet.

## Behavior details

- Threshold notices are registered through `ctx.session.hook("context")`. The
  plugin records the highest configured threshold reached and sends each notice
  at most once per session and threshold. If usage jumps past several
  thresholds, only the highest crossed threshold is reported.
- Threshold state is cleared on `session.compaction.ended` and `session.deleted`
  events.
- `compact_session` refuses until the configured `agentCompact` gate is met or
  when no usage has been reported. When it is allowed, it calls
  `ctx.session.compact({ sessionID })` and returns immediately. OpenCode runs
  the compaction at the next safe step boundary; repeated requests while one is
  pending merge into it.
- The `context_remaining` tool also estimates a breakdown by serialising the
  request's system prompt and tool definitions and the transcript's user,
  assistant, and tool content. Read outputs for files edited after the read are
  reported as reclaimable. The ETA uses the average context growth over recent
  turns, and the post-compaction estimate assumes the default 15k keep window.
  These are estimates; the total usage is provider-reported.
- The detailed breakdown is only in the tool output. Threshold notices stay
  short.
- Failed reads or compaction requests are reported to the agent as text and do
  not break the session.
- The plugin imports `Plugin` from `@opencode/plugin`, which OpenCode provides.

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
