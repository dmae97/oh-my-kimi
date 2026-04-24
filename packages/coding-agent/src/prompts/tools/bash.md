Executes bash command in shell session for terminal operations like git, bun, cargo, python.

<instruction>
- You **MUST** use `cwd` parameter to set working directory instead of `cd dir && …`
- Prefer `env: { NAME: "…" }` for multiline, quote-heavy, or untrusted values; reference them as `$NAME`
- Quote variable expansions like `"$NAME"` to preserve exact content and avoid shell parsing bugs
- PTY mode is opt-in: set `pty: true` only when the command needs a real terminal (e.g. `sudo`, `ssh` requiring user input); default is `false`
- You **MUST** use `;` only when later commands should run regardless of earlier failures
- Internal URIs (`skill://`, `agent://`, etc.) are auto-resolved to filesystem paths. Examples: `python skill://my-skill/scripts/init.py` runs the skill script; `skill://<name>/<relative-path>` resolves within the skill directory.
{{#if asyncEnabled}}
- Use `async: true` for long-running commands when you don't need immediate output; the call returns a background job ID and the result is delivered automatically as a follow-up.
{{/if}}
{{#if autoBackgroundEnabled}}
- Long-running non-PTY commands may auto-background after ~{{autoBackgroundThresholdSeconds}}s and continue as background jobs.
{{/if}}
{{#if asyncEnabled}}
- Inspect background jobs with `read jobs://` (`read jobs://<job-id>` for detail). To wait for results, call `poll` — do NOT poll `read jobs://` in a loop or yield and hope for delivery.
{{else}}
{{#if autoBackgroundEnabled}}
- For auto-backgrounded jobs, inspect with `read jobs://` and call `poll` to wait — do NOT poll in a loop.
{{/if}}
{{/if}}
</instruction>

<output>
Returns output and exit code.
- Truncated output is retrievable from `artifact://<id>` (linked in metadata)
- Exit codes shown on non-zero exit
</output>

<critical>
You **MUST NOT** use bash for file operations where specialized tools exist:

|Instead of (WRONG)|Use (CORRECT)|
|---|---|
|`cat file`, `head -n N file`|`read(path="file", limit=N)`|
|`cat -n file \|sed -n '50,150p'`|`read(path="file", offset=50, limit=100)`|
{{#if hasGrep}}|`grep -A 20 'pat' file`|`grep(pattern="pat", path="file", post=20)`|
|`grep -rn 'pat' dir/`|`grep(pattern="pat", path="dir/")`|
|`rg 'pattern' dir/`|`grep(pattern="pattern", path="dir/")`|{{/if}}
{{#if hasFind}}|`find dir -name '*.ts'`|`find(pattern="dir/**/*.ts")`|{{/if}}
|`ls dir/`|`read(path="dir/")`|
|`cat <<'EOF' > file`|`write(path="file", content="…")`|
|`sed -i 's/old/new/' file`|`edit(path="file", edits=[…])`|
{{#if hasAstEdit}}|`sed -i 's/oldFn(/newFn(/' src/*.ts`|`ast_edit({ops:[{pat:"oldFn($$$A)", out:"newFn($$$A)"}], path:"src/"})`|{{/if}}
{{#if hasAstGrep}}- You **MUST** use `ast_grep` for structural code search instead of bash `grep`/`awk`/`perl` pipelines{{/if}}
{{#if hasAstEdit}}- You **MUST** use `ast_edit` for structural rewrites instead of bash `sed`/`awk`/`perl` pipelines{{/if}}
- You **MUST NOT** use `2>&1` or `2>/dev/null` — stdout and stderr are already merged
- You **MUST NOT** use `| head -n 50` or `| tail -n 100` — use `head`/`tail` parameters instead
</critical>
