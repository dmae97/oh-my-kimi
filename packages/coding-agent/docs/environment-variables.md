# Environment Variables

OMK uses environment variables in three ways:

- Variables such as `OMK_OFFLINE` configure the OMK process.
- OMK sets `OMK_CODING_AGENT` so child processes can detect that they run inside OMK.
- Commands run by the LLM-callable bash tool receive `PI_*` variables describing the current session.

Provider API-key variables are documented separately in [Providers](providers.md).

## Process Marker

The CLI and RPC entry points set `OMK_CODING_AGENT=true`. Child processes inherit it and can use it to detect that they run inside OMK. It is not session-specific and is not set automatically when OMK is embedded through the SDK.

## Bash Tool Session Environment

Commands run by the bash tool receive the current session state (the `PI_*` names are kept for upstream Pi compatibility):

| Variable | Description |
| --- | --- |
| `PI_SESSION_ID` | Current session ID |
| `PI_SESSION_FILE` | Absolute path to the current session JSONL file; unset for ephemeral sessions |
| `PI_PROVIDER` | Currently selected model provider |
| `PI_MODEL` | Currently selected model ID |
| `PI_REASONING_LEVEL` | Current effective reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |

The values are resolved when each command starts. Switching models or changing the reasoning level therefore affects the next bash command without restarting OMK. `PI_PROVIDER` and `PI_MODEL` identify the selected OMK model, not a different upstream model that a router may choose internally.

Inherited parent-process values for these variables are always stripped first, so a nested OMK session never exposes stale parent-session metadata.

When asked which model or provider is running, inspect these variables instead of inferring the answer from the system prompt:

```bash
printf '%s/%s\n' "$PI_PROVIDER" "$PI_MODEL"
printf 'reasoning=%s session=%s\n' "$PI_REASONING_LEVEL" "$PI_SESSION_ID"
```

The session file can be inspected directly when the session is persistent:

```bash
if [ -n "$PI_SESSION_FILE" ]; then
  tail -n 1 "$PI_SESSION_FILE"
fi
```

These variables are injected into the LLM-callable bash tool. They are not injected into user-entered `!` or `!!` commands.

### Custom Bash Tools

Bash tools created with `createBashTool()` expose the session environment by default. Injection happens before `spawnHook`, so a hook receives the variables in `ctx.env`:

```typescript
const bashTool = createBashTool(cwd, {
  spawnHook: (ctx) => ({
    ...ctx,
    env: { ...ctx.env, CI: "1" },
  }),
});
```

Disable session metadata independently of the spawn hook:

```typescript
const bashTool = createBashTool(cwd, {
  exposeSessionEnvironment: false,
  spawnHook: (ctx) => ctx,
});
```

When disabled, OMK removes inherited values for these variables so nested OMK processes do not expose stale parent-session metadata.

## OMK Process Configuration

These variables are read by OMK itself:

| Variable | Description |
| --- | --- |
| `OMK_CODING_AGENT_DIR` | Override the config directory; default is `~/.omk/agent` |
| `OMK_CODING_AGENT_SESSION_DIR` | Override session storage; overridden by `--session-dir` |
| `OMK_PACKAGE_DIR` | Override the package directory, useful for Nix/Guix store paths |
| `OMK_OFFLINE` | Disable startup network operations, including update checks and install/update telemetry |
| `OMK_SKIP_VERSION_CHECK` | Disable the latest-version request |
| `OMK_TELEMETRY` | Override install/update telemetry and provider attribution headers: `1`/`true`/`yes` or `0`/`false`/`no` |
| `OMK_SHARE_VIEWER_URL` | Override the base URL used by `/share` |
| `OMK_HARDWARE_CURSOR` | Set to `1` to show the hardware cursor; see [Terminal setup](terminal-setup.md) |
| `OMK_CONTEXT_GOVERNOR` | Configure the context-budget governor; see `context-budget-*` sources |
| `VISUAL`, `EDITOR` | External editor fallback when `externalEditor` is unset |
| `HTTP_PROXY`, `HTTPS_PROXY` | Proxy outbound HTTP requests |

Provider credentials such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and cloud-provider configuration are listed in [Providers](providers.md).
