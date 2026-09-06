# Changelog

## [Unreleased]

## [0.98.3] - 2026-09-06

### Added

- Added internal, browser-safe canonical digests, operation trace recording/comparison, and Effect Journal V2 phase/replay/recovery primitives with deterministic tests. They are not exported from the package root or wired into default runtime authority; matching digests alone do not prove trusted execution.

- Split the harness abort/wait surface so a callback can act on its own operation without deadlocking it. `requestAbort()` delivers the abort signal and reports `{ operationId, signalDelivered, alreadySettling }` without awaiting settlement, so it is safe from inside a listener of the operation being settled; `abort()` remains the waiting form and still refuses a self-wait. `runWhenIdle(command)` queues work behind the current operation and returns a durable `CommandRef` immediately — commands run in registration order once the lifecycle is idle, each ref reports `queued`/`running`/`completed`/`failed`/`cancelled`, `done` never rejects, and `cancel()` stops a command that has not started. The self-wait rejection now names `runWhenIdle()` as the sanctioned path. A synchronous prologue guard still cannot see a wait placed behind an arbitrary `await` inside a callback, so deferring — not waiting — remains the only callback-safe option.

### Fixed

- A failed operation could record one top-level code and reject with another. `resolveOperationOutcome` classified a failure as `flush > body`, but `resolveOperationFailure` picked its primary as `body ?? flush` and then hardcoded `session` for a body-plus-flush failure while using the operation's own fallback code for a flush-plus-settle failure. A plain flush error alongside a settle error therefore settled as `session` and rejected as (say) `hook`, and a pre-classified flush error (`invalid_state`) alongside a body error settled as `invalid_state` and rejected as `unknown`. Both now read the top-level code from one shared `flush > body` classification source, so `outcome.code === rejection.code` for every failed outcome, while every concurrent cause stays reachable through one `AggregateError` in body, flush, settle order. A 1,000-combination property test pins the parity and the cause order.
- One throwing observational subscriber starved every subscriber registered after it, so a single failing extension could silently drop `settled`, `attempt_finished`, telemetry, and audit events. Both fan-out paths now deliver to every listener in registration order and raise the failures afterwards: `SubscriberFanout.emit()` in the harness, and `Agent`'s delivery, which moved to the new `listener-delivery.ts` leaf. A single failure still surfaces untouched so its own classification survives; several become one `AggregateError` classified by the first. Policy and mutation hooks (`AgentHarness.on()`) are unchanged and stay fail-fast, and each `Agent` listener still receives its own immutable snapshot so one observer's view cannot be rewritten into another's.

## [0.98.2] - 2026-09-02

### Added

- Added the operation lifecycle foundation modules: pure `operation-lifecycle-types` vocabulary, a side-effect-free `operation-lifecycle-reducer` transition table with classified violations, and `OperationLifecycleController` with operation/attempt leases, target-captured abort, exactly-once settlement, and a finalizer barrier.
- Routed every public `AgentHarness` operation through `runOperation()` on the lifecycle controller: `settled` now fires exactly once per operation with `operationId`, `outcome`, and `attemptCount`, and new `operation_started`, `attempt_started`, and `attempt_finished` events correlate attempts to operations. The final session-write flush precedes outcome classification, so a flush failure after provider success rejects with a `session`-classified error and never records `completed`.

### Fixed

