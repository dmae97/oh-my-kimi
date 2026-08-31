# Session write coordinator

`SessionWriteCoordinator` owns every session write that `AgentHarness` routes
through it: writes queued while a turn is active, and direct writes accepted
while the harness is idle. This document describes the ordering model, failure
semantics, immutability boundaries, and the contracts that callers and storage
adapters must honor.

Related: [AgentHarness lifecycle](./agent-harness.md) for phases and save
points, and [durable harness design](./durable-harness.md) for the
crash-recovery work this layer does not implement.

## 1. What changed and why

Before this change `AgentHarness` held `pendingSessionWrites` as a private
array and flushed it inline, while idle writes bypassed that array and called
`Session` append methods directly. That produced four defects.

1. Ordering after failure. A queued write that failed to persist stayed at the
   head of the array, but a later idle write persisted immediately, so the
   later write reached storage before the earlier accepted one.
2. Deferred reads of caller-owned state. `setModel` and `setActiveTools`
   validated their input, then read `model.provider`, `model.id`, and
   `toolNames` again inside a later persistence step. A caller that mutated its
   own object or array in between could persist a value that was never
   validated.
3. No boundary between concurrent idle writes. Two idle writes could interleave
   inside storage.
4. No single owner. Queue state, flush order, and per-variant dispatch lived in
   the same class as run lifecycle, provider streaming, compaction, and tree
   navigation.

The coordinator resolves all four by owning the queue and every persistence
boundary that passes through it.

## 2. Position in the harness

```text
extension / application code
        |
        v
HarnessSession facade         phase gate, plain-data snapshot
        |
        v
SessionWriteCoordinator       queue ownership, ordering, dispatch
        |
        v
Session / SessionStorage      durable append, leaf selection
```

Scope note: this layer owns single-process write ordering only. Operation
lifecycle (operation/attempt identity, settlement) is the
`OperationLifecycleController` layer; exactly-once durability across crashes
and ambiguous commits is the later `PreparedSessionMutation` + journal
milestone. See [operation-lifecycle.md](./operation-lifecycle.md).

`AgentHarness` constructs one coordinator per harness instance and passes that
same instance to the facade, so extension writes and harness configuration
writes share a single ordering domain.

`harness-session.ts` imports no harness or session types; it takes structural
ports instead, because the import-cycle ratchet treats static type imports as
architectural edges and `AgentHarness` plus `Session` already form a legacy
cycle component. The coordinator follows the same rule and declares its own
`SessionWritePort` structural interface.

Files in this change:

| File | Change |
| --- | --- |
| `src/harness/session-write-coordinator.ts` | New. Queue ownership, ordering, dispatch. |
| `src/harness/agent-harness.ts` | `pendingSessionWrites` array and `flushPendingSessionWrites()` removed; all call sites route through the coordinator. |
| `src/harness/harness-session.ts` | Facade `SessionPort` narrowed to reads; persistence delegates to the coordinator. |
| `src/harness/types.ts` | `SessionStorage` gains the non-reentrancy contract. |
| `test/harness/session-write-order.property.test.ts` | New. Ordering, snapshot, and failure-property coverage. |

## 3. Write taxonomy and dispatch

The coordinator accepts one closed union, `QueuedSessionWrite<TMessage>`, with
nine variants:

| Variant | Payload | Durable operation |
| --- | --- | --- |
| `message` | `message` | `session.appendMessage` |
| `thinking_level_change` | `thinkingLevel` | `session.appendThinkingLevelChange` |
| `model_change` | `provider`, `modelId` | `session.appendModelChange` |
| `active_tools_change` | `activeToolNames` | `session.appendActiveToolsChange` |
| `custom` | `customType`, `data?` | `session.appendCustomEntry` |
| `custom_message` | `customType`, `content`, `display`, `details?` | `session.appendCustomMessageEntry` |
| `label` | `targetId`, `label` | `session.appendLabel` |
| `session_info` | `name?` | `session.appendSessionName` |
| `leaf` | `targetId` (`string \| null`) | `storage.setLeafId` |

Dispatch is an exhaustive `switch` whose `default` assigns the write to
`never` and throws `AgentHarnessError` code `"invalid_state"`. A write variant
that compiles but is not dispatched is therefore a compile error; a variant
that reaches runtime undispatched fails closed instead of being dropped
silently.

All payload fields are `readonly`. The facade's own `FacadeWrite` union is the
seven extension-facing variants (`message`, `custom`, `custom_message`,
`label`, `session_info`, `leaf`); `model_change`, `thinking_level_change`,
and `active_tools_change` enter the queue only from `AgentHarness`
configuration setters, which is why the facade no longer declares them.

## 4. Ordering model

### 4.1 Queue discipline

`enqueue(write)` snapshots the write (section 6.1) and appends it to
`pendingWrites`. `flush()` drains the queue strictly head-first: the head is
persisted, and only after that persistence resolves is it removed with
`shift()`. Removal is therefore acknowledgement-gated rather than
fire-and-forget, and within a single process no accepted write is persisted
twice by the coordinator itself.

