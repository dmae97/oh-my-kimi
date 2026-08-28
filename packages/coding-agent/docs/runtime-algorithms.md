# Runtime Algorithms and Direction

This page separates OMK's released behavior from internal mechanisms, current
working-tree candidates, and proposals. Source and tests remain authoritative.

- **Snapshot date:** 2026-08-27
- **Released baseline:** OMK `v0.97.0` (`b38a2c8c84`)
- **Repository baseline:** `4b79c65eaf` plus the local working tree

## Status vocabulary

| Status | Meaning |
| --- | --- |
| **Released / default** | Present in `v0.97.0` and selected when relevant settings do not override it |
| **Released / opt-in** | Present in `v0.97.0`, but requires a command, setting, or explicit API call |
| **Released / internal** | Implemented and tested, but not connected to a live user path |
| **Working tree** | Present in the current checkout only; not shipped and not a release promise |
| **Proposed** | Design direction without a complete implementation and verification path |

A mechanism's existence does not make it authoritative. OMK promotes a mechanism
only after its live call path, default, evidence, and rollback are all explicit.

## Runtime control path

```text
Prompt or durable-goal round
  -> system-prompt assembly
     -> Context Budget V2 when globally enabled
  -> local v4 reasoning routing when /think auto is active
  -> provider attempt
     -> same-family route rotation, retry, or configured failover when eligible
  -> tool scheduling
     -> v0.97.0 CLI default: dag-v2; direct core fallback is revision-specific
     -> pre-hook claims -> deferred authorization -> post-hook claim re-plan
     -> deterministic level execution and source-order results
  -> journals, receipts, and session termination records
  -> optional omk-protocol evaluation
     TaskSpec -> ExecutionAttempt -> Observation -> EvaluationResult -> RuntimeDecision
  -> retry, continuation, or final prompt settlement
```

The protocol line is a released library and adapter surface. An ordinary chat
turn does not automatically become a `TaskSpec`; callers opt into that semantic
evaluation contract.

## Current algorithm surface

### Tool scheduling and settlement

**Status: Released / default.** The `v0.97.0` CLI sets `dag-v2`; direct
`omk-agent-core` calls fall back to `waves-v1`. The working tree changes that
core fallback to `dag-v2`, but that promotion is unreleased. The scheduler canonicalizes resource claims, preserves source order,
and places conflicting calls in later levels. Before a level executes, OMK authorizes its calls and
re-plans with post-hook arguments so a hook cannot silently invalidate the
original claim plan.

The live executor uses level barriers. `assignDagDependencies()` computes a
finer predecessor graph, but no live executor consumes it. Each candidate level
is authorized and then re-planned from post-hook arguments.

Evidence:

- `packages/agent/src/tool-dag-scheduler.ts`: `assignDagLevels`,
  `assignDagDependencies`, `scheduleDagLevels`
- `packages/agent/src/agent-loop.ts`: `executeToolCallsDagLevels`,
  `runDagLevelCalls`
- `packages/agent/test/tool-dag-scheduler*.test.ts`
- `packages/agent/test/tool-dag-dependencies.test.ts`

**Working tree:** timed-out tools receive a bounded 250 ms teardown window. A
cooperative process may settle and let the model react to the timeout; a tool
still running after the window stops the run because it may still mutate the
workspace. This candidate lives in
`packages/agent/src/tool-timeout-settlement.ts` and is covered by
`packages/agent/test/tool-timeout-loop-continuation.test.ts`.

### Context selection

**Status: Released / opt-in.** Context Budget V2 is enabled globally through
`contextBudget.enabled` or per process with `OMK_CONTEXT_GOVERNOR=1`.

The planner:

1. reserves response and safety tokens;
2. pins hard or required items first;
3. computes tier floors and ceilings;
4. scores optional items for relevance, recency, evidence, redundancy,
   priority, and full-text token cost;
5. sorts optional items by
   `density -> effectiveScore -> priorityRank -> fullTokens -> id`; and
6. selects a full, summary, headroom-compressed, pointer, or omitted
   representation that fits.

Density divides effective score by the cheapest non-omit representation
(`admissibleTokens`), not by full-text size. This avoids penalizing an item that
can be represented by a small evidence pointer. Stable item IDs and explicit
selection policy `sel-2` make tie-breaking and plan-cache invalidation
deterministic.

