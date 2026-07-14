Runs commands in the embedded shell. NOT full GNU Bash — invokes real binaries with simple args.

Use ONLY for: single binary call or short pipeline that COMPUTES a fact (`wc -l`, `sort | uniq -c`, `comm`, `diff`, checksum, `git status`).
{{#if hasLaunch}}Services, watchers, debuggers, REPLs → `launch`.{{/if}}
{{#if hasEval}}Inline scripts, heredocs, shell control flow, `$(…)`, multi-stage pipelines, `&&`-chains, quote/JSON escaping → `eval` cells.{{else}}Inline scripts, heredocs, shell control flow, `$(…)`, multi-stage pipelines, `&&`-chains → purpose-built tool or checked-in script.{{/if}}
GNU grep BRE not guaranteed: use `grep -E 'a|b'` not `grep 'a\|b'`{{#if hasGrep}}; prefer built-in `grep` tool{{/if}}.

<instruction>
- `cwd` sets working dir (not `cd dir && …`). `env: { NAME: "…" }` for multiline/quote-heavy values; `"$NAME"` to expand.
- `pty: true` only for real terminal needs (`sudo`, `ssh`); default `false`.
- Multiple calls run concurrently; NEVER split order-dependent commands — chain with `&&` in one call (`;` only to continue past failure).
- Internal URIs (`skill://`, `agent://`, …) auto-resolve to FS paths.
{{#if asyncEnabled}}- `async: true` defers reporting for finite commands needing no later input.{{/if}}
</instruction>

<critical>
{{#if hasGrep}}- NEVER shell out to search: `grep`/`rg` → built-in `grep`.{{/if}}
{{#if hasRead}}{{#if hasGlob}}- NEVER use `ls` or `find` — `ls` → `read`, `find` → `glob`. NON-NEGOTIABLE.{{/if}}{{/if}}
- Avoid head/tail/redirections: stderr merged, output auto-truncated, full capture at `artifact://<id>`.
{{#if hasLaunch}}- NEVER launch daemons/watchers/servers/debuggers/REPLs through bash — use `launch`.{{/if}}
</critical>

{{#if asyncEnabled}}- `timeout`: nonzero clamped 1–3600, killed on elapse. `0` only for cancellation-owned. `async: true` defers reporting only, doesn't extend timeout.{{/if}}
{{#if autoBackgroundEnabled}}- Long foreground calls may auto-background; result arrives as follow-up — NOT a failure. Need inline? Raise timeout{{#if asyncEnabled}} or `async: true`{{/if}}.{{/if}}
- Long output truncated, test/lint filtered to failures. `[raw output: artifact://<id>]` footer links full capture. No footer = what you see is exact output.
