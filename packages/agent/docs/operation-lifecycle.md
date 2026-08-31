# Operation lifecycle

`OperationLifecycleController` owns the distinction this layer exists for:

```text
one public operation  !=  one low-level agent attempt
```

A public operation (`prompt`, `skill`, `promptFromTemplate`, `compact`,
`navigateTree`) may span several attempts — an initial agent loop plus, for
prompt-family operations, one bounded overflow-recovery continuation. The
controller keeps operation identity, attempt identity, cancellation
ownership, and settlement ordering in one place, behind a pure reducer.

Status: **integrated**. `AgentHarness` routes every public operation
(`prompt`, `skill`, `promptFromTemplate`, `compact`, `navigateTree`) through
`runOperation()`, which begins a lease, runs the body, flushes accepted
session writes before classification, and settles exactly once. Overflow
recovery is a stage of the originating prompt operation; `agent_end` is an
attempt event and no longer settles anything. Inline structural reentry from
observational callbacks rejects with `"busy"`; the deferred command queue
for callback-driven follow-on work is a later slice.

Related: [session-write-coordinator.md](./session-write-coordinator.md) for
the write-ordering layer below this one, and
[agent-harness.md](./agent-harness.md) for the current public lifecycle.

## 1. Module map

| Module | Role | Constraints |
| --- | --- | --- |
| `src/harness/operation-lifecycle-types.ts` | operation/attempt/outcome/state/command/violation vocabulary | imports nothing; browser-safe leaf |
| `src/harness/operation-lifecycle-reducer.ts` | pure transition table + rejection rules | no clock, no IDs, no events, no I/O, never mutates input |
| `src/harness/operation-lifecycle-controller.ts` | sole owner of mutable lifecycle state; leases; abort capture; settle barrier | no session append, no provider calls, no compaction logic |

Side-effect split: the reducer decides whether a transition is legal; the
controller performs every effect around it (clock reads, ID allocation,
abort-signal delivery, settled-promise resolution).

## 2. Identity model

```ts
HarnessOperationRef { operationId, sequence, kind, startedAtMs }
HarnessAttemptRef   { operationId, attemptId, index, reason, startedAtMs }
```

- `operationId` is the external correlation id, allocated by the injected
  `createOperationId` dependency.
- `sequence` is monotonic per harness instance and must be exactly
  `lastSequence + 1` at `begin` (`sequence_violation` otherwise).
- `attemptId` is derived deterministically: `<operationId>:a<index>`.
- `index` is 0-based and must equal the number of already-finished attempts
  (`sequence_violation` on reuse or skip).
- `reason` is `"initial"` (index 0, from `preparing`) or
  `"context_overflow_recovery"` (index > 0, from `recovering_overflow`).
  Provider-internal HTTP retries are not harness attempts.

Overflow recovery is never its own top-level operation; it is a stage of the
originating prompt-family operation and keeps the same `operationId`.

## 3. State machine

```text
idle
  | begin
  v
active/preparing
  | attempt_begin (prompt family, index 0, reason initial)
  | stage(structural_running) (manual_compaction, tree_navigation)
  v
active/attempt_running  <---------------------+
  | stage(save_point)                          |
  v                                            |
active/save_point ---- stage(attempt_running) -+
  |
  | attempt_end
  v
active/preparing
  | stage(recovering_overflow) (prompt family, no active attempt)
  v
active/recovering_overflow
  | attempt_begin (index > 0, reason context_overflow_recovery)
  v
active/attempt_running ...

Structural path:
active/preparing -> active/structural_running -> active/committing

Any active stage:
  | settle_begin
  v
settling
  | settle_finish
  v
idle
```

`structural_running -> committing` is the single declared commit point of a
structural operation; it is a deliberate conservative extension of the
plan's table so the cancellation matrix has an explicit before/after-commit
boundary to hang on.

`abort_request` is legal from any active stage and only sets a flag in the
reducer state; delivering the signal is the controller's side effect.

## 4. Rejected transitions

Every transition not listed above is rejected with a classified
`HarnessLifecycleViolation` (an `Error`, preserved as `cause`):

| Code | Meaning | Examples |
| --- | --- | --- |
| `busy` | another operation is active or settling | `begin` during `active`/`settling` |
| `stale_operation` | command names a non-current operationId | stage/settle_finish for another op |
| `invalid_transition` | shape-illegal move | `attempt_begin` from `idle`; structural op + `attempt_begin`; `tree_navigation` + `recovering_overflow`; `settle_finish` before `settle_begin`; any non-`settle_finish` command while `settling` |
| `attempt_mismatch` | attempt identity conflict | second `attempt_begin` while one is active; `attempt_end` naming another attempt |
| `sequence_violation` | monotonicity broken | `begin` sequence skip; reused or skipped attempt index |