- Stopped `OperationLifecycleController.settle()` from wedging an operation after a rejected `settle_begin`: the controller marked the settlement as started before the reducer accepted it, so an operation whose settle was refused (for example with an attempt still open) could never settle later, and `lease.settled` plus every `waitForIdle()` waiter hung forever. The guard now engages only once the reducer has entered `settling`.
- Kept the recorded outcome and the public rejection in agreement for a pre-classified final-flush failure: a coordinator `invalid_state` reentry rejection now settles with code `invalid_state` instead of being relabelled `session` while the promise rejected with `invalid_state`.
- Tightened the reducer so `preparing -> recovering_overflow` is legal only when the most recently closed attempt ended with `overflow`. Entering recovery with no attempt, or after a completed/failed/aborted attempt, produced a dead-end stage from which no attempt could begin; it is now an `invalid_transition`.
- Rejected `steer()` and `followUp()` with `invalid_state` while `compact()` or `navigateTree()` is active. Those operations run no agent attempt, so the accepted messages had no consumer and were silently injected into the next unrelated prompt.
- Stopped a failing boundary flush from erasing the error it followed. `runAttempt()` flushed inside a `finally`, so a storage failure at the attempt boundary replaced the provider or listener error; the `turn_end` save-point flush did the same to a throwing listener. Both boundaries now report every cause through one `AggregateError` (`combineBoundaryErrors`), classified by the primary failure, while the flush still wins the operation outcome.
- Extracted the subscriber fan-out and its self-wait barrier into `subscriber-fanout.ts` (`SubscriberFanout`), a leaf module, so `agent-harness.ts` stays under its module-size baseline.
- Made operation settlement failure-safe: everything after a successful `begin()` now runs inside one capture region, so a throwing `operation_started` listener settles the operation and returns the harness to idle instead of leaving it permanently `busy`.
- Closed every started attempt exactly once. A new `runAttempt()` wrapper owns begin/announce/run/classify/close/announce, so a throwing `attempt_started` listener closes its attempt as `failed` rather than orphaning it, and `attempt_finished` is emitted only after the attempt is already closed. The reducer now also rejects `settle_begin` while an attempt is open with `attempt_mismatch`.
- Gave `promptFromTemplate()` the same result classifier as `prompt()` and `skill()`: an assistant error settles `failed` and an assistant abort settles `aborted`, instead of recording `completed`.
- Fixed outcome precedence so a raised abort signal no longer masks a real failure. Precedence is now `session flush failure > non-abort body/hook failure > explicit abort > result-classified > completed`, so an aborted turn whose final flush fails settles `failed`/`session` and rejects with `session`.
- Connected the `cancelled` operation outcome: a `session_before_tree` hook cancel or an aborted branch summary now settles `navigateTree` as `cancelled` with the session leaf unchanged.
- Made session-write persistence follow acceptance order. Each queued write carries a monotonic sequence and each boundary captures a watermark at invocation time, so a write enqueued after an idle boundary was reserved can no longer overtake it (previously `A, C, B` for a blocked `A`).
- Replaced the callback self-wait deadlock with a classified failure: `waitForIdle()` and `abort()` now reject with `invalid_state` when called from the synchronous prologue of a listener for the current operation. Unrelated concurrent callers are unaffected.
- Froze lifecycle operation/attempt refs and reducer state at runtime, so mutating a `getSnapshot()` result or an event payload can no longer corrupt internal correlation IDs.
- Structural operations now enter the `committing` stage immediately before the session mutation (`session.moveTo`, `appendCompaction`), making the previously unreachable stage observable; cancelled and no-op navigations never reach it.
- Removed the `harness/types.ts` -> package-barrel import and its redundant `AgentHarness` re-export, breaking an import cycle and letting 13 modules leave the cycle baseline.
- Kept context-overflow recovery inside the originating operation: the continuation runs as attempt `a1` under the same `operationId`, so one public prompt settles exactly once instead of emitting a second `settled` after recovery. Recovery compaction now runs on the operation abort signal.
- Made `abort()` target-captured: it waits only for the operation current at call time, and operations started later by listeners are never its target. Inline structural reentry from observational callbacks now rejects with `"busy"` instead of chaining runs.
- Corrected `session-write-coordinator.md` durability claims: the coordinator guarantees single-process FIFO ordering and acknowledgement-gated dequeue, not unconditional exactly-once durability. Added the `commit_unknown` failure vocabulary and linked the `PreparedSessionMutation` milestone that closes the gap.
- Coordinator enqueue and serialized idle model/active-tool updates now persist invocation-time snapshots instead of rereading caller-owned mutable inputs after validation; synchronous persistence reentry rejects instead of deadlocking.
- Pending `AgentHarness` session writes now retain FIFO order after a persistence failure: recovered writes flush before any later idle write, with queue ownership and flush serialization isolated in `SessionWriteCoordinator`.

## [0.98.1] - 2026-08-30

### Added

