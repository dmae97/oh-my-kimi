# session-stats

Ad-hoc analyses over the local agent session corpus
(`~/.omp/agent/sessions/`). SQLite-backed; data is synced once into the same
`~/.omp/stats.db` that `packages/stats` uses, then queried by short Python
scripts.

## Layout

```
scripts/session-stats/
  sync.py       # walks ~/.omp/agent/sessions/ and populates ss_* tables
  analyze.py    # tools | edits | followups subcommands over the synced db
```

## One-time prep

```sh
pip install tiktoken
```

## Sync

```sh
bun run stats:sync                  # incremental
python3 scripts/session-stats/sync.py --workers 16 --full     # rebuild all
python3 scripts/session-stats/sync.py --limit 200             # newest 200 only
```

The sync is incremental: per-file `mtime`, `size`, `byte_offset`, and
`parser_version` are tracked in `ss_sessions`. Re-runs only parse new bytes
and only re-tokenize / re-classify what changed. A bump of `EDIT_PARSER_VERSION`
in `sync.py` invalidates `ss_edit_*` rows on next sync.

Tokenization is `o200k_base` (GPT-4o / GPT-5 family) via tiktoken — well
within ~5–10% of Claude's BPE in aggregate.

## Schema

All tables are prefixed `ss_` to avoid collision with `packages/stats`.

|Table|Granularity|
|---|---|
|`ss_sessions`|one row per `.jsonl`; carries sync state + session metadata|
|`ss_tool_calls`|one row per `toolCall` content block (`arg_json`, `arg_tokens`)|
|`ss_tool_results`|one row per `toolResult` message (`result_text`, `result_tokens`, `is_error`)|
|`ss_assistant_msgs`|per assistant message text + thinking blobs and token counts|
|`ss_user_msgs`|per user message text and token count|
|`ss_edit_calls`|per `edit` call: `success`, `warnings`, `raw_input_len`|
|`ss_edit_sections`|per `@PATH` section in an edit; precomputed `longest_repeat_*`, `dup_anchors`|

Indexes on `(tool_name, timestamp)` and `(session_file, seq)` make per-tool
aggregations and ordered session walks cheap.

## Analyses

```sh
bun run stats:tools                        # per-tool token totals
bun run stats:tools -- --by d --top 8      # bucket by day, top 8 tools each
bun run stats:edits                        # edit-tool reliability audit
bun run stats:followups                    # five hashline-edit detectors
bun run stats:followups -- --max-fix 2 --min-dup 8 --show 20
```

All three accept `-n N` / `--folder SUBSTR` to scope the query.

The Rust crate that previously lived here was retired in favor of this
SQLite-backed flow. The schema persists everything the analyses used to
recompute on every run (token counts, hashline parse output, success flags),
so subsequent invocations are sub-second over the full corpus.
