---
description: "Single-model execution boundary, request ledger, deadline policy, and barrier measurement per TB21 review"
---

# TB21 Harness Hardening

**Specification ID:** `022-tb21-harness-hardening`
**Created:** 2026-09-07
**Status:** Implemented in the working tree on `feat/tb21-model-contract`; no release; no default-path activation
**Constitution:** [Project constitution](../constitution.md)
**Input:** `docs/OMK_TB21_GitHub_Algorithm_Review_2026-09-07.md` (TB21 benchmark audit + P0→P2 proposals)

## CLI Harness Target Impact

**Classification**: advance

| Dimension | Baseline | Acceptance target | Regression floor | Verification command | Evidence artifact |
| cost efficiency | vision route fires silently cross-provider; no request_kind attribution | every provider call classified main/vision-route; contract denials emit no request | no previously-passing loop test regresses except the one event-sequence expectation updated for the new audit event | `node ../../node_modules/vitest/dist/cli.js --run test/agent-loop.test.ts` (from `packages/agent`) | focused tests |
| safety | session headers/compat inherited by routed model; session key fallback across providers | routed model drops headers/compat; missing routed credentials refuse instead of reusing session key | zero cross-provider credential transmissions in tests | same command | focused tests |
| reliability | compaction bypasses any model policy; image blocks arm silent routes | compaction gated by the same contract; text-only models receive text projection | legacy no-contract path byte-identical | same + `block-images.test.ts` | focused tests |

## Scope

Implements TB21 review §15 PR-1 (P0 contract), PR-2 (P1 ledger), PR-3 subset
(deadline policy + stagnation tracker, no learned controller), and PR-5
measurement only (barrier waste accounting; executor unchanged per §12.3 gate).
Terminal-layer upgrade (PR-4) and DAG dependency execution are explicitly out:
the former needs a benchmark-adapter path confirmation not performed here, the
latter is gated on measured waste from real traces.

Out of scope: multi-agent expansion, learned routers, additional LLM judges
(review §13 hold sustained).

## Re-verification findings (2026-09-07 second pass)

| # | Severity | Finding | Fix |
|---|---|---|---|
| 4 | HIGH | Denied attempts left no ledger trace (§7.4 `attempted_route`/`denied_reason` required) | `provider_denied` audit event on all three denial paths; no prompt/keys |
| 8 | HIGH | coding-agent compaction failover (`_compactionFailoverModels` + direct `completeSimple`) bypassed the contract and reused the primary key cross-provider | `compact()` takes `CompactionModelContract`: per-candidate gate + per-provider key re-resolution; violators skipped |
| 14 | HIGH | No wiring connected the contract to any live path (`createLoopConfig` never set `modelContract`) | harness passes `modelContract` through to the loop config |
| 6 | MED | `retry/summary/compaction` kinds declared but never emitted | kind union narrowed to emitted values |
| 1/2 | LOW | `authOrigin` was provider self-comparison (vacuous) | single getter invocation; origin derived from actual key source |
| 5 | LOW | fallback partial-allowance cases untested | three denial tests added |

## Requirements

### Requirement 1 - Final send boundary contract (Priority: P0)

**Agent**: coder
**Skills**: programming, omk-typescript-strict, security-review
**Evidence Gate**: file-exists + command-pass

**What**: `packages/agent/src/run-model-contract.ts` — `ModelContract`,
`assertModelContract`, `resolveRouteDecision`, `ModelContractViolation`.
`AgentLoopConfig.modelContract?`; enforced in `streamAssistantResponse`
before `streamFunction`. Vision fallback only to the contract-declared exact
model, resolved against the known route table with headers/compat dropped.

**Verify**: `test/run-model-contract.test.ts` (13), `test/agent-loop.test.ts`
contract + hygiene + provider_denied suites.

**Acceptance**:
1. No-contract callers keep the legacy silent route byte-identical.
2. Contract denials emit no provider request (`sent === false` asserted).
3. Cross-provider key fallback is impossible by construction (strict resolve).

### Requirement 2 - Image text projection (Priority: P0)

**Agent**: coder
**Skills**: programming
**Evidence Gate**: command-pass

**What**: `read.ts` projects image files to verifiable text metadata when the
serving model (`ctx.model`, falling back to explicit `options.model`) cannot
read images. No fabricated descriptions.

**Verify**: `test/block-images.test.ts` vision suite.

### Requirement 3 - Request ledger (Priority: P1)

**Agent**: coder
**Skills**: programming
**Evidence Gate**: command-pass

**What**: `provider_request` audit event (`AgentEvent` union) emitted before
every send with kind/provider/model/routed/reason. No content, no keys.
Compaction gated by the same contract via `AgentHarnessOptions.modelContract`;
automatic compaction degrades to skipping on violation.

### Requirement 4 - Deadline + stagnation (Priority: P1)

**Agent**: coder
**Skills**: programming
**Evidence Gate**: command-pass

**What**: `deadline-policy.ts` (monotonic budget, verify/finalize/cleanup
reserves, timeout clamp) and `stagnation-tracker.ts` (same-fingerprint repeat
divert policy). Pure modules; loop wiring is a later PR.

### Requirement 5 - Barrier waste measurement (Priority: P2)

**Agent**: coder
**Skills**: programming
**Evidence Gate**: command-pass

**What**: `dag-barrier-waste.ts` — `computeBarrierWaste` pure accounting from
`assignDagDependencies` predecessors vs actual timings. Executor untouched;
replacement gated on measured waste per review §12.3.

## Expected Files

- `packages/agent/src/run-model-contract.ts` — contract types + checks
- `packages/agent/src/deadline-policy.ts` — monotonic budget
- `packages/agent/src/stagnation-tracker.ts` — repeat divert policy
- `packages/agent/src/dag-barrier-waste.ts` — barrier accounting
- `packages/agent/src/agent-loop.ts` — send-boundary enforcement + ledger emit
- `packages/agent/src/types.ts` — `modelContract`, `provider_request`
- `packages/agent/src/harness/agent-harness.ts` + `harness/types.ts` — compaction gate
- `packages/coding-agent/src/core/tools/read.ts` — image text projection
- `specs/022-tb21-harness-hardening/spec.md` — this file

## Verification Commands

- `node ../../node_modules/vitest/dist/cli.js --run test/agent-loop.test.ts test/run-model-contract.test.ts test/deadline-policy.test.ts test/stagnation-tracker.test.ts test/dag-barrier-waste.test.ts test/harness/agent-harness.test.ts` (from `packages/agent`)
- `node ../../node_modules/vitest/dist/cli.js --run test/block-images.test.ts` (from `packages/coding-agent`)
- `npm run check` — repo-wide (pre-existing unrelated failures documented, not introduced here)

## Assumptions

- Benchmark/single-model runs opt in by setting `modelContract`; default paths unchanged.
- Security review findings B1/B2/S1/S2/S3 addressed in-tree; review artifact is the subagent report in this session.
- Live-spend and benchmark re-run evidence are future work (review §14 D1+).
