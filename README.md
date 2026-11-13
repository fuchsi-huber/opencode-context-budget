# opencode-context-budget

An [OpenCode](https://opencode.ai) plugin that tells agents how much of the
model's context window is left.

It adds:

- **`context_remaining` tool** – returns used tokens, context limit, remaining
  tokens, percentage, the next automatic warning threshold, and when the value
  was last updated.
- **Automatic threshold notices** – injects a short system message when the
  context indicator reaches 50%, 75%, and 90%.

The numbers come from the latest provider-reported token usage, so they match
the context indicator in the OpenCode UI sidebar (they are not a tokenizer
estimate).

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
plugin list / logs. The tool output looks like:

```text
Context (matches the UI sidebar)
Used: 13k / 1048k tokens (1% used)
Remaining: 1035k tokens
Next automatic notification: when context reaches 50%.
Updated: assistant response completed at 2026-11-13T11:23:51.031Z.
Model: openrouter/~deepseek/deepseek-flash-latest
Source: latest provider-reported token usage, not a tokenizer estimate.
```

## How it works

- `src/server.ts` is the plugin entry. It registers the `context_remaining`
  tool and hooks `experimental.chat.system.transform` to push threshold notices.
- `src/lib/context-budget.ts` contains the pure logic: reading assistant token
  usage, resolving the model's context limit from the provider list, computing
  percentages/remaining budget, and formatting messages.
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
