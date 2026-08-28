---
description: "Current OMK runtime algorithms, maturity labels, and evidence-gated direction"
---

# Feature Specification: Runtime Algorithm and Direction Synchronization

**Specification ID**: `015-runtime-algorithm-direction`
**Created**: 2026-08-27
**Status**: Active
**Constitution**: [specs/constitution.md](../constitution.md)
**Input**: User description: "현재 OMK 최신 알고리즘 및 방향성을 docs 및 specs 에 반영"
**OMK Preset**: `omk`

## CLI Harness Target Impact

**Classification**: preserve

This cycle changes documentation and specification only. It must preserve runtime
behavior while making released, opt-in, internal, working-tree, and proposed
states mechanically distinguishable.

| Dimension | Baseline | Acceptance target | Regression floor | Verification command | Evidence artifact |
| --- | --- | --- | --- | --- | --- |
| Runtime/config/release behavior | Documentation and stale source-comment sync | `0` executable statements, config defaults, versions, or release metadata changed | source changes are comment-only | scoped diff review | documentation/comment diff |
| Status coverage | State spread across release notes and roadmaps | `100%` of canonical algorithm entries use one defined maturity label | `0` internal or working-tree mechanisms presented as released live behavior | `npm run check:doc-links` | `packages/coding-agent/docs/runtime-algorithms.md` |
| Discoverability | `0` canonical public algorithm pages | `1` canonical page linked from `index.md`, `docs.json`, and root README | all three links remain present | `npm run check:doc-links` | documentation indexes |
| Comparative claims | SOTA target, not verified | `0` unsupported leadership claims | `0` self-scores, test counts, or projections presented as leadership | `npm run check:feature-claims` | `packages/coding-agent/docs/metrics.md` |

## Problem

OMK's algorithm state was correct in source but fragmented in prose. The v0.98.x
roadmap still called three released v4 router weights zero and claimed there was
no runtime feedback consumer, while `v0.97.0` already shipped bounded nonzero
extension signals and a global-only, default-off bias-snapshot consumer. Public
settings also described Context Budget V2 as entirely session-memory-only even
though released representation entries persist per workspace while plan entries
remain session-memory-only.

The current working tree adds further candidates—timeout teardown settlement,
standing-instruction relevance floors, replay-stability promotion evidence, and
new repository gates—but none is a released feature. Without one status model,
mechanism existence, live authority, and release readiness are easy to conflate.

## Goal

Publish one evidence-indexed runtime algorithm map, correct conflicting public
configuration prose, and define OMK's direction as a sequence of measurable
promotion gates rather than a list of version promises.

## Agent-Oriented Requirements

### Requirement 1 - Canonical algorithm map (Priority: P1)

**Agent**: technical-writer / reviewer
**Skills**: docs-write-concisely, docs-update-docs
**Evidence Gate**: file-exists + command-pass
**Risk**: low

**What**: Create `packages/coding-agent/docs/runtime-algorithms.md` covering the
prompt/control flow, tool scheduling, Context Budget V2, v4 routing, resource
governance, protocol/evidence, recovery, and repository understanding.

**Verify**: `npm run check:doc-links`

**Acceptance**:
1. The page defines `released/default`, `released/opt-in`, `released/internal`,
   `working tree`, and `proposed` before using them.
2. Every implemented algorithm section cites implementation and test paths; a proposed mechanism cites this specification and states that implementation evidence is absent.
3. It states that ordinary chat turns do not automatically become
   `omk-protocol` `TaskSpec` evaluations.
4. It states that `dag-v2` is a level-barrier scheduler and that
   `assignDagDependencies()` has no live executor.

### Requirement 2 - Released defaults and authority boundaries (Priority: P1)

**Agent**: codebase-onboarding-engineer / reviewer
**Skills**: omk-agent-ops, code-review-and-quality
**Evidence Gate**: source-symbol + documentation-review
**Risk**: medium

**What**: Describe defaults from live source, not roadmap prose.

**Verify**: inspect the named symbols and run the focused tests referenced by the
canonical page.

**Acceptance**:
1. Context Budget V2 is labeled opt-in and density-first over
   `admissibleTokens`; representations persist per workspace by default while
   plans remain session-memory-only.
2. `/think auto` is deterministic and local; released extension weights are
   recorded as `2/1/2`, not zero.
3. `reasoningRouterLearning` is global-only, default-off, snapshot-pinned, and a
   real runtime bias consumer—not an online learner.
4. Resource `observe` remains the default; `adaptive` and `strict` are opt-in.
5. `launchSubagentLanes()` and the shard executor remain internal-only until a
   production call path exists.

### Requirement 3 - Unreleased-candidate boundary (Priority: P1)

**Agent**: reviewer
**Skills**: git-master, review-work
**Evidence Gate**: git-status + source-symbol
**Risk**: high

**What**: Give every current working-tree algorithm an explicit unreleased
label in its paragraph or status table. Never infer shipping from a passing
local test.

**Verify**: compare `git status --short` and `git diff --name-only` against the
paths named by the documentation.

**Acceptance**:
1. Timeout teardown grace, context standing-authority floor, router replay
   stability, and import/dependency ratchets are labeled working-tree
   candidates; OpenWiki corpus/gate work is labeled working-tree and
   security-blocked.
2. No release number or default-promotion promise is assigned to those changes.
3. The v0.98.x roadmap carries a synchronization notice that supersedes its old
   G4/G5 statements.

### Requirement 4 - Evidence-gated direction (Priority: P1)

