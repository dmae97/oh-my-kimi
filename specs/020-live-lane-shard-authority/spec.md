---
description: "Production wiring contract for live subagent lanes, shard authority, and prompt settlement counters"
---

# Feature Specification: Live Lane and Shard Authority

**Specification ID**: `020-live-lane-shard-authority`
**Created**: 2026-08-27
**Status**: Proposed and implementation-blocked; internal mechanisms have no production caller
**Constitution**: [specs/constitution.md](../constitution.md)
**Input**: Remaining v0.98.x live-lane and opt-in shard authority work
**OMK Preset**: `omk`

## CLI Harness Target Impact

**Classification**: advance

| Dimension | Baseline | Acceptance target | Regression floor | Planned verification command | Evidence artifact |
| --- | --- | --- | --- | --- | --- |
| Lane concurrency | `launchSubagentLanes()` internal/test-only | Every production child launch passes one shared launcher and parent admission width | Active children never exceed effective width; child cannot raise parent cap | `npm --prefix packages/coding-agent test -- test/subagent-lane-launcher.test.ts test/live-subagent-lane-integration.test.ts` | integration trace |
| Ownership safety | Planner computes batches, no live authority | Conflicting write scopes never overlap | Existing path-conflict semantics unchanged | same planned command | lane schedule evidence |
| Settlement | Child/shard counters exist but have no production signal call | Every direct child/shard increments before launch and decrements exactly once after terminal cleanup | `prompt_settled` never emits with active child/shard count | planned settlement integration test | event trace |
| Sharding | Deterministic executor internal; no `autoShard` setting | Explicit opt-in, known simple-argv sharder only | Unsupported/complex/deploy/publish/migration commands never rewritten | planned shard integration tests | shard journal and aggregate receipt |

## Current Blocker

OMK has no single production child-dispatch path to replace. The example
subagent extension owns subprocess execution, while `launchSubagentLanes()` and
the shard executor are core internal primitives. Wiring a second path would
create duplicate authority rather than close the loop.

Implementation starts only after one caller is selected as the canonical spawn
funnel and its cancellation, ownership, permit, and evidence contracts are
mapped.

## Requirements

### Requirement 1 - Canonical child-launch funnel (Priority: P1)

1. Select exactly one production caller.
2. Route its plan through `buildSubagentOrchestrationPlan()` and
   `launchSubagentLanes()`.
3. Inject the parent's admission decision and shared `WorkloadPermitPool`.
4. Child settings may reduce but never increase parent caps.
5. Parent abort cancels queued permits and reaps every child process tree.

### Requirement 2 - Ownership and deterministic width (Priority: P1)

1. Effective width remains the minimum of plan, configured cap, admission cap,
   available permits, and conflict-free width.
2. One writer per owned path; read-only lanes may share paths.
3. Batch and lane order remain deterministic for identical input.
4. Failures return typed per-lane outcomes; no empty-success result.

### Requirement 3 - Settlement signals (Priority: P1)

1. Increment child/shard count immediately before an admitted launch.
2. Decrement exactly once in terminal cleanup, including abort and spawn error.
3. Counter underflow is a test failure, never silently clamped in integration.
4. Final `prompt_settled` requires both counts to reach zero.
5. Intermediate child/shard completion never triggers sound directly.

### Requirement 4 - Opt-in safe sharding (Priority: P1)

1. Add `resourceGovernor.autoShard.enabled=false` by default.
2. Accept only registered Vitest/Jest/workspace/Go simple-argv plans.
3. Preserve filters/config and reject unsupported coverage merging.
4. Never rewrite complex shell, migration, deploy, publish, release, snapshot
   update, or shared-state integration commands.
5. Completed shards may be skipped on valid resume, but aggregate evidence must
   still pass protocol evaluation before task completion.

## Planned Files

- production caller selected by implementation amendment
- `packages/coding-agent/src/core/subagent-lane-launcher.ts`
- `packages/coding-agent/src/core/prompt-settlement.ts`
- `packages/coding-agent/src/core/workload-shard-executor.ts`
- `packages/coding-agent/src/core/resource-governor-settings.ts`
- `packages/coding-agent/test/live-subagent-lane-integration.test.ts`
- `packages/coding-agent/test/live-shard-integration.test.ts`
- `packages/coding-agent/test/prompt-settlement-live-work.test.ts`

## Non-Goals

- Adding another child runtime beside an existing caller
- Enabling automatic sharding by default
- LLM-generated arbitrary shard plans
- Raising parent resource caps
- Treating lane/shard completion as a task verdict
- Promoting `adaptive` without spec 017 evidence review

## Unblock Conditions

1. Canonical production child caller selected and documented.
2. End-to-end cancellation/process-tree test fixture exists.
3. Owned-path conflict fixture exists.
4. Parent-child protocol evidence mapping is approved.
5. Resource-observation review supports the intended default width.
