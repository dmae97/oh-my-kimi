Executes bash command in shell session for terminal operations like git, bun, cargo, python.

<instruction>
- Use `cwd` to set working directory, not `cd dir && …`
- Prefer `env: { NAME: "…" }` for multiline, quote-heavy, or untrusted values; reference as `$NAME`
- Quote variable expansions like `"$NAME"` to preserve exact content
- PTY mode is opt-in: set `pty: true` only when the command needs a real terminal (e.g. `sudo`, `ssh` requiring user input); default is `false`
- Use `;` only when later commands should run regardless of earlier failures
- Multiple bash calls in one message run concurrently. NEVER split order-dependent commands across parallel calls — chain them with `&&` in a single call.
- Internal URIs (`skill://`, `agent://`, etc.) are auto-resolved to filesystem paths
{{#if asyncEnabled}}
- Use `async: true` for long-running commands when you don't need immediate output; the call returns a background job ID and the result is delivered automatically as a follow-up.
{{/if}}
</instruction>

<critical>
- NEVER use shell to fetch, display, list, page, or search content a dedicated tool serves: `cat`/`head`/`tail`/`less`/`more`/`ls` → `read`; `grep`/`rg`/`ag`/`ack` → `search`; `find`/`fd` → `find`; `sed -i`/`perl -i`/`awk -i` → `edit`; `echo >`/heredoc → `write`. The tools keep gitignore semantics, line anchors, and structured output that shell loses.
- NEVER trim or silence output: no `| head -n N`, `| tail -n N`, `| less`, `2>&1`, `2>/dev/null`. stderr is already merged; long output is auto-truncated with the FULL capture kept at `artifact://<id>`. Defensive trimming is a habit from harnesses without artifact recovery — here it only destroys data the artifact would have saved.
- Pipelines that COMPUTE a new fact are correct bash: `wc -l`, `sort | uniq -c`, `comm`, `cut`, `diff a b`, `shasum`. Litmus: produces a count, frequency table, set difference, or checksum no tool returns → bash. Merely moves or trims bytes a tool can fetch → use the tool.
</critical>

<output>
- Returns output and exit code.
- Truncated output is retrievable from `artifact://<id>` (linked in metadata)
- Exit codes shown on non-zero exit
</output>

{{#if asyncEnabled}}
# Timeout and async

- `timeout` (seconds) caps the **wall-clock duration** of the command. When it elapses the process is killed and the call returns with a timeout annotation. Range: `1`–`3600`s; default `300`s.
- `async: true` only defers **reporting** of the result — it does NOT disable, extend, or detach the timeout. A daemon started with `async: true` is still killed when `timeout` elapses, regardless of how long the agent waits before reading the result.
- For long-running daemons (dev servers, watchers): pass an explicit large `timeout` (up to `3600`). The shell session persists across calls, so a backgrounded job (`cmd &`) keeps running between bash calls on its own.
{{/if}}
{{#if autoBackgroundEnabled}}

## Auto-background

- A foreground call still running after **{{autoBackgroundThresholdSeconds}}s** converts to a background job: you get a `Background job <id> started` notice plus the output so far, and the final result arrives as a follow-up tool call. The command keeps running — this is NOT a failure; do not retry it and do not wait synchronously.
- Auto-backgrounding does NOT extend `timeout`: the job is still killed at the original deadline.
- Need the result inline (e.g. piping into another command)? Raise `timeout` above the expected duration{{#if asyncEnabled}}, or set `async: true` up front{{/if}}.
{{/if}}

# Output minimizer

- Long output is truncated and test/lint runner output is filtered down to failures. Whenever the visible text was changed, a `[raw output: artifact://<id>]` footer links the full capture — read it if a run looks suspicious or you need the exact bytes.
- No footer = what you see is exactly what the command emitted.