`settle_finish` from `active` is rejected: every operation must pass through
`settling`, so the finalizer barrier cannot be skipped. (This rule was added
after the generated-sequence property produced a counterexample walking
straight from `active` to `idle`.)

## 5. Controller contract

```ts
begin(kind)                      -> OperationLease { operation, signal, settled }
setStage(lease, stage)           -> void
beginAttempt(lease, reason)      -> AttemptLease { attempt, signal }   // signal === lease.signal
finishAttempt(lease, attempt, outcome)
requestAbort()                   -> { target?, signalDelivered }
settle(lease, outcome, finalize) -> Promise<HarnessOperationOutcome>
getAttemptSummaries(lease)       -> readonly HarnessAttemptSummary[]
waitForIdle()                    -> Promise<void>
getSnapshot() / getCurrentOperation()
```

Lease discipline:

- Every mutating method requires the `OperationLease` returned by `begin`.
  A lease that is not the current record throws `AgentHarnessError`
  `"invalid_state"` before any reducer command runs — a stale async
  continuation can never mutate a newer operation's state.
- Attempts never own an `AbortController`; the attempt lease reuses the
  operation signal.
- `requestAbort()` captures the current operation only. From `idle` it
  returns no target; from `settling` it returns the target with
  `signalDelivered: false`; from `active` it flags the reducer state and
  aborts the operation controller. It never waits for or signals operations
  started after the call.

Settlement:

- `settle()` is the only `active -> idle` path. It transitions to
  `settling`, runs the caller's `finalize` inside that barrier, transitions
  to `idle`, then resolves `lease.settled` and every `waitForIdle()` waiter.
- Double `settle` fails closed at two levels: the controller's
  `settleStarted` guard and the reducer's `settling` rejection.
- `lease.settled` resolves exactly once with the recorded outcome and never
  rejects, so ignoring it cannot strand an unhandled rejection.
- A finalizer failure still completes the state release and lease
  resolution, then rejects the `settle()` call itself. Outcome
  reclassification (e.g. body success + flush failure becoming a failed
  operation with an `AggregateError`) is the integration layer's job, not
  the controller's.

Reducer-purity note: reducer state carries `HarnessSettledAttempt` records
(attempt + outcome) without wall-clock finish times, because the reducer
must not read a clock. `getAttemptSummaries` renders public
`HarnessAttemptSummary` values from those records plus the controller's own
clock readings.

## 6. Integration invariants (enforced)

These invariants held while wiring `AgentHarness` public operations through
the controller and are pinned by tests:

- at most one active operation and one active attempt per harness
- exactly one `settled` per public operation, across overflow recovery,
  failure, and abort; failed operations settle with a `failed` outcome
- `agent_end` is an attempt event; it never transitions lifecycle state
- overflow recovery keeps the originating `operationId` and runs at most one
  continuation attempt with reason `context_overflow_recovery`
- the final session-write flush precedes outcome classification; a failed
  flush never produces a `completed` outcome and rejects the public promise
  with a `session`-classified error
- abort waits only for the captured operation's `settled` promise
- attempts share the operation's abort signal; no attempt owns an
  `AbortController`
- `save_point` is an intra-attempt stage: attempts may end from
  `attempt_running` or `save_point`

Remaining integration slices: strict callback reentrancy with deferred
commands, flush context/summaries on the write coordinator, durable journal,
proof runtime.

## 7. Verification

```bash
npx vitest run --config vitest.harness.config.ts \
  test/harness/operation-lifecycle-reducer.test.ts \
  test/harness/operation-lifecycle-reducer.property.test.ts \
  test/harness/operation-lifecycle-controller.test.ts
```

- reducer unit suite: every legal transition, every rejection class, input
  immutability, determinism, fresh-state returns.
- reducer property suite (fast-check): model-guided random walks over the
  full transition graph (1,000 runs, seed `0x90c1ec1e`) checking state
  shape, attempt-index monotonicity, at-most-one active operation/attempt,
  and exactly-once settle per operation id; plus a 500-run determinism
  property over arbitrary command streams.
- controller suite: begin/busy, settle exactly-once (including a racing
  second settle), finalizer barrier ordering, finalizer-failure release,
  stale-lease rejection, violation-cause preservation, attempt id
  derivation and summaries, abort capture across idle/active/settling and
  across successive operations, `waitForIdle` ordering.
- integration suite (`operation-lifecycle-integration.test.ts`): event
  correlation and ordering, inline-reentry rejection from `agent_end`,
  flush-failure precedence over provider success, same-operation overflow
  recovery correlation, and target-captured abort.
- characterization fixtures (`operation-settlement.characterization.test.ts`)
  pin normal/failure/abort single-settlement and post-fix single-settlement
  overflow traces.

Run counts are smoke-level PR gates, not correctness proofs; the
integration slice adds the full model-based harness property with the
plan's PR/nightly run counts.