**Agent**: architect / planner
**Skills**: omk-plan, docs-write-concisely
**Evidence Gate**: specification-review
**Risk**: medium

**What**: Order future work by admission criteria.

**Verify**: review the direction section against
`packages/coding-agent/docs/metrics.md` and the current source call graph.

**Acceptance**:
1. A controlled comparison holds model, provider and model configuration, task
   revision, budget, tool permissions, and environment constant; its cohort,
   minimum effect, confidence rule, and test are frozen before results are read.
2. Structural deletion and non-increasing module-size, dependency-tree, and
   import-cycle baselines precede new mechanisms.
3. Resource adaptive-default, live lanes, and opt-in known-command sharding are
   separate promotion steps.
4. Router adaptation remains parked until a separate `advance` spec defines a
   real outcome-linked sample, minimum effect, sample size, and confidence rule,
   then shows gain after the existing support threshold.
5. Verified memory remains spec-first: each admitted fact references an
   `Observation` or evidence receipt, carries source freshness identity, and is
   injected only through Context Budget V2 as provenance-tagged data.
6. AdaptOrch stays separate and advisory; it cannot grant local execution
   authority.

### Requirement 5 - Configuration and navigation consistency (Priority: P2)

**Agent**: technical-writer
**Skills**: docs-update-docs, remove-ai-slops
**Evidence Gate**: command-pass
**Risk**: low

**What**: Link the canonical page from public navigation, correct Context Budget
cache prose, and remove the deleted OMP seam variable and usage claims.

**Verify**: `npm run check:doc-links`

**Acceptance**:
1. `packages/coding-agent/docs/index.md` and `packages/coding-agent/docs/docs.json` expose the page.
2. `settings.md` and `environment-variables.md` agree with the released cache
   provider selection.
3. `usage.md` and `sdk.md` contain no `OMK_OMP_SEAMS` or default-seam claim; current private temporary spill behavior remains documented.
4. Root README links the canonical page without duplicating its content.

## Expected Files

- `packages/coding-agent/docs/runtime-algorithms.md` — canonical algorithm/status map
- `specs/README.md` — lifecycle and supersession index
- `packages/coding-agent/docs/index.md` — documentation index link
- `packages/coding-agent/docs/docs.json` — site navigation link
- `packages/coding-agent/docs/settings.md` — Context Budget cache correction
- `packages/coding-agent/src/core/reasoning-router-v4-weights.ts`, `reasoning-router-v4.ts`, `agent-session.ts`, `adaptorch-bridge.ts`, `resource-governor-settings.ts` — comment-only runtime-boundary corrections
- `packages/coding-agent/docs/environment-variables.md` — cache controls and removed seam cleanup
- `packages/coding-agent/docs/usage.md`, `sdk.md` — removed seam and private-spill cleanup
- `packages/coding-agent/docs/adaptorch-preview.md`, `adaptorch-preview-spec.md`, `correctness-wall.md` — current AdaptOrch/WPL boundaries
- `packages/adaptorch-wpl/README.md` — published-primitives boundary
- `README.md`, `packages/coding-agent/README.md` — discoverability and live-path corrections
- `specs/013-command-safety-attachment-resilience/spec.md`, `specs/014-repository-understanding-wiki/spec.md` — accurate release/worktree status
- `specs/015-runtime-algorithm-direction/spec.md` — this specification

## Local-only synchronization

`docs/OMK_v0.98x_PLANE_CONSOLIDATION_AND_LIVE_AUTHORITY_ROADMAP.md` and
`docs/omk-project-triage-2026-08-26.md` are ignored operator documents. Their
corrections improve this checkout but are not release evidence and do not appear
in the Git index.

The repository was already dirty before this task. Completion is therefore
scoped to the explicit file list above; branch-wide `git diff` cannot prove task
provenance.

## Verification Commands

- `npm run check:doc-links`
- `npm run check:constitution`
- `npm run check:feature-claims`
- `git diff --check`
- `npm --prefix packages/agent test -- test/tool-dag-scheduler.test.ts test/tool-dag-dependencies.test.ts test/tool-timeout-loop-continuation.test.ts`
- `npm --prefix packages/coding-agent test -- test/context-budget-v2-knapsack-order.test.ts test/context-budget-selection-policy-version.test.ts test/context-budget-cache-disk.test.ts test/context-budget-relevance.test.ts test/reasoning-router-policy-ceiling.test.ts test/reasoning-router-replay-stability.test.ts test/reasoning-router-promotion.test.ts test/resource-admission.test.ts test/resource-governor-settings.test.ts test/subagent-lane-launcher.test.ts test/workload-shard-executor.test.ts`
- `npm --prefix packages/protocol test -- test/protocol.test.ts test/validation.test.ts`
- `! rg -n 'OMK_OMP_SEAMS|default OMP seams' packages/coding-agent/docs`

## Non-Goals

- Changing runtime behavior, defaults, package versions, or release metadata
- Wiring eager dependency dispatch, live subagent lanes, or automatic sharding
- Implementing verified memory or type-aware compaction
- Promoting router weights or lowering its evidence thresholds
- Running or publishing a comparative benchmark
- Committing, tagging, pushing, publishing, or deploying

## Assumptions

- `v0.97.0` is the latest released runtime baseline for this synchronization.
- Uncommitted changes are unreleased evidence and must be preserved.
- Source and tests govern current-state facts. This specification governs the
  required documentation changes and future promotion gates.
