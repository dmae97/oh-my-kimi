# OMK Run Protocol v1

The OMK Run Protocol defines one versioned contract for task execution and evaluation:

```text
TaskSpec -> ExecutionAttempt -> Observation -> EvaluationResult -> RuntimeDecision
```

`omk-protocol` owns these records and the pure reducers that connect them. Tool execution, persistence, scheduling, routing, and topology remain outside the package.

## Implemented scope

The first v1 slice is available under `packages/protocol` with schema version `omk.run.v1`.

| Contract | Purpose |
| --- | --- |
| `TaskSpec` | Goal and required or advisory `ClaimPredicate` records |
| `ExecutionAttempt` | One completed initial, retry, failover, or resumed execution |
| `Observation` | Immutable facts tied to a task and attempt |
| `ClaimEvaluation` | Derived `satisfied`, `violated`, or `inconclusive` claim result |
| `EvaluationResult` | Claim evaluations plus one semantic `pass`, `fail`, or `inconclusive` verdict |
| `RuntimeDecision` | Pure `continue`, `retry`, `failover`, or `stop` decision |
| `WaiverRecord` | Explicit, scoped, attributable, and optionally expiring exception |

Every top-level record carries `schemaVersion`. Parsers reject unsupported versions, malformed timestamps, duplicate claim IDs, invalid JSON facts, and empty logical conditions.

## Evaluation model

`evaluateTask()` is a pure `TaskSpec + ExecutionAttempt + Observation[] + WaiverRecord[] -> EvaluationResult` reducer. It does not mutate its inputs or stored evidence.

An observation condition selects facts by observation kind and task or attempt scope. Its expected facts are a recursive object subset; arrays match exactly.

- no candidate observation: `inconclusive`
- candidate with matching facts: `satisfied`
- candidates present but none match: `violated`
- `all`, `any`, and `not` compose conditions without adding evaluator state

Required, unwaived violations reduce to `fail`. Required, unwaived missing observations reduce to `inconclusive`. Otherwise the semantic verdict is `pass`. Advisory claims are reported but do not block. A task with no required claims is `inconclusive`.

`reduceRuntimeDecision()` then maps the semantic verdict through an explicit runtime policy. `pass` always stops successfully; fail and inconclusive behavior is supplied as `onFail` and `onInconclusive`. Retry and failover counters are not fields: consumers derive them from `ExecutionAttempt` records.

## Waivers

A waiver names one task and claim, the approver, approval time, rationale, and evidence references. It may be limited to one attempt and may expire. Evaluation fails closed for cross-task, unknown-claim, future-approved, expired, duplicate, or advisory-claim waivers. The underlying claim result remains visible; `waiverId` records why it did not block.

## EvidenceReceipt v3 bridge

`EvidenceReceipt v3` remains the integrity layer. `evidenceReceiptToObservation()` from `open-multi-agent-kit` validates the immutable core digest, then projects only execution facts into an `Observation`:

- receipt schema version and claim text
- exit code, timeout flag, and abort flag
- duration and executor
- a digest-bound receipt reference

The adapter deliberately omits the legacy mutable evidence status. Receipt digest validation does not prove ledger membership, trusted attestation, runner honesty, freshness, or OS isolation; apply those checks separately before trusting the observation.

```typescript
import { evaluateTask, reduceRuntimeDecision } from "omk-protocol";
import { evidenceReceiptToObservation } from "open-multi-agent-kit";
```

The legacy `TaskContract`, `EvidenceStatus`, `TaskContractBuilder.setVerdict()`, and `updateEvidenceStatus()` remain for compatibility and are deprecated. New code should append observations and recompute evaluation.

## Authority boundaries

This slice does not change runtime ownership:

- the coding-agent still owns provider retry and failover execution;
- AdaptOrch WPL still owns its existing work-packet state machine and adjudication types;
- scheduler and router separation, topology validation, background-task durability, and algorithm-isolation work remain follow-up migrations.

Those components should consume `omk-protocol` rather than define new task, attempt, observation, or semantic-verdict types.
