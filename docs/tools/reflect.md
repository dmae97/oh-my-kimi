# reflect

> Ask the Hindsight server to synthesize an answer over the active memory bank.

## Source
- Entry: `packages/coding-agent/src/tools/hindsight-reflect.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/reflect.md`
- Key collaborators:
  - `packages/coding-agent/src/hindsight/bank.ts` — best-effort bank mission initialization.
  - `packages/coding-agent/src/hindsight/state.ts` — session state, shared bank scope, recall/reflect config.
  - `packages/coding-agent/src/hindsight/client.ts` — HTTP `reflect` call and error mapping.
  - `docs/tools/retain.md` — shared backend, storage, seeding, and mental-model bootstrap.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `query` | `string` | Yes | Question to answer from long-term memory. |
| `context` | `string` | No | Extra guidance sent to the Hindsight reflect endpoint. |

## Outputs
Returns a single-shot tool result:

- `content[0].type = "text"`
- `content[0].text = response.text?.trim() || "No relevant information found to reflect on."`
- `details = {}`

The tool returns the Hindsight server's synthesized text directly; it does not expose raw recall hits.

## Flow
1. `HindsightReflectTool.createIf(...)` only exposes the tool when `memory.backend == "hindsight"`.
2. `execute(...)` runs under `untilAborted(...)`.
3. It reads the active `HindsightSessionState`; missing state throws `Hindsight backend is not initialised for this session.`
4. Before reflecting, it calls `ensureBankMission(...)` with the current `bankId`, config, and process-local `missionsSet`.
5. `ensureBankMission(...)` best-effort `PUT`s `/v1/default/banks/{bank_id}` with `reflect_mission` and optional `retain_mission` exactly once per bank/process; failures are swallowed.
6. It calls `state.client.reflect(...)` with the model `query`, optional `context`, configured recall budget, and bank-scope tag filters.
7. `HindsightApi.reflect(...)` POSTs `/v1/default/banks/{bank_id}/reflect` and defaults its own budget to `"low"` when callers omit one; this tool always passes the configured budget.
8. Blank or whitespace-only responses are replaced with `No relevant information found to reflect on.`
9. Failures are logged with `logger.warn("reflect failed", ...)` and rethrown.

## Modes / Variants
- Tool path: one reflect request, optionally focused by `context`.
- Bank scoping is inherited from the active `HindsightSessionState`:
  - `global` — no tag filter.
  - `per-project` — separate bank id per cwd basename.
  - `per-project-tagged` — shared bank id plus `project:<cwd basename>` filter with `tagsMatch = "any"`.
- Session scope: reads cross-session server-side memories, but does not persist local output.

## Side Effects
- Network
  - Optional `PUT /v1/default/banks/{bank_id}` from `ensureBankMission(...)`.
  - `POST /v1/default/banks/{bank_id}/reflect` via `packages/coding-agent/src/hindsight/client.ts`.
- Session state (transcript, memory, jobs, checkpoints, registries)
  - Reads session-held bank scope and config only. Does not update `lastRecallSnippet`, the mental-model cache, or the retain queue.
- Background work / cancellation
  - Aborts through `untilAborted(...)` if the tool call signal is cancelled.

## Limits & Caps
- Tool-level params: only `query` is required; `context` is optional.
- Default budget setting comes from `hindsight.recallBudget` in `packages/coding-agent/src/config/settings-schema.ts`; default `"mid"`.
- `reflect` itself has no client-side token cap parameter here; unlike `recall`, the tool does not pass `maxTokens`.
- Mission initialization tracks up to `MISSION_SET_CAP = 10_000` bank ids in `packages/coding-agent/src/hindsight/bank.ts`, then drops the oldest half of the sorted set.

## Errors
- Throws `Hindsight backend is not initialised for this session.` when no state exists.
- HTTP and fetch failures become `HindsightError` from `packages/coding-agent/src/hindsight/client.ts` with `statusCode` and parsed `details` when available.
- `ensureBankMission(...)` failures are silent to the tool caller; only the later reflect request can fail visibly.
- Non-`Error` failures are normalized to `new Error(String(err))` before rethrow.

## Notes
- Shared backend details are in `docs/tools/retain.md`: server-side storage, subagent aliasing, bank scoping, seed mental models from `packages/coding-agent/src/hindsight/seeds.json`, and mental-model prompt injection.
- `reflect` does not read the cached `<mental_models>` block directly. It queries the Hindsight server over the bank contents. The same session may also have separate mental-model context injected into its developer instructions.
- Reflect mission and retain mission are bank-level server settings, not per-request payload. The tool just ensures they are present best-effort before reflecting.