When enabled, representation and negative-result entries persist under
`.omk/cache/context-budget-v2`; plan entries remain session-memory-only.
`OMK_CONTEXT_GOVERNOR_CACHE=memory` keeps every cache entry in session memory,
and `OMK_CONTEXT_GOVERNOR_CACHE_DIR` relocates the representation snapshot.

Evidence:

- `packages/coding-agent/src/core/context-budget-v2-planner.ts`
- `packages/coding-agent/src/core/context-budget-v2-scoring.ts`
- `packages/coding-agent/src/core/context-budget-v2-selection.ts`
- `packages/coding-agent/test/context-budget-v2-knapsack-order.test.ts`
- `packages/coding-agent/test/context-budget-selection-policy-version.test.ts`
- `packages/coding-agent/test/context-budget-cache-disk.test.ts`

**Working tree:** context files now treat their global/local relevance baseline
as a floor. Lexical overlap can raise that score but cannot demote standing
instructions below the no-query baseline. Skills remain topic-scored because
they are optional capabilities, not standing authority. The change is in
`scoreContextFileRelevance()` with regression coverage in
`packages/coding-agent/test/context-budget-relevance.test.ts`.

**Working tree:** the default compactor now strips model-generated managed-rule
sections and deterministically carries explicit user-authored `RULE`/
`INVARIANT`/`CONSTRAINT`/`MUST`/`NEVER`/`ALWAYS` markers (plus explicit Korean
markers) outside LLM rewriting. Rules are bounded to 64 × 1,000 characters,
stored in additive non-hook compaction details, and covered by a five-round
byte-preservation test. Natural-language classification, hook summaries, branch
summaries, and cross-session memory remain outside this slice. Persisted rules
are credential-redacted and source-bound to a user entry/line/digest; previous
details are reused only when their canonical block matches the prior summary.

Evidence:

- `packages/coding-agent/src/core/compaction/knowledge-triage.ts`
- `packages/coding-agent/test/compaction-knowledge-triage.test.ts`
- `packages/coding-agent/test/compaction-summary-reasoning.test.ts`

### Reasoning routing

**Status: Released / opt-in.** `/think auto` uses the local, deterministic v4
router. It extracts bounded prompt features, classifies one of seven task
classes, maps the class through `TASK_CLASS_THINKING_LEVELS`, applies lane
steps, bounded bias/hint adjustments, and non-negative uncertainty escalation,
then clamps the result to the selected model's supported levels.

The released extension-signal coefficients are active and bounded:
`multiTurnPrior=2`, `pressureBucket=1`, and `judgeVote=2`. History and pressure
are supplied by the main session; a judge vote affects only callers that provide
one. A zero-score fallback cannot be hijacked by these signals.

The optional learning path is global-only and off by default. When enabled, a
session loads one strictly validated `RouterBiasSnapshot` from the configured
path or repository-scoped default, pins that snapshot or miss for the session,
applies a `-2..2` step bias, and writes only bounded feedback buckets. It never stores prompts, diffs, tool
output, provider payloads, or repository paths.

Evidence:

- `packages/coding-agent/src/core/reasoning-router-v4.ts`
- `packages/coding-agent/src/core/reasoning-router-resolver.ts`
- `packages/coding-agent/src/core/reasoning-router-bias.ts`
- `packages/coding-agent/test/suite/regressions/013-reasoning-router-v4-accuracy.test.ts`
- `packages/coding-agent/test/suite/regressions/014-reasoning-router-v4-learning-wiring.test.ts`
- `packages/coding-agent/test/suite/regressions/018-reasoning-router-v4-inert-weights.test.ts`

**Working tree:** promotion evidence now credits a row only when repeated
baseline and candidate classifier replays each agree. It also requires a frozen
baseline and fails closed on insufficient or unstable replays. See
`reasoning-router-replay-stability.ts`, `reasoning-router-policy-ceiling.test.ts`,
and `reasoning-router-replay-stability.test.ts`.

### Resource governance, lanes, and shards

The resource plane probes memory, workspace disk, V8 heap, and system CPU, then
produces bounded admission caps.

| Mechanism | Status | Authority |
| --- | --- | --- |
| Prompt-time probe, admission decision, and journal | Released / default | Observe and record |
| `/resource` and `omk doctor resources` | Released / opt-in | Inspect current policy and probe state |
| `omk doctor resources --report` | Working tree | Aggregate bounded local admission evidence; never promotes mode |
| Per-run tool cap and governed heavy-process permits | Released / opt-in | Enforced in `adaptive` or `strict` mode |
| `launchSubagentLanes()` | Released / internal | No live child-dispatch consumer |
| Journaled Vitest/Jest/workspace/Go shard executor | Released / internal | No `autoShard` setting or session-command consumer |

