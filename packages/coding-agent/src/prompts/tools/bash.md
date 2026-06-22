Runs bash in a shell session — terminal ops: git, bun, cargo, python.

<instruction>
- `cwd` sets the working dir, not `cd dir && …`
- `env: { NAME: "…" }` for multiline / quote-heavy / untrusted values; reference `$NAME`
- Quote expansions (`"$NAME"`) to preserve exact content
- `pty: true` only when the command needs a real terminal (`sudo`, `ssh` needing input); default `false`
- `;` only when later commands should run despite earlier failures
- Multiple bash calls per message run concurrently. NEVER split order-dependent commands across parallel calls — chain with `&&` in one call.
- Internal URIs (`skill://`, `agent://`, …) auto-resolve to FS paths
{{#if asyncEnabled}}
- `async: true` for long-running commands when you don't need immediate output: returns a background job ID; result delivered as a follow-up.
{{/if}}
</instruction>

<critical>
- NEVER trim or silence output: no `| head -n N`, `| tail -n N`, `| less`, `2>&1`, `2>/dev/null`. stderr already merged; long output auto-truncated, FULL capture kept at `artifact://<id>`.
- Pipelines that COMPUTE a new fact are correct bash: `wc -l`, `sort | uniq -c`, `comm`, `cut`, `diff a b`, `shasum`. Litmus: produces a count, frequency table, set difference, or checksum no tool returns → bash. Merely moves or trims bytes a tool can fetch → use the tool.
</critical>

<output>
- Returns output; exit code shown on non-zero exit.
- Truncated output → `artifact://<id>` (linked in metadata).
</output>

{{#if asyncEnabled}}
# Timeout and async

- `timeout` (seconds) caps wall-clock duration; the process is killed on elapse.
- `async: true` defers only reporting — it does NOT extend the timeout; a daemon run with `async: true` is still killed when `timeout` elapses.
- Long-running daemons (dev servers, watchers): pass a large explicit `timeout`. The shell session persists across calls, so `cmd &` keeps running between bash calls.
{{/if}}
{{#if autoBackgroundEnabled}}

## Auto-background

- A long-running foreground call may convert to a background job; the final result arrives as a follow-up tool call. NOT a failure — don't retry or wait synchronously.
- Need the result inline (e.g. piping into another command)? Raise `timeout` above expected duration{{#if asyncEnabled}}, or set `async: true` up front{{/if}}.
{{/if}}

# Output minimizer

- Long output truncated; test/lint runner output filtered to failures. When visible text changed, a `[raw output: artifact://<id>]` footer links the full capture — read it if a run looks suspicious or you need exact bytes.
- No footer = what you see is exactly what the command emitted.
