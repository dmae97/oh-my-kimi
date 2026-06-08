Executes bash command in shell session for terminal operations like git, bun, cargo, python.

<instruction>
- Use `cwd` to set working directory, not `cd dir && …`
- Prefer `env: { NAME: "…" }` for multiline, quote-heavy, or untrusted values; reference as `$NAME`
- Quote variable expansions like `"$NAME"` to preserve exact content
- PTY mode is opt-in: set `pty: true` only when the command needs a real terminal (e.g. `sudo`, `ssh` requiring user input); default is `false`
- Use `;` only when later commands should run regardless of earlier failures
- Internal URIs (`skill://`, `agent://`, etc.) are auto-resolved to filesystem paths
{{#if asyncEnabled}}
- Use `async: true` for long-running commands when you don't need immediate output; the call returns a background job ID and the result is delivered automatically as a follow-up.
{{/if}}
</instruction>

<critical>
- NEVER use Linux coreutils (`cat`, `head`, `tail`, `less`, `more`, `ls`, `grep`, `rg`, `awk`, `sed`, `find`, `fd`, etc.) when a dedicated tool suffices — ALWAYS prefer `read`, `search`, `find`, `edit`, `write`.
- NEVER pipe through `| head -n N` or `| tail -n N` — output is already truncated with the full result available via `artifact://<id>`.
- NEVER redirect with `2>&1` or `2>/dev/null` — stdout and stderr are already merged.
</critical>

<output>
- Returns output and exit code.
- Truncated output is retrievable from `artifact://<id>` (linked in metadata)
- Exit codes shown on non-zero exit
</output>

{{#if asyncEnabled}}
# Timeout and async

- `timeout` (seconds) caps the **wall-clock duration** of the command. When it elapses the process is killed and the call returns with a timeout annotation. Range: `1`–`3600`s; default `300`s (see `clampTimeout("bash", …)` in `tool-timeouts.ts`).
- `async: true` only defers **reporting** of the result — it does NOT disable, extend, or detach the timeout. A daemon started with `async: true` is still killed when `timeout` elapses, regardless of how long the agent waits before reading the result.
- For long-running daemons (dev servers, watchers): either pass an explicit large `timeout` (up to `3600`), or fully detach the process from this shell using `nohup …  &` / `setsid … &` / `disown` so it survives independent of the bash call's lifecycle.
{{/if}}
{{#if autoBackgroundEnabled}}

## Auto-background

- A foreground (non-`async`) call that has not completed within **{{autoBackgroundThresholdSeconds}}s** is automatically converted into a background job and returns a `Background job <id> started: …` notice with the buffered output so far. The command keeps running; the final result is delivered as a follow-up tool call when it completes.
- This is NOT a failure or a re-queue. Treat the notice as "still running, will report back" — do not retry the same command, and do not wait synchronously for it.
- Auto-backgrounding does NOT extend `timeout`: the job is still killed at the original deadline.
- If you need the result inline (e.g. piping into another command), raise `timeout` above the expected duration so it finishes before the threshold matters{{#if asyncEnabled}}, or set `async: true` up front so the contract is explicit{{/if}}.
{{/if}}

# Output minimizer

- Bash stdout/stderr may be rewritten before you see it: long output is head/tail truncated, and test/lint runners (e.g. `bun test`, `cargo test`, ESLint) are passed through heuristic filters that drop noise and keep failures.
- When the minimizer changes the visible text, the tool appends a `[raw output: artifact://<id>]` footer pointing at the **full untouched capture**. If a run looks suspicious (e.g. only a version banner) or you need the exact bytes, read that artifact.
- If no footer is present, what you see is what the command actually emitted.
