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
{{#if autoBackgroundEnabled}}
- Long-running non-PTY commands may auto-background after ~{{autoBackgroundThresholdSeconds}}s and continue as background jobs.
{{/if}}
{{#if asyncEnabled}}
- Inspect background jobs with `read jobs://` (`read jobs://<job-id>` for detail). To wait for results, call `job` (with `poll`) — do NOT poll `read jobs://` in a loop or yield and hope for delivery.
{{else}}
{{#if autoBackgroundEnabled}}
- For auto-backgrounded jobs, inspect with `read jobs://` and call `job` (with `poll`) to wait — do NOT poll in a loop.
{{/if}}
{{/if}}
</instruction>

<output>
- Returns output and exit code.
- Truncated output is retrievable from `artifact://<id>` (linked in metadata)
- Exit codes shown on non-zero exit
</output>