- Added one-shot context-overflow recovery to `AgentHarness`: the failed assistant is removed from the active branch, history is compacted, and `runAgentLoopContinue()` retries without duplicating the user message. A second overflow is terminal, and unavailable recovery restores the original overflow leaf.
- Added projected-token auto-compaction before provider requests through `AgentHarnessOptions.compaction`. Successful runs rebuild the request from persisted compacted context; disabled, unauthenticated, cancelled, and true no-op decisions leave the request unchanged.
- Added bounded transient retry for generated compaction and branch-summary calls through `streamOptions.summarizationRetry`, with awaited `retry_scheduled`, `retry_attempt_start`, and `retry_finished` events. Quota/billing failures and aborts still fail fast.
- Added `AgentHarness.getSession()`, returning a storage-free `HarnessSession` facade. Persisted reads are detached snapshots; idle writes persist immediately; turn writes enter the ordered pending queue; structural-phase writes fail closed instead of lingering past settlement.

### Fixed

- `AgentHarness.abort()` now rejects during compaction, branch navigation, and retry phases instead of reporting success while an untracked structural operation remains active. Turn cancellation and idle queue clearing keep their existing behavior.

## [0.98.0] - 2026-08-28

## [0.97.0] - 2026-08-24

## [0.96.2] - 2026-08-21

### Notes

- Version lockstep with `open-multi-agent-kit@0.96.2`; no functional changes in this package.

## [0.96.1] - 2026-08-20

### Added

- Added the `gitreverse` passive-analysis route for public repository-to-prompt reconstruction, including GitHub/file-tree evidence requirements, Git/GitHub tool hints, and secret-safe acceptance criteria.

### Fixed

- Corrected the `resourceClaims` README example to use the public `key` field, matching the scheduler contract.

## [0.96.0] - 2026-08-16

## [0.95.2] - 2026-08-15

## [0.95.1] - 2026-08-01

## [0.95.0] - 2026-07-31

## [0.94.1] - 2026-07-27

## [0.94.0] - 2026-07-27

## [0.93.0] - 2026-07-26

## [0.92.0] - 2026-07-23

## [0.91.0] - 2026-07-21

### Notes

- Version lockstep with `open-multi-agent-kit@0.91.0`; no functional changes in this package.

## [0.90.8] - 2026-07-13

### Added

- Added `partitionToolBatchWaves`: tool-call batches now split into ordered, contiguous waves instead of all-or-nothing parallelization, so one conflicting or unknown call no longer serializes every independent read in the batch. `shouldParallelizeToolBatch` is now a single-wave check over the same partition.

### Fixed

- Fixed parallel tool-batch path overlap checks to collapse `.`/`..` segments, compare segments case-insensitively, and fail closed (sequential) when a path escapes the root, so `write`/`edit` calls aliasing the same file via `..` are no longer run concurrently.

## [0.90.7] - 2026-07-11

### Added

- Added the `ultra` thinking level to the agent `ThinkingLevel` type; it is only served by models that explicitly map it (currently GPT-5.6 Sol/Terra via Codex) and clamps down elsewhere.
- Added opt-in parallel tool batching to the agent loop: `shouldParallelizeToolBatch` parallelizes a tool-call batch only when every tool's execution policy allows it, and tools without a policy keep running sequentially.

### Fixed

- Fixed npm trusted-publishing identity after the GitHub repository rename by aligning package metadata with `dmae97/omk`.

## [0.90.6] - 2026-07-09

## [0.90.5] - 2026-07-07

## [0.90.4] - 2026-07-04

## [0.90.3] - 2026-07-02

## [0.90.2] - 2026-07-02

### Added

- Added the canonical reverse-skill workflow-routing harness module (`harness/reverse-skill.ts`), exported from the package root and re-exported by the coding agent.

## [0.90.1] - 2026-06-28

### Changed

- Changed runtime package metadata and lockstep release documentation to the standalone `omk-agent-core` package line used by OMK releases.

## [0.80.8] - 2026-06-27

### Breaking Changes

- Renamed the npm package from `@earendil-works/pi-agent-core` to `omk-agent-core` and updated internal OMK package dependencies.

### Changed

- Changed release metadata to lockstep OMK publishable packages at v0.80.8.
- Changed `estimateTokens` to add a per-message structural overhead and a non-zero floor for unknown-role messages, making compaction triggering more conservative.
- Changed `prepareCompaction` to skip true no-op compaction when the only oversized message would drop nothing.
- Changed `AgentHarness` failure events (`agent_end`) to include the completed turn messages before the synthetic failure message.
- Changed JSONL session storage to repair a complete-but-newline-missing tail via append instead of a full rewrite, keeping drop+rewrite only for genuinely torn tails.