This is not yet an exactly-once durability guarantee. It holds only while the
storage adapter honors the implication "a rejected append means nothing was
committed" (section 5.5) and the process does not crash with a non-empty
queue.

### 4.2 Serialized persistence boundaries

Every persistence operation that passes through the coordinator — both
`flush()` and `persistAfterPending(write)` — runs inside `serialize()`, a
promise-tail chain:

```text
operationTail ──▶ op A ──▶ op B ──▶ op C
                 (settled)  (active)  (chained, not started)
```

Each invocation appends its operation after the previous tail, so two
concurrent idle writes cannot interleave inside storage; invocation order is
persistence order. The tail is released via `next.then(release, release)`,
which runs on both the fulfillment and the rejection path — a failed write
does not wedge the chain, and the next serialized operation still starts.

### 4.3 Empty-boundary reservation

`persistAfterPending(write)` snapshots the idle write, then serializes
"drain the queue, then persist this write". Because the boundary is reserved
synchronously at invocation time, an idle write invoked first owns its
boundary even when a later `enqueue` happens in the same tick or the next
microtask: the queued write lands behind the already-scheduled boundary and
is persisted by a later flush. The property tests cover both the synchronous
and the `queueMicrotask` interleavings.

Within the boundary, `leaf` is special-cased: an idle leaf write goes through
`session.moveTo(targetId)` (which updates live session state in addition to
storage), while a queued `leaf` flush goes through
`session.getStorage().setLeafId(targetId)` directly. The two paths are
distinct on purpose and pinned by a test that counts `moveTo` calls.

### 4.4 Single ordering domain

`AgentHarness` constructs exactly one coordinator and passes that same
instance to `HarnessSessionFacade`. Extension writes (facade) and harness
configuration writes (`setModel`, `setThinkingLevel`, `setActiveTools`) share
one queue and one serialization tail, so there is no inter-domain race to
reason about.

## 5. Failure semantics

### 5.1 Queued writes block the head

If persisting the queue head rejects, `flushPending` propagates the error and
the head stays queued. The queue is not dropped, reordered, or skipped. A
later idle write calls `persistAfterPending`, which drains the accepted queue
first; only after the recovered head (and everything behind it) is durable
does the idle write persist. A later write can never overtake an earlier
accepted one, including across a persistence outage. This is the defect-1 fix,
pinned by the fast-check property in section 9.

### 5.2 Failed idle writes are not retained

An idle write that rejects was never enqueued — its snapshot lives only inside
its own `persistAfterPending` boundary. After rejection nothing remains to
replay, `getPendingWrites()` stays empty, and later flushes cannot resurrect a
write the caller already saw fail. The caller observes the failure once,
classified (section 5.4), and retries explicitly if it wants to.

### 5.3 Synchronous reentry fails closed

`serialize()` sets `invokingOperation` while an operation body runs. If a
storage implementation synchronously calls back into coordinator-routed
persistence while its own mutation is unsettled, the nested `serialize` throws
`AgentHarnessError` code `"invalid_state"` immediately instead of deadlocking
on a tail promise that can never settle. Asynchronous reentry is not
rejected — it simply chains onto the tail like any other operation.

### 5.4 Error classification survives the facade

The facade wraps persistence failures as `AgentHarnessError` code `"session"`
with the original error as `cause`. One exception: an `AgentHarnessError`
already classified as `"invalid_state"` (the reentry rejection, or a
phase-gate violation) is rethrown unchanged so callers can distinguish
programming errors from storage failures. The facade's own argument
validation (`appendLabel`/`setLeafId` on a missing entry, non-plain-data
payloads) uses `"invalid_argument"` and never reaches the coordinator.

### 5.5 Commit ambiguity and durability vocabulary

The guarantee in section 4.1 decomposes into three claims of increasing
strength:

```text
1. accepted writes stay FIFO in the in-memory queue
2. a resolved storage promise dequeues the head exactly once
3. a write is durable exactly once across ambiguous commits and crashes
```

This layer proves 1 and 2. Claim 3 requires storage semantics this layer does
not yet have. A rejected append promise does not, in general, prove that
nothing was committed: bytes may have been written before a post-write hook
or sync failed. Retrying that head then appends the same logical write again,
because `Session.append*()` allocates a fresh entry ID and timestamp per
call.

Failure kinds a caller must eventually distinguish:

| Kind | Meaning | Safe automatic response |
| --- | --- | --- |
| `not_committed` | rejection before any durable effect | retry is safe |
| `commit_unknown` | rejection after commit became ambiguous | never auto-retry; surface to the operation |
| `committed_but_ack_failed` | durable, acknowledgement lost | dedupe on read, do not rewrite |
| `invalid_write` | payload rejected as malformed | fix caller, do not retry |
| `storage_unavailable` | backend unreachable | retry per policy |

Default guarantee (all adapters): single-process FIFO ordering,
achknowledgement-gated dequeue, no intentional replay of a rejected idle
write, and a rejected queue head stays queued. Stronger adapter guarantee
(optional contract): an adapter may document "rejection implies no commit",
under which head retry after failure is also duplicate-free. Adapters that
cannot honor it must treat ambiguous failures as `commit_unknown`.