`observe` remains the default. Admission caps never raise configured caps.
Corrupt shard journals are quarantined and block resume; completed shards may be
skipped, but shard completion is only evidence and never a task verdict.

Evidence:

- `packages/coding-agent/src/core/resource-admission.ts`
- `packages/coding-agent/src/core/resource-governor-settings.ts`
- `packages/coding-agent/src/core/run-resource-lease.ts`
- `packages/coding-agent/src/commands/resource-doctor-cli.ts`
- `packages/coding-agent/src/core/resource-observation-report.ts`
- `packages/coding-agent/test/resource-observation-report.test.ts`
- `packages/coding-agent/src/core/subagent-lane-launcher.ts
- `packages/coding-agent/src/core/workload-shard-executor.ts`
- `packages/coding-agent/test/resource-admission.test.ts`
- `packages/coding-agent/test/resource-doctor-cli.test.ts`
- `packages/coding-agent/test/agent-session-resource-lease.test.ts`
- `packages/coding-agent/test/agent-session-resource-permits.test.ts`
- `packages/coding-agent/test/subagent-lane-launcher.test.ts`
- `packages/coding-agent/test/workload-shard-executor.test.ts`

### Terminal settlement notifications

**Status: Working tree.** `v0.97.0` released completion sound as opt-in and
suppressed user aborts. The current working tree enables it by default on an
interactive TTY and adds an `onAbort` outcome switch. Successful prompts retain
the 5-second duration floor; failed and aborted/stopped outcomes notify
immediately.

The sound consumes only `prompt_settled`, never intermediate `agent_end`. The
current live path drains provider attempts, tools, and queued continuations;
subagent work is awaited inside its tool call. The settlement reducer reserves
direct child/shard counters, but no production signal call wires them yet, so
future live lanes/shards must close that gap before activation.
RPC, JSON, print mode, and CI remain silent. Playback uses fixed absolute
executable/argv pairs, a minimal environment without inherited `PATH` or
credentials, and a neutral temporary cwd. WSL uses BEL rather than resolving
PowerShell through `PATH`. Playback is fire-and-forget and cannot change the
prompt outcome.

Evidence:

- `packages/coding-agent/src/core/prompt-settlement.ts`
- `packages/coding-agent/src/core/completion-sound.ts`
- `packages/coding-agent/src/core/completion-sound-io.ts`
- `packages/coding-agent/test/prompt-settlement.test.ts`
- `packages/coding-agent/test/completion-sound.test.ts`
- `packages/coding-agent/test/suite/agent-session-retry-events.test.ts`

### Evidence, decisions, and recovery

**Status: Released / opt-in.** The explicit `omk-protocol` API provides versioned,
readonly record contracts and runtime parsers for tasks, attempts, observations,
evaluations, waivers, and runtime decisions. `evaluateTask()` is pure. Among
unwaived required claims, any violation yields `fail`; otherwise missing
evidence yields `inconclusive`; otherwise the verdict is `pass`. A task with no
required claims is `inconclusive`; explicit waivers remove their claims from
verdict reduction. Advisory judging can choose among candidates that already
passed; it cannot create evidence or change a semantic verdict.

The coding-agent adds evidence receipts, a replay ledger, workspace
fingerprints, attempt journals, durable goals, seam checkpoints, session doctor,
and bounded provider retry/failover. Digests detect mismatch; they do not prove
runner honesty, OS isolation, freshness, or trusted authorship by themselves.

Evidence:

- `packages/protocol/src/evaluation.ts`: `evaluateTask`
- `packages/protocol/src/decision.ts`: `reduceRuntimeDecision`
- `packages/protocol/test/protocol.test.ts`
- `packages/coding-agent/src/core/advisory-judge.ts`
- `packages/coding-agent/test/advisory-judge.test.ts`

See [Run Protocol and Durable Goals](run-protocol.md),
[Sessions](sessions.md), [Provider Resilience](provider-resilience.md), and
[Turn Metrics](metrics.md).

### AdaptOrch and WPL boundary

**Status: Released / opt-in.** Published `omk-adaptorch-wpl` supplies typed packet state, client, adjudication, and
verdict-projection primitives. Its `loop.ts` explicitly excludes end-to-end
`adaptorch_run` dispatch, polling, request assembly, and persistence. The
coding-agent has no production importer that turns those primitives into a
default execution loop; the Correctness Wall remains an explicitly loaded
example extension. The default-off AdaptOrch reasoning bridge currently returns
no advisory hint.

Evidence:

- `packages/adaptorch-wpl/src/loop.ts`
- `packages/adaptorch-wpl/test/loop.test.ts`
- `packages/coding-agent/src/core/adaptorch-bridge.ts`
- `packages/coding-agent/test/suite/regressions/011-reasoning-router-adaptorch-bridge.test.ts`
- `packages/coding-agent/test/suite/regressions/012-reasoning-router-learning-adaptorch-activation.test.ts`

See [AdaptOrch Preview](adaptorch-preview.md) and
[Correctness Wall](correctness-wall.md).

### Repository understanding

**Status: Working tree.** The `v0.97.0` release shipped policy/workflow only and
still ignored `/openwiki/` and contained neither the corpus nor its checker.
Neither the release tag nor the current Git index tracks `openwiki/` or
`.understand-anything/`; both datasets are untracked or ignored advisory state.
The current `.last-update.json` says `interrupted` at current HEAD.

`scripts/check-openwiki.mjs` validates entry pages, internal links, update-state
shape, and global symbol-name presence in a source/test/script haystack. It does
not validate prose or bind each symbol to a declared source path. A current-HEAD
`interrupted` generation warns; a stale interrupted generation blocks. Source
and tests outrank every generated page. There is no dedicated checker test in
the current working tree; the executable checker is the available evidence.

This is not a release-grade trust gate: the current corpus is `interrupted`,
symbol checks are global substrings rather than declared source bindings, and
the generation workflow still needs an output allowlist plus pre-upload secret
and private-path scans. Do not load the corpus as trusted context until those
blockers close.

## Direction

**Status: Proposed.** Owning specification:
`specs/015-runtime-algorithm-direction/spec.md`. This section creates no runtime
or test evidence; the internal mechanisms above do not satisfy these promotion
gates. Apply them in order:

1. **Measure before promoting authority.** Run dated, same-model, same-provider,
   same-task comparisons before changing defaults or making leadership claims.
   The protocol in [Turn Metrics](metrics.md) is mandatory.
2. **Reduce structure before adding mechanisms.** Do not raise module-size,
   dependency-tree, or import-cycle baselines. The dependency-tree and import-
   cycle gates are working-tree changes. Split large session and interactive
   modules by ownership; do not mix movement-only refactors with behavior.
3. **Promote live authority in stages.** Collect resource observations before
   making `adaptive` the default. Wire subagent lanes before exposing automatic
   sharding. Keep automatic sharding opt-in and limited to known, semantically
   equivalent command families.
4. **Protect standing context.** The relevance floor and explicit-rule
   compaction slice are Worktree-only. Broader natural-language, hook, and branch
   triage still require evidence before expansion.
5. **Design verified memory before implementing it.** Spec 019 requires
   evidence-linked admission, Context Budget V2 data-only injection, source-span
   provenance, staleness, and memory-injection probes. Implementation remains
   blocked until fixtures and evaluation thresholds are preregistered.
6. **Keep adaptation evidence-gated.** Do not add online router learning while
   the current instrument cannot show gain after `BIAS_STRONG_THRESHOLD=5`.
   Reopen only through an `advance` spec that preregisters the real outcome-
   linked sample, sample size, minimum effect, confidence rule, and statistical
   test before collecting the promotion result.
7. **Keep hosted advice separate from local authority.** AdaptOrch remains a
   separate service and any bridge remains advisory; local deterministic gates
   own execution and completion.

## Deliberate non-goals

- Calling a level-barrier schedule an eager critical-path executor
- Treating internal lane or shard code as a live feature
- Auto-sharding arbitrary shell, deploy, publish, release, or migration commands
- Treating model narration, reviewer opinion, or a digest alone as completion
- Persisting unrestricted prompts or trajectories as learning memory
- Claiming SOTA from tests, feature counts, self-scores, or roadmap projections

## Verification map

| Claim | Fast verification |
| --- | --- |
| Documentation links resolve | `npm run check:doc-links` |
| Specification governance holds | `npm run check:constitution` |
| Context selection behavior | focused context-budget tests named above |
| Router behavior and promotion ceiling | focused reasoning-router tests named above |
| Tool scheduling and timeout candidate | focused `packages/agent` scheduler/timeout tests |
| Resource and internal execution mechanisms | focused resource, lane, and shard tests named above |

A green focused test proves only its declared behavior. Release readiness still
requires the repository's full release gates.
