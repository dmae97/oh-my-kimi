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
  | stage(recovering_overflow) (prompt family, no active attempt,
  |                             last closed attempt ended `overflow`)
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

`preparing -> recovering_overflow` additionally requires that the most
recently closed attempt ended with `overflow`. Without that guard the stage
was a dead end: index 0 must start from `preparing` and index > 0 must follow
an overflow, so an operation that entered recovery with no attempt (or after a
completed/failed/aborted one) could only settle.

`abort_request` is legal from any active stage and only sets a flag in the
reducer state; delivering the signal is the controller's side effect.

## 4. Rejected transitions

Every transition not listed above is rejected with a classified
`HarnessLifecycleViolation` (an `Error`, preserved as `cause`):

| Code | Meaning | Examples |
| --- | --- | --- |
| `busy` | another operation is active or settling | `begin` during `active`/`settling` |
| `stale_operation` | command names a non-current operationId | stage/settle_finish for another op |
| `invalid_transition` | shape-illegal move | `attempt_begin` from `idle`; structural op + `attempt_begin`; `tree_navigation` + `recovering_overflow`; `recovering_overflow` when the last closed attempt did not overflow; `settle_finish` before `settle_begin`; any non-`settle_finish` command while `settling` |
| `attempt_mismatch` | attempt identity conflict | second `attempt_begin` while one is active; `attempt_end` naming another attempt; `settle_begin` while an attempt is still open |
| `sequence_violation` | monotonicity broken | `begin` sequence skip; reused or skipped attempt index |

`settle_finish` from `active` is rejected: every operation must pass through
`settling`, so the finalizer barrier cannot be skipped. (This rule was added
after the generated-sequence property produced a counterexample walking
straight from `active` to `idle`.)

`settle_begin` while an attempt is still open is rejected for the same reason
in the attempt dimension. It is the last line of defence behind the
integration layer's `runAttempt()` wrapper: if a bug ever dropped an
`attempt_end`, the operation would otherwise settle with a summary silently
missing a started attempt. The reducer refuses instead.

## 5. Controller contract

```ts
begin(kind)                      -> OperationLease { operation, signal, settled }
setStage(lease, stage)           -> void
beginAttempt(lease, reason)      -> AttemptLease { attempt, signal }   // signal === lease.signal
finishAttempt(lease, attempt, outcome)
requestAbort()                   -> { target?, signalDelivered }
settle(lease, outcome, finalize) -> Promise<HarnessOperationOutcome>
getAttemptSummaries(lease)       -> readonly HarnessAttemptSummary[]
getAttemptSummary(lease, attempt)-> HarnessAttemptSummary
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
  `settleStarted` guard and the reducer's `settling` rejection. The guard
  engages only after the reducer has accepted `settle_begin`: a rejected
  settle (for example with an attempt still open) is not a settlement, so the
  operation can still settle once the transition is legal instead of hanging
  `lease.settled` and every `waitForIdle()` waiter forever.
- `lease.settled` resolves exactly once with the recorded outcome and never
  rejects, so ignoring it cannot strand an unhandled rejection.
- A finalizer failure still completes the state release and lease
  resolution, then rejects the `settle()` call itself. Outcome
  reclassification (e.g. body success + flush failure becoming a failed
  operation with an `AggregateError`) is the integration layer's job, not
  the controller's.

Runtime immutability:

- Operation and attempt refs are frozen when allocated, so the lease, the
  getters, and every event payload share one identity that extension code
  cannot rewrite. `readonly` is erased at runtime; freezing is not.
- Reducer-produced state is frozen on assignment, so `getSnapshot()` can hand
  back the live reference without cloning on a hot path. `Reflect.set` on a
  snapshot fails instead of corrupting correlation IDs.

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
- **failure-safe settlement**: everything after a successful `begin()` runs
  inside one capture region, so a throwing `operation_started` listener still
  settles the operation and returns the harness to idle rather than wedging it
  at `busy`. Settlement failure may reject the public call but never blocks
  the state release.
- **exact attempt closure**: `count(attempt_started) == count(attempt_finished)`.
  A throwing `attempt_started` listener closes its attempt as `failed`;
  `attempt_finished` is emitted only after the attempt is already closed, so a
  throwing observer cannot reopen committed attempt state.
- **outcome precedence** is a single rule:
  `session flush failure > non-abort body/hook failure > explicit abort >
  result-classified outcome > completed`. A raised abort signal alone never
  downgrades another failure to `aborted`, so a flush failure during an
  aborted turn settles `failed`/`session` and rejects with `session`. A flush
  error that already carries a harness classification (an `invalid_state`
  coordinator reentry) keeps it in both the outcome and the rejection.
- **boundary flushes never erase earlier causes**: the attempt-closing flush
  in `runAttempt()` and the `turn_end` save-point flush run after a body or
  listener failure, and when they fail too every cause stays reachable through
  one `AggregateError` (`combineBoundaryErrors`) classified by the primary
  failure. The flush still wins the operation outcome; it just no longer hides
  what failed before it.
- **queued input needs a consumer**: `steer()` and `followUp()` reject with
  `invalid_state` while a structural operation (`compact`, `navigateTree`) is
  active, because no agent attempt exists to consume them and the messages
  would otherwise leak into the next prompt.
- **prompt-family parity**: `prompt()`, `skill()`, and `promptFromTemplate()`
  classify an assistant error as `failed` and an assistant abort as `aborted`.
- **cancellation is observable**: a `session_before_tree` hook cancel or an
  aborted branch summary settles `navigateTree` as `cancelled`, leaving the
  session leaf unchanged.
- **commit staging**: structural operations enter `committing` immediately
  before the session mutation (`session.moveTo`, `appendCompaction`). A
  cancelled navigation and a no-op navigation never reach it.
- **callback self-wait fails closed**: `waitForIdle()` and `abort()` reject
  with `invalid_state` when called from the synchronous prologue of a listener
  for the current operation, turning a permanent deadlock into a classified
  error. An unrelated concurrent caller is unaffected. A wait deferred behind
  another `await` inside the listener is out of scope for this guard.
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

Remaining integration slices: deferred command queue for callback reentrancy,
flush context/summaries on the write coordinator, durable journal, proof
runtime.

## 7. Verification

```bash
npx vitest run --config vitest.harness.config.ts \
  test/harness/operation-lifecycle-reducer.test.ts \
  test/harness/operation-lifecycle-reducer.property.test.ts \
  test/harness/operation-lifecycle-controller.test.ts \
  test/harness/operation-outcome.test.ts \
  test/harness/operation-lifecycle-integration.test.ts \
  test/harness/operation-lifecycle-failure-safety.test.ts \
  test/harness/operation-settlement.characterization.test.ts
