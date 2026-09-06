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

## Durable goal lifecycle

A durable goal is working-directory state, not a session-file field or a `TaskSpec`. `/goal <objective>` creates or edits `.omk/goals/current.json`; `/goal` without arguments shows its status and round count.

Goals created by `/goal` use an eight-round cap. The controller queues another turn only while the goal is active, no message is pending, and the cap has not been reached. Reaching the cap stops automatic continuation; the controller does not infer or mark completion.

For programmatic lifecycle control, import `createDurableGoal`, `parseDurableGoalSnapshot`, `applyDurableGoalCommand`, and `DurableGoalStore` from `open-multi-agent-kit`. The reducer supports edit, pause, resume, block, round advancement, evidence attachment, completion, and clear transitions.

Every mutation consumes the current revisioned `GoalRef`; stale revisions are rejected. Editing the objective or round limit, or advancing a round, starts a new semantic generation and invalidates earlier completion evidence. Completion requires lowercase SHA-256 evidence captured during the current generation.

### Seam checkpoints

A durable goal can carry one bounded `Goal / Core / Verified / Open / Next` seam checkpoint. The checkpoint is another revision in `.omk/goals/current.json`, not a separate state tree. It is bound to the goal generation and referenced evidence IDs, forced-redacted before persistence, and correlated by a content digest. The digest is unkeyed: it detects accidental mismatch but does not authenticate workspace state against a same-user editor.

Use the interactive command with strict JSON:

```text
/goal checkpoint {"core":["Keep deterministic gates authoritative"],"verified":["focused-tests"],"open":["Historical calibration"],"next":"Run the package checks"}
```

`verified` may name only fresh evidence already attached to the current goal generation. A round advance carries the checkpoint record forward but does not make its evidence current-round proof. The built-in controller injects checkpoint prose only when the user recorded it through `/goal checkpoint` in the current process. A checkpoint loaded from mutable workspace state is noted by digest and its prose is not promoted to user authority. Editing the objective or round limit clears it. The session stores only a `goal_checkpoint` entry containing the goal ID, revision, and checkpoint digest; complete content remains in the existing durable-goal journal.

Programmatic callers use the `record-checkpoint` command with `applyDurableGoalCommand()` or `DurableGoalStore.transition()`. `parseDurableGoalCheckpointCommand()` parses the interactive JSON shape; `formatDurableGoalCheckpoint()` renders the five fields.

## Evaluation model

`evaluateTask()` is a pure `TaskSpec + ExecutionAttempt + Observation[] + WaiverRecord[] -> EvaluationResult` reducer. It does not mutate its inputs or stored evidence.

An observation condition selects facts by observation kind and task or attempt scope. Its expected facts are a recursive object subset; arrays match exactly.

- no candidate observation: `inconclusive`
- candidate with matching facts: `satisfied`
- candidates present but none match: `violated`
- `all`, `any`, and `not` compose conditions without adding evaluator state

Required, unwaived violations reduce to `fail`. Required, unwaived missing observations reduce to `inconclusive`. Otherwise the semantic verdict is `pass`. Advisory claims are reported but do not block. A task with no required claims is `inconclusive`.

`reduceRuntimeDecision()` then maps the semantic verdict through an explicit runtime policy. `pass` always stops successfully; fail and inconclusive behavior is supplied as `onFail` and `onInconclusive`. Retry and failover counters are not fields: consumers derive them from `ExecutionAttempt` records.

### Advisory best-of-N judge

`chooseWithAdvisoryJudge()` is an optional selection sidecar, not a protocol verdict producer. It validates each `EvaluationResult`, admits only candidates whose semantic verdict is `pass`, and lets a judge score only that eligible set. Zero eligible candidates produce no selection; one skips the model; multiple candidates use weighted 0–4 rubric scores.

Candidate material, the task goal, and rubric descriptions are forced-redacted and bounded before the judge receives them. The model adapter uses a tool-free prompt, treats candidate text as untrusted data, disables retries and cache retention, and accepts only a complete matrix of known candidate and criterion IDs. A provider error, timeout, malformed JSON, unknown ID, or incomplete score matrix selects the existing deterministic first choice and reports a sanitized fallback reason.

Since v0.98.3, the first-party model adapter requires a normal `stop`, cancellation discards late advice, and top-score ties report their deterministic rank source. Diagnostic counts preserve intake and missingness; they are not independent verification. See [Advisory selection integrity](advisory-selection.md).

The sidecar never creates an `Observation`, changes `EvaluationResult.semanticVerdict`, supplies independent-verifier evidence, waives a claim, or changes `RuntimeDecision`. Parsing the evaluation checks structure, not the truth of its evidence. Run fresh tests, integrity checks, security gates, and evidence freshness checks after applying the selected candidate.

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
