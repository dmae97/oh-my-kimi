# Turn metrics

OMK records one JSON line per agent turn so harness changes can be measured
instead of guessed.

This is separate from the two things that already existed:

| Surface | Purpose |
| --- | --- |
| `core/run-journal.ts` | Hash-chained **integrity** log (run started/finished/recovered, tool timeout). Answers "was this run tampered with or abandoned". |
| `core/telemetry.ts` | Install-time opt-in flag. Nothing else. |
| `core/turn-metrics.ts` | **Performance and quality**: cost, latency, tool failure rates, cache effectiveness. |

## Where it goes

`<cwd>/.omk/metrics/turns.jsonl`, append-only, rotated once past 8 MB
(`turns.jsonl.1`), file mode `600`.

| Variable | Effect |
| --- | --- |
| `OMK_TURN_METRICS=0` | Disable recording entirely. |
| `OMK_TURN_METRICS_DIR` | Write somewhere else. |

## Reading it

```bash
omk stats                    # aggregate report for the current project
omk stats --dir <path>       # a different metrics directory
omk stats --json             # machine-readable summary
```

```text
Turn metrics — 412 turns across 27 session(s)
  models        anthropic/claude-sonnet-4-5
  turn duration p50 4.2s · p95 31.8s
  input 91,204 · output 22,880 · cacheRead 1,904,551 · cacheWrite 88,100
  cache read share 95.4% of prompt-side usage
  cost          $4.8812
  compactions 6 · failovers 1 · ctx plan hit 41.2%

  tool                 calls   fail%     p50     p95    total
  bash                   688    4.2%   210ms    3.1s     4.1m
  edit                   201    9.0%    38ms   140ms    12.4s
```

## What is recorded

Counts, durations, ids, and error *classes*:

```json
{
  "schemaVersion": "omk-turn-metrics-1",
  "sessionId": "…", "turnIndex": 12,
  "provider": "anthropic", "model": "claude-sonnet-4-5",
  "startedAtEpochMs": 1, "endedAtEpochMs": 2, "durationMs": 1,
  "usage": { "input": 100, "output": 20, "cacheRead": 900, "cacheWrite": 10, "costUsd": 0.0125 },
  "stopReason": "toolUse",
  "toolCalls": [{ "name": "bash", "durationMs": 120, "ok": false, "error": "exit 1" }],
  "toolCallCount": 1, "toolFailureCount": 1
}
```

**Never recorded:** prompt text, tool arguments, tool output, file contents, or
environment values. Tool error strings are whitespace-collapsed and truncated to
200 characters — enough to tell failure modes apart, too short to carry a
payload.

Metrics are advisory. A failed write is counted and dropped; it can never make a
turn fail.

## Capability baseline

Runtime metrics tell you what a session cost, not whether the harness can solve
tasks. For that, `scripts/tb-mini-suite.mjs` selects a deterministic,
difficulty-balanced Terminal-Bench 2.1 subset so scores are comparable across
runs:

```bash
node scripts/tb-mini-suite.mjs             # human-readable selection
node scripts/tb-mini-suite.mjs --json      # feed a runner
node scripts/tb-mini-suite.mjs --seed 7    # a different fixed subset
```

Selection is a pure function of (tasks directory, seed, size): the same inputs
always produce the same task list, which is the whole point of using it as a
regression gate. The scoring run itself requires Docker, `harbor`, and real
model spend — it is deliberately not wired into `npm run check`.
