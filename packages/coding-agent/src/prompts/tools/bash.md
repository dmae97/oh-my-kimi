Executes bash command in shell session for terminal operations like git, bun, cargo, python.

<instruction>
- Use `cwd` to set working directory, not `cd dir && …`
- Prefer `env: { NAME: "…" }` for multiline, quote-heavy, or untrusted values; reference as `$NAME`
- Quote variable expansions like `"$NAME"` to preserve exact content
- PTY mode opt-in: set `pty: true` only when command needs real terminal (e.g. `sudo`, `ssh` requiring user input); default `false`
- Use `;` only when later commands SHOULD run regardless of earlier failures
- Internal URIs (`skill://`, `agent://`, etc.) auto-resolve to filesystem paths
{{#if asyncEnabled}}
- Use `async: true` for long-running commands when no immediate output needed; call returns background job ID, result delivered automatically as follow-up.
{{/if}}
</instruction>

<critical>
- NEVER use Linux coreutils (`cat`, `head`, `tail`, `less`, `more`, `ls`, `grep`, `rg`, `awk`, `sed`, `find`, `fd`, etc.) when dedicated tool suffices — ALWAYS prefer `read`, `search`, `find`, `edit`, `write`.
- NEVER pipe through `| head -n N` or `| tail -n N` — output already truncated with full result available via `artifact://<id>`.
- NEVER redirect with `2>&1` or `2>/dev/null` — stdout and stderr already merged.
</critical>

<output>
- Returns output and exit code.
- Truncated output retrievable from `artifact://<id>` (linked in metadata)
- Exit codes shown on non-zero exit
</output>

{{#if asyncEnabled}}
# Timeout and async

- `timeout` (seconds) caps **wall-clock duration** of command. When elapses process killed and call returns with timeout annotation. Range `1`–`3600`s; default `300`s (see `clampTimeout("bash", …)` in `tool-timeouts.ts`).
- `async: true` defers **reporting** only — does NOT disable, extend, or detach timeout. Daemon started `async: true` still killed when `timeout` elapses, regardless how long agent waits before reading result.
- For long-running daemons (dev servers, watchers): either pass an explicit large `timeout` (up to `3600`), or fully detach the process from this shell using `nohup …  &` / `setsid … &` / `disown` so it survives independent of the bash call's lifecycle.
{{/if}}

# Output minimizer

- Bash stdout/stderr may be rewritten before you see: long output head/tail truncated, test/lint runners (e.g. `bun test`, `cargo test`, ESLint) passed through heuristic filters drop noise keep failures.
- When minimizer changes visible text, tool appends `[raw output: artifact://<id>]` footer pointing at full untouched capture. If run looks suspicious (e.g. only version banner) or need exact bytes, read that artifact.
- If no footer present, what you see is what command actually emitted.
