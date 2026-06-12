# retain

> Store durable facts through the active long-term memory backend.

## Source
- Entry: `packages/coding-agent/src/tools/memory-retain.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/retain.md`
- Hindsight collaborators:
  - `packages/coding-agent/src/hindsight/state.ts` — per-session queue, flush, auto-retain.
  - `packages/coding-agent/src/hindsight/backend.ts` — session bootstrap, prompt injection, subagent aliasing.
  - `packages/coding-agent/src/hindsight/bank.ts` — bank id derivation, tag scoping, first-use bank/mission setup.
  - `packages/coding-agent/src/hindsight/client.ts` — HTTP `retain` / `retainBatch` calls.
  - `packages/coding-agent/src/hindsight/content.ts` — retention transcript shaping, memory-tag stripping.
  - `packages/coding-agent/src/hindsight/mental-models.ts` — bank-scoped mental-model seeding and cache rendering.
  - `packages/coding-agent/src/hindsight/seeds.json` — built-in mental-model seed definitions.
  - `packages/coding-agent/src/hindsight/transcript.ts` — extracts user/assistant turns for auto-retain.
- Mnemopi collaborators:
  - `packages/coding-agent/src/mnemopi/backend.ts` — local backend bootstrap, prompt injection, subagent aliasing, enqueue/clear.
  - `packages/coding-agent/src/mnemopi/state.ts` — scoped recall/retain state and local writes.
  - `packages/coding-agent/src/mnemopi/config.ts` — local SQLite path, bank, scoping, provider settings.
  - `packages/mnemopi/src/core/memory.ts` — local memory runtime used by `remember(...)`.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `items` | `Array<{ content: string; context?: string }>` | Yes | One or more memories to store. `minItems: 1`. Each item must be self-contained; `context` is optional per-item provenance. |

## Outputs
The output depends on the active `memory.backend`.

Hindsight:
- `content[0].type = "text"`
- `content[0].text = "<count> memory queued."` or `"<count> memories queued."`
- `details = { count: number }`
- The write is not confirmed before the tool returns. The queue flushes later; flush failures emit a session warning notice and are not returned to the model.

Mnemopi:
- `content[0].type = "text"`
- `content[0].text = "<count> memory stored."` or `"<count> memories stored."`
- `details = { count: number }`
- The tool calls the local backend synchronously, but `rememberScoped(...)` catches per-item write failures and returns `undefined`; the tool still reports the requested count.

## Flow
1. `MemoryRetainTool.createIf(...)` exposes the tool when `memory.backend` is either `"hindsight"` or `"mnemopi"`.
2. `execute(...)` re-reads `memory.backend` and dispatches to the matching session state.
3. If the backend is `mnemopi`:
   - it fetches `session.getMnemopiSessionState()` and throws if the backend was not started;
   - for each item, it calls `state.rememberScoped(item.content, ...)` with `source: "coding-agent-retain"`, `importance: 0.75`, `scope: "bank"`, `extract: true`, `extractEntities: true`, `veracity: "tool"`, `memoryType: "fact"`, and metadata `{ session_id, cwd, context, tool: "retain" }`;
   - writes go to the scoped retain bank selected by `packages/coding-agent/src/mnemopi/config.ts`.
4. If the backend is `hindsight`:
   - it fetches `session.getHindsightSessionState()` and throws if the backend was not started;
   - each input item is handed to `HindsightSessionState.enqueueRetain(...)`;
   - `HindsightRetainQueue.enqueue(...)` appends the item and either flushes immediately when the queue reaches `RETAIN_FLUSH_BATCH_SIZE`, or starts a debounce timer for `RETAIN_FLUSH_INTERVAL_MS`;
   - on flush, `HindsightRetainQueue.#doFlush(...)` verifies ownership, best-effort ensures the bank exists via `ensureBankExists(...)`, maps items to `MemoryItemInput` with `context ?? config.retainContext`, `metadata.session_id`, and bank-scope tags, then sends one async `retainBatch(...)` request.

## Modes / Variants
- Hindsight tool path: queued batch write only.
- Mnemopi tool path: direct local `remember(...)` into the scoped retain bank.
- Hindsight bank scoping from `computeBankScope(...)`:
  - `global` — one shared bank, no project tags.
  - `per-project` — bank id gets `-<project label>` appended, where the label is the git primary checkout root basename (cwd basename outside a repo).
  - `per-project-tagged` — shared bank plus `project:<project label>` tags on retained memories.
- Mnemopi bank scoping from `resolveBankScope(...)`:
  - `global` — retain and recall use the shared bank.
  - `per-project` — retain and recall use the project bank.
  - `per-project-tagged` — retain writes project-local memories; recall also reads the shared bank.
- Session scope:
  - tool-called retains are per-session work for the active backend;
  - persisted Hindsight memories are cross-session server-side bank data;
  - persisted Mnemopi memories are local SQLite data;
  - subagents alias parent memory state for both supported backends.

