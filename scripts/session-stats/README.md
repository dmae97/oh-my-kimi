# session-stats

Ad-hoc analyses over the local agent session corpus
(`~/.omp/agent/sessions/`). Single Rust binary with subcommands.

## Subcommands

### `edits` — edit-tool reliability audit

Audits how agents have used the `edit` / `ast_edit` / `write` tools.

For each call we:

- detect the **argument-schema family** in use (the edit tool has shipped many
  shapes over time: `oldText/newText`, `op+pos+end+lines`, `loc+content`,
  `loc+splice/pre/post/sed`, etc.);
- record the locator shape and verb combination (for the current schema);
- pair the call with its `toolResult` and classify the outcome
  (`success` / `truncated` / `aborted` / `fail:anchor-stale` /
  `fail:no-match` / `fail:parse` / `fail:no-enclosing-block` / …).

Output: markdown-ish report on stdout plus per-call CSV at `$EDIT_ANALYSIS_CSV`
(default `./edit-analysis.csv`).

### `tools` — per-tool token budget

Aggregates token usage across the most-recent N sessions. Buckets:

- `tool ARGS`          — assistant tool-call argument JSON
- `tool RESULTS`       — tool result content text
- `assistant THINKING` — assistant `thinking` blocks
- `assistant TEXT`     — assistant prose
- `user TEXT`          — user-authored text content

Token counting uses **`o200k_base`** via `tiktoken-rs` (the GPT-4o / GPT-5
family BPE — well-defined offline and within ~5-10% of Claude's own counts in
aggregate across English/code).

Output: grand totals + per-tool breakdown sorted by total (arg+res) tokens.
Optional CSV at `$TOOL_USAGE_CSV`.

## Usage

```sh
# Edit audit on the most-recent sessions.
cargo run --release --manifest-path scripts/session-stats/Cargo.toml -- edits

# Edit audit on the 200 most-recent sessions.
cargo run --release --manifest-path scripts/session-stats/Cargo.toml -- edits -n 200

# Edit audit on a specific date.
cargo run --release --manifest-path scripts/session-stats/Cargo.toml -- edits 2026-04-28

# Tool token budget on the 1000 most-recent sessions.
cargo run --release --manifest-path scripts/session-stats/Cargo.toml -- tools -n 1000

# Tool token budget on every jsonl on disk.
cargo run --release --manifest-path scripts/session-stats/Cargo.toml -- tools -n 0

# Dump per-tool CSV alongside the report.
TOOL_USAGE_CSV=tools.csv \
  cargo run --release --manifest-path scripts/session-stats/Cargo.toml -- tools -n 200
```

The walk root is `~/.omp/agent/sessions/`. Subagent jsonls
(`<session-id>/<n>-<name>.jsonl`) count as their own session and are included
in the recency window independently.

## Layout

```
scripts/session-stats/
  Cargo.toml
  src/
    main.rs        # subcommand dispatch
    common.rs      # shared JSONL shapes, walk, tokenizer, formatting helpers
    cmd_edits.rs   # edits subcommand
    cmd_tools.rs   # tools subcommand
```

The crate is a standalone Cargo project (it carries its own `[workspace]`
declaration) so it does not perturb the main workspace's lockfile.
