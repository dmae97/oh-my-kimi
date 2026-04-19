---
name: authoring-extensions
description: Use when creating a new omp extension. Covers ExtensionAPI, factory signature, tool/command/event registration, and local-dev testing.
---

# Authoring Extensions

Extensions are the primary way to add capabilities to `oh-my-pi`. A single extension module can register tools the LLM can call, slash commands users can invoke, and event handlers that run throughout the session lifecycle — all from one TypeScript file.

## Minimum viable extension

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("My extension loaded!", "info");
  });
}
```

That is a working extension. Drop it into `~/.omp/agent/extensions/hello.ts` and restart omp to see the notification.

## Full example

The following extension registers a slash command, a tool, and a session-start hook:

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI) {
  const { Type } = pi.typebox;

  // Runs once when the session loads
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(`Session ready in ${ctx.cwd}`, "info");
  });

  // Slash command: /greet
  pi.commands.register("greet", {
    description: "Send a greeting into the conversation",
    handler: async (args, ctx) => {
      const name = args.trim() || "world";
      await pi.sendMessage(`Hello, ${name}!`, { triggerTurn: false });
      ctx.ui.notify(`Greeted ${name}`, "info");
    },
  });

  // LLM-callable tool
  pi.registerTool({
    name: "word_count",
    label: "Word Count",
    description: "Count the words in a string",
    parameters: Type.Object({
      text: Type.String({ description: "Text to count" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const count = params.text.split(/\s+/).filter(Boolean).length;
      return {
        content: [{ type: "text", text: String(count) }],
        details: { count },
      };
    },
  });
}
```

## Discovery path

omp discovers extension modules in this order:

1. **Project-scoped auto-discovery** — `<cwd>/.omp/extensions/`
2. **User-scoped auto-discovery** — `~/.omp/agent/extensions/`
3. **Marketplace-installed plugins** — `~/.claude/plugins/cache/` (extensions shipped inside marketplace plugin packages)
4. **CLI flag** — `omp --extension-path ./my-ext.ts` (also `-e`; `--hook` is treated as an alias)
5. **Settings `extensions` array** — paths listed in `~/.omp/agent/config.yml` or `<cwd>/.omp/settings.json`

Within each scope, de-duplication is by resolved absolute path — first seen wins.

When a path points to a directory, omp resolves the entry point in this order:

1. `package.json` with `omp.extensions` (or legacy `pi.extensions`) field
2. `index.ts`
3. `index.js`
4. One-level scan for `*.ts` / `*.js` files and subdir `index.*` / `package.json` manifests

## package.json manifest

To package an extension as an installable plugin, add an `omp` field to `package.json`:

```json
{
  "name": "my-omp-extension",
  "omp": {
    "extensions": ["./src/main.ts"]
  }
}
```

The legacy `pi` key is also accepted for backwards compatibility:

```json
{
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

Multiple entry points are supported:

```json
{
  "omp": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"]
  }
}
```

## Registering commands

```ts
pi.commands.register("my-cmd", {
  description: "What the command does",
  handler: async (args, ctx) => {
    // args: everything the user typed after /my-cmd
    // ctx: ExtensionCommandContext — includes ctx.ui, ctx.cwd, session controls
    ctx.ui.notify("Running!", "info");
    await ctx.waitForIdle();
    await ctx.newSession();
  },
});
```

`ExtensionCommandContext` session-control methods (safe to call from commands only):

| Method | Effect |
|---|---|
| `waitForIdle()` | Wait for the agent to finish streaming |
| `newSession(opts?)` | Open a fresh session |
| `switchSession(path)` | Switch to an existing session file |
| `branch(entryId)` | Fork from a specific history entry |
| `navigateTree(id, opts?)` | Jump to a different point in the session tree |
| `reload()` | Reload the session runtime |
| `compact(opts?)` | Compact the current context |

## Registering tools

Tools are called by the LLM. Parameters use [TypeBox](https://github.com/sinclairzx81/typebox) schemas, available at `pi.typebox`:

```ts
const { Type } = pi.typebox;

pi.registerTool({
  name: "search_notes",           // snake_case, unique
  label: "Search Notes",          // human-readable label for TUI
  description: "Full-text search through project notes",
  parameters: Type.Object({
    query: Type.String({ description: "Search query" }),
    limit: Type.Optional(Type.Number({ description: "Max results", default: 10 })),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    if (signal?.aborted) {
      return { content: [{ type: "text", text: "Cancelled" }] };
    }
    onUpdate?.({ content: [{ type: "text", text: "Searching..." }] });
    // ... do work ...
    return {
      content: [{ type: "text", text: `Found N results for "${params.query}"` }],
      details: { query: params.query, count: 0 },
    };
  },
});
```

## Subscribing to events

```ts
pi.on("tool_call", async (event, ctx) => {
  // event.toolName, event.input, event.toolCallId
  if (event.toolName === "bash" && event.input.command?.includes("rm -rf /")) {
    return { block: true, reason: "Blocked by safety policy" };
  }
});

pi.on("turn_end", async (_event, ctx) => {
  ctx.ui.setStatus("tokens", `~${ctx.getContextUsage()?.total ?? "?"} tokens`);
});
```

Full event catalog: see [hooks authoring guide](./authoring-hooks.md).

## Extension vs hook — when to use which

| Need | Use |
|---|---|
| Tools + commands + events in one module | **Extension** (`ExtensionAPI`) |
| Pure event interception (policy, redaction) | **Extension** or **Hook** (both work; extension is preferred) |
| Legacy hook module already exists | **Hook** (`HookAPI` from `@oh-my-pi/pi-coding-agent/hooks`) |
| Registering provider / custom message renderer | **Extension only** |
| Shipping as a marketplace plugin | **Extension** (use `package.json` manifest) |

Extensions are a strict superset of hooks. New authoring should use `ExtensionAPI`.

## Debugging

Start omp with `--log-level debug` to see extension load messages:

```
omp --log-level debug
```

Watch for lines like:

```
[extension-loader] loading /home/you/.omp/agent/extensions/my-ext.ts
[extension-loader] loaded: my-ext (1 tool, 1 command, 2 handlers)
```

To temporarily disable a specific extension by name without removing the file:

```yaml
# ~/.omp/agent/config.yml
disabledExtensions:
  - extension-module:my-ext
```

The derived name is the filename stem (or directory name for `index.ts`-style entries): `/path/to/my-ext.ts` → `my-ext`.

## Important constraints

- **Do not call runtime actions during load.** Methods like `pi.sendMessage()` throw `ExtensionRuntimeNotInitializedError` until after `initialize()` completes. Register handlers/tools/commands during load; perform runtime actions only from event handlers, tools, or commands.
- **`tool_call` errors are fail-closed.** If a `tool_call` handler throws, the tool is blocked.
- **Command names must not clash with built-ins.** Conflicts are skipped with a diagnostic log.
- **Reserved shortcuts are ignored** (`ctrl+c`, `ctrl+d`, `ctrl+z`, `ctrl+k`, `ctrl+p`, `ctrl+l`, `ctrl+o`, `ctrl+t`, `ctrl+g`, `shift+tab`, `shift+ctrl+p`, `alt+enter`, `escape`, `enter`).

## Further reading

- `docs/extensions.md` — runtime internals and full API surface reference
- `docs/extension-loading.md` — detailed path resolution rules
- `docs/hooks.md` — hook subsystem internals
- `docs/skills/examples/hello-extension/` — complete working example