Closing claim 3 is the `PreparedSessionMutation` milestone: stable mutation
identity allocated at acceptance time, idempotent storage append (same ID +
same digest = success, same ID + different digest = conflict), and
crash-recovery replay from a durable journal. Until then, no document or
event from this layer may claim exactly-once durability.

## 6. Immutability boundaries

### 6.1 Snapshot at acceptance

Both `enqueue` and `persistAfterPending` run `createImmutableSnapshot(write)`
at acceptance: the payload is asserted plain-data (no cyclic graphs, no
class instances, no accessors, no sparse arrays, no non-finite numbers),
deep-cloned with `structuredClone`, and recursively frozen. Persistence later
reads the coordinator-owned snapshot, never the caller's object. The facade
additionally snapshots at its own boundary so non-plain-data writes fail with
`"invalid_argument"` before they reach the queue.

### 6.2 Invocation-time capture in AgentHarness

`setModel` copies `model.provider` and `model.id` into locals before either
enqueueing or persisting, and both `setActiveTools` paths copy the input
array and validate the copy. The durable record and the live
`this.activeToolNames` both derive from the validated invocation-time values;
a caller mutating its own descriptor or array after the call cannot change
what gets persisted (defect 2). The same capture applies to
`setThinkingLevel`.

### 6.3 Dispatch-time copies

At persistence time the coordinator passes `[...write.activeToolNames]` and a
spread of `custom_message` content arrays to storage, so even though the
queued snapshot is frozen, storage receives a plain mutable copy it may
consume freely.

## 7. Flush boundaries in AgentHarness

The harness flushes the coordinator at four boundaries, each chosen so that
no accepted write outlives the moment its meaning changes:

| Boundary | Site | Guarantee |
| --- | --- | --- |
| Turn settlement | `turn_end` event handling | Queued turn writes are durable before the `save_point` event fires; `hadPendingMutations` on that event reflects the pre-flush queue state. |
| Run settlement | `agent_end` event handling | Flush completes before `phase` flips to `"idle"`, so a listener that starts the next `prompt()` from `agent_end`/`settled` cannot inherit unflushed state from the finishing run. |
| Next-turn preparation | `prepareNextTurn` callback | Context rebuilt for the next turn reads storage after all queued writes landed. |
| Run cleanup | `prompt()` `finally` | Even on failure or abort, accepted writes are flushed before the run's abort controller is released. |

`turn_end` ordering is deliberate: extension errors are captured first, the
flush runs, and only then is the captured error rethrown — a failing listener
cannot strand accepted writes.

## 8. Contracts

### 8.1 Caller contract

- Writes during phase `"turn"` are accepted into the queue and persist at the
  next flush boundary; the caller does not await durability.
- Writes during phase `"idle"` persist before the returned promise resolves;
  a rejection means the write did not happen and will not replay.
- Writes during any structural phase (compaction, branch navigation, retry)
  reject with `"invalid_state"` instead of lingering past settlement.
- Payloads must be plain data; anything else rejects with
  `"invalid_argument"` at the facade boundary.

### 8.2 SessionStorage non-reentrancy

`SessionStorage` mutation methods are non-reentrant (documented on the
interface in `types.ts`): while a storage mutation is unsettled, the
implementation must not call or await mutators on its owning `Session`,
`HarnessSession`, or `AgentHarness`. The synchronous case is enforced by the
coordinator (section 5.3); the asynchronous case chains onto the tail and
silently reorders persistence behind the unsettled mutation, which is why the
contract forbids it outright.

### 8.3 Import-cycle rule

New modules at this boundary declare structural ports (`SessionWritePort`,
`SessionPort`) instead of importing `AgentHarness` or `Session` types. The
import-cycle ratchet counts static type imports as edges, and keeping the
coordinator and facade as leaves prevents the legacy cycle component from
growing.

## 9. Verification

`test/harness/session-write-order.property.test.ts` (10 tests) pins every
guarantee above:

- Facade error classification: a coordinator `"invalid_state"` rejection
  reaches the caller unwrapped.
- Leaf dual path: idle leaf writes use `Session.moveTo`; queued leaf writes
  use `storage.setLeafId` (call-counted).
- Acceptance snapshot: mutating caller data after `enqueue` does not change
  the persisted value.
- Empty-boundary reservation: an idle write invoked first persists before a
  later enqueue, for both synchronous and `queueMicrotask` interleavings.
- Idle serialization: a second idle write cannot enter storage while the
  first is held mid-persistence (blocking storage double).
- Invocation-time capture: mutating a model descriptor (via `Reflect.set`) or
  an active-tool array immediately after the setter call changes neither the
  persisted record nor live state.
- No retention: a rejected idle write is absent from the queue and never
  replays after storage recovers.
- FIFO-after-recovery property (fast-check, 60 runs, seed `0x53102026`):
  arbitrary-length queues accepted during a failed turn flush in FIFO order
  ahead of a later idle write once persistence recovers, and the queue drains
  exactly.

Run with:

```bash
npx vitest run test/harness/session-write-order.property.test.ts
```
