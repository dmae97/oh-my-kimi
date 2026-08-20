# Environment Variables

OMK uses environment variables in three ways:

- Variables such as `OMK_OFFLINE` configure the OMK process.
- OMK sets `OMK_CODING_AGENT` so child processes can detect that they run inside OMK.
- Commands run by the LLM-callable bash tool receive `PI_*` variables describing the current session.

Provider API-key variables are documented separately in [Providers](providers.md). `XAI_API_KEY` is an xAI Platform API-billing credential; it is not the OAuth credential created by `/login` and cannot populate weekly SuperGrok usage/reset.

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
| `PI_REASONING_LEVEL` | Current effective reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `ultra` |

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

These variables are read by OMK itself. The four built-in harness flags below are enabled when unset. Any of `0`, `false`, `off`, `disable`, or `disabled` disables the corresponding built-in; matching is case-insensitive and ignores surrounding whitespace. `--no-extensions` does not disable these first-party built-ins.

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
| `OMK_VERIFIED_BASH` | Default-on verified bash adapter for AgentSession/CLI bash. Set to `0` to opt out and use the legacy unverified path (see [SDK — Evidence and Verification](sdk.md#evidence-and-verification)) |
| `OMK_BASH_SANDBOX` | AgentSession built-in local bash mode. Unset or unknown values select `enforce`: macOS `sandbox-exec` or Linux `bwrap`, workspace/temp writes only, network disabled, and fail closed without a usable backend. Explicit `audit` selects the unwrapped ledger-only path; `0`/`off` disables the preflight. Use `off` only when a verified outer whole-process sandbox owns isolation; it does not isolate OMK by itself |
| `LIVE_E2E` | Test-only: keep provider credentials so live-API e2e suites run on purpose (default scrubbed for hermetic tests) |
| `OMK_OMP_SEAMS` | Default-on OMP pure seams for `read`/`grep`. Set to `0` to opt out |
| `OMK_IDENTICAL_LOOP` | Default-on consecutive-loop guard. Warns from the third identical `tool+args` call and blocks the sixth. Set a disabling value to opt out |
| `OMK_TOOL_PAIR_REPAIR` | Default-on outbound-context repair. Removes unmatched tool-use and tool-result blocks before provider requests without rewriting the transcript. Set a disabling value to opt out |
| `OMK_PROMPT_PRESET` | Default-on model-specific guidance for supported Claude/Anthropic, Kimi, GLM/ZAI, and Grok/xAI models. Set a disabling value to opt out |
| `OMK_CLAUDE_CONTEXT_FILES` | Claude models omit discovered `AGENTS.md` and `CLAUDE.md` files by default to prevent unrelated context from causing provider false positives. Set to `1`, `true`, `on`, or `yes` to restore them |
| `OMK_GOAL_CONTROLLER` | Default-on working-directory `/goal` command and automatic continuation. Goals created by `/goal` use an eight-round cap. Set a disabling value to opt out |
| `OMK_GROK_HARNESS` | Default-on native `xai` provider dispatch to the `grok-harness` loadout. `0`, `false`, `off`, or `no` disables it |
| `OMK_DOMAIN_ROUTING` | Set to `1` to enable general prompt-based domain routing. Native xAI harness dispatch does not require it |
| `VISUAL`, `EDITOR` | External editor fallback when `externalEditor` is unset |
| `HTTP_PROXY`, `HTTPS_PROXY` | Proxy outbound HTTP requests |

Provider credentials such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and cloud-provider configuration are listed in [Providers](providers.md).
