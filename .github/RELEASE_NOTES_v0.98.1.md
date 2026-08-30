# OMK v0.98.1

OMK v0.98.1 hardens the reusable `omk-agent-core` harness around session ordering, structural-operation barriers, and long-context recovery. The release turns several documented-but-unwired lifecycle contracts into tested runtime behavior without raising the module-size or import-cycle baselines.

## Highlights

- **Fail-closed structural aborts** — `AgentHarness.abort()` no longer reports success while compaction, branch navigation, or retry work remains active. Those phases reject with `AgentHarnessError("invalid_state")` until they own a real cancellation and settlement barrier; ordinary turn aborts and idle queue clearing keep their previous behavior.
- **Ordered session facade** — `AgentHarness.getSession()` now returns a storage-free `HarnessSession`. Reads are detached snapshots of persisted state, turn-time extension writes enter the existing ordered pending queue, idle writes persist immediately, and structural-phase writes fail closed rather than lingering until an unrelated future turn. Non-plain, cyclic, and accessor-bearing payloads are rejected before they can enter the queue.
- **Transient summarization retry** — generated compaction and branch-summary requests can use `streamOptions.summarizationRetry`. The shared `omk-ai` classifier retries transient provider and transport failures with bounded backoff, while quota/billing failures and aborts remain terminal. Awaited lifecycle events expose scheduling, attempt start, and final outcome.
- **Projected-token auto-compaction** — `AgentHarnessOptions.compaction` controls a provider-boundary headroom check. Before each request, the harness evaluates the actual projected messages; successful compaction rebuilds that request from persisted compacted context. Disabled, unauthenticated, cancelled, and true no-op decisions leave the request unchanged.
- **One-shot context-overflow recovery** — when a provider still rejects the prompt for context overflow, the failed assistant entry remains in the append-only tree but leaves the active branch. The harness compacts and continues without appending the user's message twice. Recovery is bounded to one attempt, preserves the original overflow leaf when unavailable, and yields to a newer run started by a re-entrant `settled` listener.
- **Smaller ownership boundaries** — session errors, stream-option patching, summarization retry events, prompt constants, compaction operation options, and name validation moved into focused leaf modules. The existing cycle and module-size ratchets remain unchanged.

## Compatibility and safety

- The session facade is additive; existing `AgentHarness.appendMessage()`, configuration setters, and raw `Session` storage APIs keep their signatures.
- Automatic compaction uses the existing `DEFAULT_COMPACTION_SETTINGS` unless `AgentHarnessOptions.compaction` overrides them. It requires the harness's explicit `getApiKeyAndHeaders` callback for summarization; otherwise the provider request proceeds unchanged.
- Summarization retry is opt-in. Omitting `streamOptions.summarizationRetry` preserves single-attempt behavior.
- Overflow recovery never recurses. If the continuation overflows too, that second error is returned as the terminal result.
- A failed overflow response is retained as an orphaned evidence branch rather than deleted from append-only session storage.

## Verification

- `omk-agent-core`: 495 tests passed.
- Repository type, import-cycle, module-size, documentation, release-surface, shrinkwrap, and browser-smoke gates passed in every release-candidate commit.
- All six harness changes landed as individually revertible commits before the release bump.

See the package changelogs for the complete change list.
