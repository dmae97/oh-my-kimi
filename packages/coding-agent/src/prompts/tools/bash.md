Runs commands in the embedded shell — terminal ops: git, bun, cargo, python.

# When to use bash — and when not to

The shell invokes **real binaries** with simple args. It is NOT full GNU Bash.

Use bash ONLY for: a single binary call, or one short pipeline that COMPUTES a fact and does not depend on shell-specific regex/quoting (`wc -l`, `sort | uniq -c`, `comm`, `diff`, a checksum, `git status`).

Anything below → `eval` cell, not bash:
- Inline interpreter scripts (`-e`/`-c`/`--eval`) when an eval runtime exists for that language
- Heredocs (`<<EOF`), `while`/`for`/`if`/`case` shell control flow
- `$(…)` command substitution nested inside another command
- Pipelines with more than two stages, or stages that need control flow or quote/JSON escaping
- Multiline commands, `&&`-chains mixing control flow
- Quote/JSON escaping that fights the shell
- GNU grep BRE extensions are not guaranteed in the embedded shell: use `grep -E 'json|tool'` for alternation instead of `grep 'json\|tool'`; use the built-in `grep` tool with `pattern: "json|tool"` (Rust regex, so `\bword\b` works there), or `eval` for exact text processing.

<instruction>
- `cwd` sets the working dir, not `cd dir && …`
- `env: { NAME: "…" }` for multiline / quote-heavy / untrusted values; reference `$NAME`
- Quote expansions (`"$NAME"`) to preserve exact content
- `pty: true` only when the command needs a real terminal (`sudo`, `ssh` needing input); default `false`
- `;` only when later commands should run despite earlier failures
- Multiple bash calls per message run concurrently. NEVER split order-dependent commands across parallel calls — chain with `&&` in one call.
- Internal URIs (`skill://`, `agent://`, …) auto-resolve to FS paths
- Need exact pipeline semantics (`cmd | head`, multi-stage filtering) or output truncation? Prefer `eval` and process the stream directly.
{{#if asyncEnabled}}
- `async: true` for long-running commands when you don't need immediate output: returns a background job ID; result delivered as a follow-up.
{{/if}}
</instruction>

<critical>
- The embedded shell invokes real binaries with simple args; it is NOT full GNU Bash. Loops, conditionals, heredocs, inline interpreter scripts (`-e`/`-c`/`--eval`) when an eval runtime exists, several piped stages, exact pipeline semantics, or quote/JSON escaping mean you're writing a program → use `eval` cells: restartable, stateful, and free of shell-quoting traps.
</critical>

<output>
- Returns output (stderr merged into stdout); exit code shown on non-zero exit.
- Truncated output → `artifact://<id>` (linked in metadata).
</output>

{{#if asyncEnabled}}
# Timeout and async

- `timeout` is seconds, clamped to `1..3600`; the process is killed on elapse.
- `async: true` defers only reporting — it does NOT extend the timeout; a daemon with `async: true` is still killed at the clamped timeout.
- Need >3600s? Detach/manage lifecycle yourself (`cmd &`, supervisor, self-restarting script). The shell session persists across calls.
{{/if}}
{{#if autoBackgroundEnabled}}

## Auto-background

- A long-running foreground call may convert to a background job; the final result arrives as a follow-up tool call. NOT a failure — don't retry or wait synchronously.
- Need the result inline (e.g. piping into another command)? Raise `timeout` above expected duration{{#if asyncEnabled}}, or set `async: true` up front{{/if}}.
{{/if}}

# Output minimizer

- Long output truncated; test/lint runner output filtered to failures. When visible text changed, a `[raw output: artifact://<id>]` footer links the full capture — read it if a run looks suspicious or you need exact bytes.
- No footer = what you see is exactly what the command emitted.
