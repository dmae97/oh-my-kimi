# retain

> Queue durable facts for asynchronous write into the active Hindsight bank.

## Source
- Entry: `packages/coding-agent/src/tools/hindsight-retain.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/retain.md`
- Key collaborators:
  - `packages/coding-agent/src/hindsight/state.ts` — per-session queue, flush, auto-retain.
  - `packages/coding-agent/src/hindsight/backend.ts` — session bootstrap, prompt injection, subagent aliasing.
  - `packages/coding-agent/src/hindsight/bank.ts` — bank id derivation, tag scoping, mission setup.
  - `packages/coding-agent/src/hindsight/client.ts` — HTTP `retain` / `retainBatch` calls.
  - `packages/coding-agent/src/hindsight/content.ts` — retention transcript shaping, memory-tag stripping.
  - `packages/coding-agent/src/hindsight/mental-models.ts` — bank-scoped mental-model seeding and cache rendering.
  - `packages/coding-agent/src/hindsight/seeds.json` — built-in mental-model seed definitions.
  - `packages/coding-agent/src/hindsight/transcript.ts` — extracts user/assistant turns for auto-retain.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `items` | `Array<{ content: string; context?: string }>` | Yes | One or more memories to queue. `minItems: 1`. Each item must be self-contained; `context` is optional per-item provenance. |

## Outputs
Returns a single-shot tool result:

- `content[0].type = "text"`
- `content[0].text = "<count> memory queued."` or `"<count> memories queued."`
- `details = { count: number }`

The write is not confirmed before the tool returns. The queue flushes later; flush failures emit a session warning notice and are not returned to the model.

## Flow
1. `HindsightRetainTool.createIf(...)` only exposes the tool when `memory.backend == "hindsight"` in `packages/coding-agent/src/tools/hindsight-retain.ts`.
2. `execute(...)` fetches `session.getHindsightSessionState()` and throws if the Hindsight backend was not started.
3. Each input item is handed to `HindsightSessionState.enqueueRetain(...)` in `packages/coding-agent/src/hindsight/state.ts`.
4. `HindsightRetainQueue.enqueue(...)` appends the item and either:
   - flushes immediately when the queue reaches `RETAIN_FLUSH_BATCH_SIZE`, or
   - starts a debounce timer for `RETAIN_FLUSH_INTERVAL_MS`.
5. On flush, `HindsightRetainQueue.#doFlush(...)`:
   - verifies the session still owns this state,
   - calls `ensureBankMission(...)` once per bank/process before writing,
   - maps queued items to `MemoryItemInput` with `context ?? config.retainContext`, `metadata.session_id`, and bank-scope tags,
   - sends one async `retainBatch(...)` request.
6. The tool returns immediately after enqueueing; it does not await the HTTP write.

## Modes / Variants
- Tool path: queued batch write only.
- Bank scoping comes from `computeBankScope(...)` in `packages/coding-agent/src/hindsight/bank.ts`:
  - `global` — one shared bank, no project tags.
  - `per-project` — bank id gets `-<cwd basename>` appended.
  - `per-project-tagged` — shared bank plus `project:<cwd basename>` tags on retained memories.
- Session scope:
  - tool-called retains are per-session queued work in `HindsightSessionState`,
  - persisted memories are cross-session server-side bank data,
  - subagents alias the parent `HindsightSessionState`, so their `retain` calls write into the same bank and queue.

## Side Effects
- Filesystem
  - None for retained memories. No local memory file is written.
- Network
  - `POST /v1/default/banks/{bank_id}/memories` via `retainBatch(...)` in `packages/coding-agent/src/hindsight/client.ts`.
  - Optional `PUT /v1/default/banks/{bank_id}` via `ensureBankMission(...)` before first write per bank/process.
- Session state (transcript, memory, jobs, checkpoints, registries)
  - Appends to the in-memory `HindsightRetainQueue` on the active `HindsightSessionState`.
  - Includes `metadata.session_id` on each retained item.
  - Shares parent state for subagents (`aliasOf` path in `packages/coding-agent/src/hindsight/backend.ts`).
- User-visible prompts / interactive UI
  - On async flush failure, emits `session.emitNotice("warning", ...)`; the model is not told.
- Background work / cancellation
  - Flush runs later on timer, queue-size threshold, `agent_end`, backend `enqueue(...)`, or backend `clear(...)`.

## Limits & Caps
- Input schema requires `items.length >= 1` in `packages/coding-agent/src/tools/hindsight-retain.ts`.
- Queue flush threshold: `RETAIN_FLUSH_BATCH_SIZE = 16` in `packages/coding-agent/src/hindsight/state.ts`.
- Queue debounce: `RETAIN_FLUSH_INTERVAL_MS = 5_000` in `packages/coding-agent/src/hindsight/state.ts`.
- Queue writes use `retainBatch(..., { async: true })`; the client does not wait for server-side consolidation.
- Shared auto-retain settings on the same backend:
  - `hindsight.retainEveryNTurns` default `3`
  - `hindsight.retainOverlapTurns` default `2`
  - `hindsight.retainContext` default `"omp"`
  - `hindsight.retainMode` default `"full-session"`
  from `packages/coding-agent/src/config/settings-schema.ts`.

## Errors
- Throws `Hindsight backend is not initialised for this session.` when no state exists.
- Queue enqueue on disposed state throws `Hindsight retain queue is closed.`
- Flush-time API failures are caught in `HindsightRetainQueue.#doFlush(...)`, logged, and converted into a warning notice instead of a tool error.
- Mission creation failures are swallowed in `ensureBankMission(...)`; writes continue.

## Notes
- Storage is server-side. `hindsightBackend.clear(...)` only clears local cache/state and warns that upstream deletion must happen in Hindsight UI or `deleteBank`; see `packages/coding-agent/src/hindsight/backend.ts`.
- Auto-retain uses the same bank but a different path than this tool: `retainSession(...)` extracts plain user/assistant transcript from `packages/coding-agent/src/hindsight/transcript.ts`, strips `<memories>` / `<mental_models>` blocks via `stripMemoryTags(...)`, and calls single-item `retain(...)`.
- `retain` itself does not seed or read mental models. Mental-model bootstrap lives in the shared backend: `HindsightSessionState.runMentalModelLoad(...)` optionally resolves seeds from `packages/coding-agent/src/hindsight/seeds.json`, creates missing models with `ensureMentalModels(...)`, then caches a rendered `<mental_models>` block for prompt injection.
- Built-in seeds are `user-preferences`, `project-conventions`, and `project-decisions`. `projectTagged: true` seeds inherit the active scope's retain tags; untagged seeds read the whole bank.
- Mental-model defaults from `packages/coding-agent/src/config/settings-schema.ts`: `hindsight.mentalModelsEnabled = true`, `hindsight.mentalModelAutoSeed = true`, `hindsight.mentalModelRefreshIntervalMs = 5 * 60 * 1000`, `hindsight.mentalModelMaxRenderChars = 16_000`. First-turn loading waits up to `MENTAL_MODEL_FIRST_TURN_DEADLINE_MS = 1500` in `packages/coding-agent/src/hindsight/mental-models.ts`.
- Seed lifecycle is create-only. Changing `packages/coding-agent/src/hindsight/seeds.json` does not mutate existing server-side models.
- `recall.md` and `reflect.md` rely on the same bank, scoping, and mental-model bootstrap; refer back here for the shared backend behavior.
