# analyze-edit-formats

Audits how agents have used the `edit` / `ast_edit` / `write` tools across
historical session JSONLs in `~/.omp/agent/sessions/`.

For each tool call we:

- detect the **argument-schema family** in use (the edit tool has shipped many
  shapes over time: `oldText/newText`, `op+pos+end+lines`, `loc+content`,
  `loc+splice/pre/post/sed`, etc.);
- record the locator shape and verb combination (for the current
  `loc+splice/pre/post/sed` schema);
- pair the call with its `toolResult` and classify the outcome
  (`success` / `truncated` / `aborted` / `fail:anchor-stale` /
  `fail:no-match` / `fail:parse` / `fail:no-enclosing-block` / …).

Output is a markdown-ish report on stdout plus per-call CSV at
`/tmp/edit-analysis/edits.csv` (or your CWD if you set that up differently).

## Usage

```sh
# Scan every session jsonl on disk (slow — ~25k files).
go run ./scripts/analyze-edit-formats

# Scan only files whose path contains the given date prefix(es).
go run ./scripts/analyze-edit-formats 2026-04-28
go run ./scripts/analyze-edit-formats 2026-04-27 2026-04-28
```

The walk root is `~/.omp/agent/sessions/`. Sub-session files (subagent
trajectories nested under `<session-id>/<n>-<name>.jsonl`) are picked up
automatically.

## Why Go

The session corpus is large (>25k files, >100k edit calls). Go iterates the
JSONL stream with negligible memory overhead and finishes in ~90s. The same
analysis in Bun/TS works but is noticeably slower for ad-hoc runs.

## What it's good for

- Comparing reliability across edit-tool argument schemas before changing the
  current one.
- Spotting which verb / locator shapes have outsized failure rates so the
  prompt can warn against them.
- Sanity-checking that a new edit-tool design isn't regressing the
  failure-mode mix versus the previous design.
