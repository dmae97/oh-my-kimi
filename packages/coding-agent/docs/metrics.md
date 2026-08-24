# Turn metrics

OMK records one JSON line per agent turn so harness changes can be measured
instead of guessed.

## CLI harness SOTA target

OMK targets state-of-the-art quality as a CLI coding-agent harness. **SOTA is
not verified.** This is a product target, not a statement that the current
release leads a benchmark or a named competitor cohort.

The target covers the harness layer:

| Dimension | Primary measure |
| --- | --- |
| Task success | solved tasks and pass rate |
| Cost efficiency | model cost and tokens per solved task |
| Latency | wall-clock p50/p95 per solved task |
| Context efficiency | input, cache, compaction, and tool-output tokens per solved task |
| Tool reliability | failure, retry, refusal, and intervention rates |
| Orchestration | critical-path time, useful concurrency, and duplicate work |
| Recovery | interrupted-run resume accuracy and repeated-run variance |
| Safety | policy violations, unauthorized effects, and false-positive blocks |
| Maintainability | complexity, module-size debt, and regression-gate health |

No single feature count or self-score establishes leadership. OMK reports a
dimension-specific result unless a preregistered aggregation defines an overall
score.

### Controlled comparison contract

A comparative harness run MUST hold the **same model**, **same provider** and
model configuration, **same task** and revision, **same budget**, equivalent
tool permissions, and comparable container, hardware, region, and concurrency
constant. The harness is the treatment variable. If a factor cannot be held
constant, the report must label the result non-comparative.

Every comparative report must include:

- the date, harness versions, and **named comparison cohort**, with its inclusion rule frozen before execution;
- immutable model, provider, container, environment, and configuration identities;
- the task manifest, seeds, public prompt or sanitized prompt digest, budgets, run order, and stop policy;
- sanitized per-task outcomes plus cost, token, latency, retry, and intervention data;
- the confidence interval, significance threshold, minimum effect, and statistical test chosen before inspecting the result;
- the exact commands and immutable manifests needed for **reproducible evidence**.

Use paired A/B measurements. Randomize or interleave pair order when provider or
machine drift can bias one side. Do not combine values produced by different
methods, working directories, task revisions, or warm/cold conditions. A
roadmap projection remains a hypothesis even when its inputs are measured.

### Evidence privacy

Benchmark evidence is private by default. Public artifacts may contain public
or synthetic task identifiers, version and image digests, allowlisted runtime
metadata, sanitized outcomes, and aggregate statistics. They must not contain
credentials, private prompts, proprietary source, raw tool arguments or output,
environment values, personal data, or absolute user paths.

Keep restricted raw evidence local or in an access-controlled store with an
explicit owner and retention period. Normalize paths, redact content, scan for
secrets and PII, and obtain human approval before publication. Digests and
public task manifests preserve reproducibility without disclosing restricted
content.

A public “SOTA,” “best,” “leading,” or “#1” claim requires a dated controlled
comparison that places OMK on the relevant quality/cost/latency frontier without
violating declared safety and regression floors. Until then, use “targets
state-of-the-art quality.”

[Harbor's Terminal-Bench runner](https://www.harborframework.com/docs/tutorials/running-terminal-bench)
and the [SWE-bench containerized harness](https://www.swebench.com/SWE-bench/api/harness/)
are reference evaluation surfaces. Their presence or a selected task list is
infrastructure, not a benchmark result.

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
regression gate. Selection alone is not a capability result. The scoring run
itself requires Docker, `harbor`, and real model spend — it is deliberately not
wired into `npm run check`. Any comparison produced from it must follow the
controlled comparison contract above.