### Fixed

- Fixed harness auto-compaction to trigger before provider requests when the projected prompt would exceed the configured context headroom.
- Fixed agent loop stopReason to report `"aborted"` when the loop signal is aborted instead of always `"error"`.
- Fixed `truncateLine` to be code-point-safe middle-out, preserving head and tail without splitting surrogate pairs.

## [0.78.0] - 2026-05-29

## [0.77.0] - 2026-05-28

### Breaking Changes

- Renamed agent harness `model_select` and `thinking_level_select` events to `model_update` and `thinking_level_update`.

### Added

- Added agent harness tool registry APIs, `tools_update` events, branch-scoped active-tool persistence, and duplicate tool validation.

## [0.76.0] - 2026-05-27

### Fixed

- Fixed context token estimates to count user image attachments consistently with tool result images ([#4983](https://github.com/earendil-works/pi/issues/4983)).

## [0.75.5] - 2026-05-23

## [0.75.4] - 2026-05-20

### Changed

- Changed source syntax to avoid TypeScript constructs that require JavaScript emit, keeping the package compatible with Node.js strip-only TypeScript checks.
- Removed the package-level development watch script now that the root TypeScript check validates strip-only-compatible sources.

### Fixed

- Fixed tool-call preflight to stop preparing sibling tool calls after the run is aborted ([#4276](https://github.com/earendil-works/pi/issues/4276)).
- Fixed tail truncation for oversized single-line output that ends with a trailing newline ([#4715](https://github.com/earendil-works/pi/issues/4715)).
- Fixed Windows Node execution environment command spawns to hide helper console windows from background processes ([#4699](https://github.com/earendil-works/pi/issues/4699)).

## [0.75.3] - 2026-05-18

## [0.75.2] - 2026-05-18

## [0.75.1] - 2026-05-18

## [0.75.0] - 2026-05-17

### Breaking Changes

- Raised the minimum supported Node.js version to 22.19.0.

## [0.74.1] - 2026-05-16

## [0.74.0] - 2026-05-07

## [0.73.1] - 2026-05-07

## [0.73.0] - 2026-05-04

## [0.72.1] - 2026-05-02

### Changed

- Changed the default agent transport to `auto` so providers can use their best available transport by default ([#4083](https://github.com/badlogic/pi-mono/issues/4083)).

## [0.72.0] - 2026-05-01

### Added

- Added `shouldStopAfterTurn` to the low-level agent loop config for gracefully exiting after a completed turn before polling queued messages or starting another LLM call.

## [0.71.1] - 2026-05-01

## [0.71.0] - 2026-04-30

## [0.70.6] - 2026-04-28

## [0.70.5] - 2026-04-27

## [0.70.4] - 2026-04-27

## [0.70.3] - 2026-04-27

## [0.70.2] - 2026-04-24

## [0.70.1] - 2026-04-24

## [0.70.0] - 2026-04-23

## [0.69.0] - 2026-04-22

### Breaking Changes

- Migrated public TypeBox-facing types and examples from `@sinclair/typebox` 0.34.x to `typebox` 1.x. Install and import from `typebox` instead of relying on `@sinclair/typebox` transitively ([#3112](https://github.com/badlogic/pi-mono/issues/3112))

### Added

- Added `terminate: true` tool-result hints to skip the automatic follow-up LLM call when every finalized tool result in the current batch opts into early termination ([#3525](https://github.com/badlogic/pi-mono/issues/3525))

## [0.68.1] - 2026-04-22

### Fixed

- Fixed `streamProxy()` to preserve the proxy-safe serializable subset of stream options, including session, transport, retry-delay, metadata, header, cache-retention, and thinking-budget settings ([#3512](https://github.com/badlogic/pi-mono/issues/3512))
- Fixed parallel tool execution to emit `tool_execution_end` as soon as each tool is finalized, while still emitting persisted tool-result messages in assistant source order ([#3503](https://github.com/badlogic/pi-mono/issues/3503))

## [0.68.0] - 2026-04-20

### Changed

- Clarified parallel tool execution ordering docs to specify that final tool lifecycle and tool-result artifacts are emitted in tool completion order.

## [0.67.68] - 2026-04-17

## [0.67.67] - 2026-04-17

### Fixed

- Fixed parallel tool-call finalization to convert `afterToolCall` hook throws into error tool results instead of aborting the batch ([#3084](https://github.com/badlogic/pi-mono/issues/3084))

## [0.67.6] - 2026-04-16

## [0.67.5] - 2026-04-16

## [0.67.4] - 2026-04-16

## [0.67.3] - 2026-04-15

## [0.67.2] - 2026-04-14

## [0.67.1] - 2026-04-13

## [0.67.0] - 2026-04-13

## [0.66.1] - 2026-04-08

## [0.66.0] - 2026-04-08

## [0.65.2] - 2026-04-06

## [0.65.1] - 2026-04-05

## [0.65.0] - 2026-04-03

### Breaking Changes

- `AgentState` has been reshaped:
  - `streamMessage` was renamed to `streamingMessage`
  - `error` was renamed to `errorMessage`
  - `isStreaming`, `streamingMessage`, `pendingToolCalls`, and `errorMessage` are now readonly in the public API
  - `pendingToolCalls` is now typed as `ReadonlySet<string>`
  - `tools` and `messages` are now accessor properties, and assigning either field copies the provided top-level array instead of preserving array identity
- `AgentOptions.initialState` no longer accepts runtime-owned fields. Remove `isStreaming`, `streamingMessage`, `pendingToolCalls`, and `errorMessage` from `initialState` values.
- Removed `Agent` mutator methods in favor of direct property access:
  - `agent.setSystemPrompt(value)` -> `agent.state.systemPrompt = value`
  - `agent.setModel(model)` -> `agent.state.model = model`
  - `agent.setThinkingLevel(level)` -> `agent.state.thinkingLevel = level`
  - `agent.setTools(tools)` -> `agent.state.tools = tools`
  - `agent.replaceMessages(messages)` -> `agent.state.messages = messages`
  - `agent.appendMessage(message)` -> `agent.state.messages.push(message)`
  - `agent.clearMessages()` -> `agent.state.messages = []`
  - `agent.setToolExecution(mode)` -> `agent.toolExecution = mode`
  - `agent.setBeforeToolCall(fn)` -> `agent.beforeToolCall = fn`
  - `agent.setAfterToolCall(fn)` -> `agent.afterToolCall = fn`
  - `agent.setTransport(transport)` -> `agent.transport = transport`
- Removed queue mode getter/setter methods in favor of properties:
  - `agent.setSteeringMode(mode)` -> `agent.steeringMode = mode`
  - `agent.getSteeringMode()` -> `agent.steeringMode`
  - `agent.setFollowUpMode(mode)` -> `agent.followUpMode = mode`
  - `agent.getFollowUpMode()` -> `agent.followUpMode`
- `Agent.subscribe()` listeners are now awaited and receive the active `AbortSignal`:
  - `agent.subscribe((event) => { ... })` -> `agent.subscribe(async (event, signal) => { ... })`
  - `agent_end` is now the final emitted event for a run, but not the idle boundary
  - `agent.waitForIdle()`, `agent.prompt(...)`, and `agent.continue()` now settle only after awaited `agent_end` listeners finish
  - `agent.state.isStreaming` remains `true` until that settlement completes

## [0.64.0] - 2026-03-29

### Added

- Added `AgentTool.prepareArguments` hook to prepare raw tool call arguments before schema validation, enabling compatibility shims for resumed sessions with outdated tool schemas

## [0.63.2] - 2026-03-29

### Added

- Added `Agent.signal` to expose the active abort signal for the current turn, allowing callers to forward cancellation into nested async work ([#2660](https://github.com/badlogic/pi-mono/issues/2660))

## [0.63.1] - 2026-03-27

## [0.63.0] - 2026-03-27

## [0.62.0] - 2026-03-23

## [0.61.1] - 2026-03-20

## [0.61.0] - 2026-03-20

## [0.60.0] - 2026-03-18

## [0.59.0] - 2026-03-17

## [0.58.4] - 2026-03-16

### Fixed

- Fixed steering messages to wait until the current assistant message's tool-call batch fully finishes instead of skipping pending tool calls.

## [0.58.3] - 2026-03-15

## [0.58.2] - 2026-03-15

## [0.58.1] - 2026-03-14

## [0.58.0] - 2026-03-14

### Added

- Added `beforeToolCall` and `afterToolCall` hooks to `AgentOptions` and `AgentLoopConfig` for preflight blocking and post-execution tool result mutation.

### Changed

- Added configurable tool execution mode to `Agent` and `agentLoop` via `toolExecution: "parallel" | "sequential"`, with `parallel` as the default. Parallel mode preflights tool calls sequentially, executes allowed tools concurrently, and emits final tool results in assistant source order.

## [0.57.1] - 2026-03-07

## [0.57.0] - 2026-03-07

## [0.56.3] - 2026-03-06

## [0.56.2] - 2026-03-05

## [0.56.1] - 2026-03-05

## [0.56.0] - 2026-03-04

## [0.55.4] - 2026-03-02

## [0.55.3] - 2026-02-27

## [0.55.2] - 2026-02-27

## [0.55.1] - 2026-02-26

## [0.55.0] - 2026-02-24

## [0.54.2] - 2026-02-23

## [0.54.1] - 2026-02-22

## [0.54.0] - 2026-02-19

## [0.53.1] - 2026-02-19

## [0.53.0] - 2026-02-17

## [0.52.12] - 2026-02-13

### Added

- Added `transport` to `AgentOptions` and `AgentLoopConfig` forwarding, allowing stream transport preference (`"sse"`, `"websocket"`, `"auto"`) to flow into provider calls.

## [0.52.11] - 2026-02-13

## [0.52.10] - 2026-02-12

## [0.52.9] - 2026-02-08

## [0.52.8] - 2026-02-07

## [0.52.7] - 2026-02-06

### Fixed

- Fixed `continue()` to resume queued steering/follow-up messages when context currently ends in an assistant message, and preserved one-at-a-time steering ordering during assistant-tail resumes ([#1312](https://github.com/badlogic/pi-mono/pull/1312) by [@ferologics](https://github.com/ferologics))

## [0.52.6] - 2026-02-05

## [0.52.5] - 2026-02-05

## [0.52.4] - 2026-02-05

## [0.52.3] - 2026-02-05

## [0.52.2] - 2026-02-05

## [0.52.1] - 2026-02-05

## [0.52.0] - 2026-02-05

## [0.51.6] - 2026-02-04

## [0.51.5] - 2026-02-04

## [0.51.4] - 2026-02-03

## [0.51.3] - 2026-02-03

## [0.51.2] - 2026-02-03

## [0.51.1] - 2026-02-02

## [0.51.0] - 2026-02-01

## [0.50.9] - 2026-02-01

## [0.50.8] - 2026-02-01

### Added

- Added `maxRetryDelayMs` option to `AgentOptions` to cap server-requested retry delays. Passed through to the underlying stream function. ([#1123](https://github.com/badlogic/pi-mono/issues/1123))

## [0.50.7] - 2026-01-31

## [0.50.6] - 2026-01-30

## [0.50.5] - 2026-01-30

## [0.50.3] - 2026-01-29

## [0.50.2] - 2026-01-29

## [0.50.1] - 2026-01-26

## [0.50.0] - 2026-01-26

## [0.49.3] - 2026-01-22

## [0.49.2] - 2026-01-19

## [0.49.1] - 2026-01-18

## [0.49.0] - 2026-01-17

## [0.48.0] - 2026-01-16

## [0.47.0] - 2026-01-16

## [0.46.0] - 2026-01-15

## [0.45.7] - 2026-01-13

## [0.45.6] - 2026-01-13

## [0.45.5] - 2026-01-13

## [0.45.4] - 2026-01-13

## [0.45.3] - 2026-01-13

## [0.45.2] - 2026-01-13

## [0.45.1] - 2026-01-13

## [0.45.0] - 2026-01-13

## [0.44.0] - 2026-01-12

## [0.43.0] - 2026-01-11

## [0.42.5] - 2026-01-11

## [0.42.4] - 2026-01-10

## [0.42.3] - 2026-01-10

## [0.42.2] - 2026-01-10

## [0.42.1] - 2026-01-09

## [0.42.0] - 2026-01-09

## [0.41.0] - 2026-01-09

## [0.40.1] - 2026-01-09

## [0.40.0] - 2026-01-08

## [0.39.1] - 2026-01-08

## [0.39.0] - 2026-01-08

## [0.38.0] - 2026-01-08

### Added

- `thinkingBudgets` option on `Agent` and `AgentOptions` to customize token budgets per thinking level ([#529](https://github.com/badlogic/pi-mono/pull/529) by [@melihmucuk](https://github.com/melihmucuk))

## [0.37.8] - 2026-01-07

## [0.37.7] - 2026-01-07

## [0.37.6] - 2026-01-06

## [0.37.5] - 2026-01-06

## [0.37.4] - 2026-01-06

## [0.37.3] - 2026-01-06

### Added

- `sessionId` option on `Agent` to forward session identifiers to LLM providers for session-based caching.

## [0.37.2] - 2026-01-05

## [0.37.1] - 2026-01-05

## [0.37.0] - 2026-01-05

### Fixed

- `minimal` thinking level now maps to `minimal` reasoning effort instead of being treated as `low`.

## [0.36.0] - 2026-01-05

## [0.35.0] - 2026-01-05

## [0.34.2] - 2026-01-04

## [0.34.1] - 2026-01-04

## [0.34.0] - 2026-01-04

## [0.33.0] - 2026-01-04

## [0.32.3] - 2026-01-03

## [0.32.2] - 2026-01-03

## [0.32.1] - 2026-01-03

## [0.32.0] - 2026-01-03

### Breaking Changes

- **Queue API replaced with steer/followUp**: The `queueMessage()` method has been split into two methods with different delivery semantics ([#403](https://github.com/badlogic/pi-mono/issues/403)):
  - `steer(msg)`: Interrupts the agent mid-run. Delivered after current tool execution, skips remaining tools.
  - `followUp(msg)`: Waits until the agent finishes. Delivered only when there are no more tool calls or steering messages.
- **Queue mode renamed**: `queueMode` option renamed to `steeringMode`. Added new `followUpMode` option. Both control whether messages are delivered one-at-a-time or all at once.
- **AgentLoopConfig callbacks renamed**: `getQueuedMessages` split into `getSteeringMessages` and `getFollowUpMessages`.
- **Agent methods renamed**:
  - `queueMessage()` → `steer()` and `followUp()`
  - `clearMessageQueue()` → `clearSteeringQueue()`, `clearFollowUpQueue()`, `clearAllQueues()`
  - `setQueueMode()`/`getQueueMode()` → `setSteeringMode()`/`getSteeringMode()` and `setFollowUpMode()`/`getFollowUpMode()`

### Fixed

- `prompt()` and `continue()` now throw if called while the agent is already streaming, preventing race conditions and corrupted state. Use `steer()` or `followUp()` to queue messages during streaming, or `await` the previous call.

## [0.31.1] - 2026-01-02

## [0.31.0] - 2026-01-02

### Breaking Changes

- **Transport abstraction removed**: `ProviderTransport`, `AppTransport`, and `AgentTransport` interface have been removed. Use the `streamFn` option directly for custom streaming implementations.

- **Agent options renamed**:
  - `transport` → removed (use `streamFn` instead)
  - `messageTransformer` → `convertToLlm`
  - `preprocessor` → `transformContext`

- **`AppMessage` renamed to `AgentMessage`**: All references to `AppMessage` have been renamed to `AgentMessage` for consistency.

- **`CustomMessages` renamed to `CustomAgentMessages`**: The declaration merging interface has been renamed.

- **`UserMessageWithAttachments` and `Attachment` types removed**: Attachment handling is now the responsibility of the `convertToLlm` function.

- **Agent loop moved from `@mariozechner/pi-ai`**: The `agentLoop`, `agentLoopContinue`, and related types have moved to this package. Import from `@mariozechner/pi-agent-core` instead.

### Added

- `streamFn` option on `Agent` for custom stream implementations. Default uses `streamSimple` from pi-ai.

- `streamProxy()` utility function for browser apps that need to proxy LLM calls through a backend server. Replaces the removed `AppTransport`.

- `getApiKey` option for dynamic API key resolution (useful for expiring OAuth tokens like GitHub Copilot).

- `agentLoop()` and `agentLoopContinue()` low-level functions for running the agent loop without the `Agent` class wrapper.

- New exported types: `AgentLoopConfig`, `AgentContext`, `AgentTool`, `AgentToolResult`, `AgentToolUpdateCallback`, `StreamFn`.

### Changed

- `Agent` constructor now has all options optional (empty options use defaults).

- `queueMessage()` is now synchronous (no longer returns a Promise).
