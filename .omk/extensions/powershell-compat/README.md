# powershell-compat

Lets OMK's `bash` tool work on a Windows host that has PowerShell but no POSIX shell.

## Why

`getShellConfig` requires bash. On Windows it looks for Git Bash, then any
`bash.exe` on PATH, and throws with install instructions when it finds neither:

```
No bash shell found. Options:
  1. Install Git for Windows: ...
```

On such a machine the bash tool is unusable. This extension supplies a
PowerShell-backed execution backend instead.

## What it does

Every command is classified before it runs:

| Decision | When | Example |
|---|---|---|
| `passthrough` | External program, no POSIX-only syntax | `git status`, `npm test`, `node x.js` |
| `rewrite` | Builtin with an exact PowerShell mapping | `pwd` → `Get-Location`, `cat f` → `Get-Content -LiteralPath f` |
| `refuse` | Anything else | `rm -rf build`, `grep -rn TODO`, `export FOO=bar` |

Refusals are returned as command output with exit code 1, not thrown, so the
agent reads the reason and can retry with the PowerShell form.

## Why it refuses instead of translating

A wrong translation of `rm -rf build` is unrecoverable, and the agent cannot
tell a mistranslation from a real result. The table only rewrites mappings that
are exact; destructive verbs (`rm`, `mv`, `cp`, `chmod`, `dd`) are never
auto-translated.

The subtler case is silent divergence — commands that produce no error and the
wrong answer. Verified against pwsh 7:

- ``echo `date` `` prints the literal `` date` `` (backtick is PowerShell's escape character)
- `echo ${PATH}` prints empty (PowerShell wants `$env:PATH`)

Both are refused for that reason, not because they crash.

`&&` and `||` are allowed only on PowerShell 7+; in Windows PowerShell 5.1 they
are a parse error, so they are refused there with that explanation.

## Scope

The decision table was checked end-to-end against real PowerShell 7: every
`passthrough` and `rewrite` exits 0, and every `refuse` either fails or
diverges silently. `2>&1` is *not* refused — PowerShell supports it natively.

It is **not** a POSIX emulation layer. `grep`, `sed`, `find`, `awk` and friends
are refused rather than approximated. For full POSIX behaviour install Git for
Windows; OMK then uses real bash and this extension stays inert.

## Install

Copy this directory to `~/.omk/agent/extensions/powershell-compat/` (global) or
`.omk/extensions/powershell-compat/` (project-local).

The extension registers nothing when a working POSIX shell is present, so it is
inert on Linux, macOS, and Windows with Git Bash.

```bash
npm test    # decision-table tests, no Windows required
npm run check
```