```

- reducer unit suite: every legal transition, every rejection class, input
  immutability, determinism, fresh-state returns.
- reducer property suite (fast-check): model-guided random walks over the
  full transition graph (1,000 runs, seed `0x90c1ec1e`) checking state
  shape, attempt-index monotonicity, at-most-one active operation/attempt,
  exactly-once settle per operation id, and that an accepted `settle_begin`
  proves no attempt was left open and that started attempt IDs equal finished
  attempt IDs; plus a 500-run determinism property over arbitrary command
  streams.
- controller suite: begin/busy, settle exactly-once (including a racing
  second settle), a rejected `settle_begin` leaving the operation settleable,
  finalizer barrier ordering, finalizer-failure release, stale-lease
  rejection, violation-cause preservation, attempt id derivation and
  summaries, abort capture across idle/active/settling and across successive
  operations, `waitForIdle` ordering.
- outcome suite (`operation-outcome.test.ts`): the precedence table in
  isolation, attempt classification, outcome/rejection code parity for a
  pre-classified flush failure, `combineBoundaryErrors`, and a fast-check
  property (200 runs) that a failed outcome always rejects.
- integration suite (`operation-lifecycle-integration.test.ts`): event
  correlation and ordering, inline-reentry rejection from `agent_end`,
  flush-failure precedence over provider success, same-operation overflow
  recovery correlation, and target-captured abort.
- failure-safety suite (`operation-lifecycle-failure-safety.test.ts`): throwing
  `operation_started` / `attempt_started` / `attempt_finished` listeners,
  prompt-family outcome parity, abort-versus-flush-failure precedence,
  listener and storage causes both surviving a failed boundary flush,
  `steer`/`followUp` rejection during a structural operation, `navigateTree`
  cancellation, `committing` observed before the session mutation, callback
  self-wait rejection, and event-payload mutation safety.
- characterization fixtures (`operation-settlement.characterization.test.ts`)
  pin normal/failure/abort single-settlement and post-fix single-settlement
  overflow traces.

Run counts are smoke-level PR gates, not correctness proofs; the
integration slice adds the full model-based harness property with the
plan's PR/nightly run counts.