## Side Effects
- Filesystem
  - Hindsight: none for retained memories. No local memory file is written.
  - Mnemopi: writes to local SQLite under `mnemopi.dbPath`, defaulting beneath the agent memories directory (`mnemopi/mnemopi.db`) with one database file per scoped bank when needed.
- Network
  - Hindsight: `POST /v1/default/banks/{bank_id}/memories` via `retainBatch(...)`, plus optional `PUT /v1/default/banks/{bank_id}` via `ensureBankExists(...)` before the first write per bank per session state (the set is created with the primary session state and shared with subagent aliases).
  - Mnemopi: none unless configured embedding or LLM providers make calls during extraction.
- Session state
  - Hindsight: appends to the in-memory `HindsightRetainQueue`, includes `metadata.session_id`, and shares parent state for subagents.
  - Mnemopi: writes through the session's scoped `Mnemopi` instance, includes `session_id`, `cwd`, and optional `context`, and shares scoped resources with subagents.
- User-visible prompts / interactive UI
  - Hindsight async flush failures emit `session.emitNotice("warning", ...)`; the model is not told.
  - Mnemopi write failures are logged by `rememberInScope(...)`; the tool response does not expose per-item failures.
- Background work / cancellation
  - Hindsight flush runs later on timer, queue-size threshold, `agent_end`, backend `enqueue(...)`, or backend `clear(...)`.
  - Mnemopi fact/entity extraction may continue in the Mnemopi runtime; backend `enqueue(...)` calls `flushExtractions()` before sleeping sessions.

## Limits & Caps
- Input schema requires `items.length >= 1`.
- Tool availability requires `memory.backend` to be `"hindsight"` or `"mnemopi"`; default `memory.backend` is `"off"`.
- Hindsight queue flush threshold: `RETAIN_FLUSH_BATCH_SIZE = 16`.
- Hindsight queue debounce: `RETAIN_FLUSH_INTERVAL_MS = 5_000`.
- Hindsight queue writes use `retainBatch(..., { async: true })`; the client does not wait for server-side consolidation.
- Hindsight auto-retain settings:
  - `hindsight.retainEveryNTurns` default `3`
  - `hindsight.retainOverlapTurns` default `2`
  - `hindsight.retainContext` default `"omp"`
  - `hindsight.retainMode` default `"full-session"`
- Mnemopi retain settings:
  - `mnemopi.retainEveryNTurns` default `4`
  - `mnemopi.autoRetain` controls automatic retention of completed conversation turns
  - `mnemopi.scoping` selects `global`, `per-project`, or `per-project-tagged`

## Errors
- Throws `Mnemopi backend is not initialised for this session.` when `memory.backend == "mnemopi"` but no state exists.
- Throws `Hindsight backend is not initialised for this session.` when `memory.backend == "hindsight"` but no state exists.
- Hindsight queue enqueue on disposed state throws `Hindsight retain queue is closed.`
- Hindsight flush-time API failures are caught in `HindsightRetainQueue.#doFlush(...)`, logged, and converted into a warning notice instead of a tool error.
- Hindsight bank/mission creation failures are swallowed in `ensureBankExists(...)`; writes continue.
- Mnemopi `remember(...)` failures are caught in `MnemopiSessionState.rememberInScope(...)`, logged, and not rethrown to the tool caller.

## Notes
- Hindsight storage is server-side. `hindsightBackend.clear(...)` only clears local cache/state and warns that upstream deletion must happen in Hindsight UI or `deleteBank`.
- Mnemopi storage is local SQLite. `mnemopiBackend.clear(...)` removes the scoped database files for the active configuration.
- Hindsight auto-retain uses the same bank but a different path than this tool: `retainSession(...)` extracts plain user/assistant transcript, strips `<memories>` / `<mental_models>` blocks, and calls single-item `retain(...)`.
- Mnemopi auto-retain stores prepared transcripts with `source: "coding-agent-transcript"`, `importance: 0.65`, `veracity: "unknown"`, and `memoryType: "episode"`.
- Hindsight mental-model bootstrap lives in the shared backend: `HindsightSessionState.runMentalModelLoad(...)` optionally resolves seeds, creates missing models, then caches a rendered `<mental_models>` block for prompt injection.
- Built-in Hindsight seeds are `user-preferences`, `project-conventions`, and `project-decisions`. `projectTagged: true` seeds inherit the active scope's retain tags; untagged seeds read the whole bank.
- Hindsight mental-model defaults: `hindsight.mentalModelsEnabled = true`, `hindsight.mentalModelAutoSeed = true`, `hindsight.mentalModelRefreshIntervalMs = 5 * 60 * 1000`, `hindsight.mentalModelMaxRenderChars = 16_000`. First-turn loading waits up to `MENTAL_MODEL_FIRST_TURN_DEADLINE_MS = 1500`.
- Hindsight seed lifecycle is create-only. Changing `packages/coding-agent/src/hindsight/seeds.json` does not mutate existing server-side models.
- `recall.md` and `reflect.md` rely on the same backend selection and scoping behavior.
