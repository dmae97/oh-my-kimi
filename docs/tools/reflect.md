# reflect

> Synthesize an answer over the active long-term memory backend.

## Source
- Entry: `packages/coding-agent/src/tools/memory-reflect.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/reflect.md`
- Hindsight collaborators:
  - `packages/coding-agent/src/hindsight/bank.ts` — best-effort bank mission initialization.
  - `packages/coding-agent/src/hindsight/state.ts` — session state, shared bank scope, recall/reflect config.
  - `packages/coding-agent/src/hindsight/client.ts` — HTTP `reflect` call and error mapping.
- Mnemopi collaborators:
  - `packages/coding-agent/src/mnemopi/state.ts` — scoped local recall and context formatting.
  - `docs/tools/retain.md` — shared backend, storage, scoping, and mental-model behavior.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `query` | `string` | Yes | Question to answer from long-term memory. |
| `context` | `string` | No | Extra guidance. Hindsight sends it as `context`; Mnemopi appends trimmed context to the recall query under `Additional context:`. |

## Outputs
Returns a single-shot tool result.

Hindsight:
- `content[0].type = "text"`
- `content[0].text = response.text?.trim() || "No relevant information found to reflect on."`
- `details = {}`
- The tool returns the Hindsight server's synthesized text directly; it does not expose raw recall hits.

Mnemopi:
- if no scoped recall results exist: `content[0].text = "No relevant information found to reflect on."`
- otherwise: `content[0].text = "Based on recalled memories:\n\n<formatted context>"`
- `details = {}`
- The local path performs recall plus formatting; it does not call a separate synthesis endpoint.

## Flow
1. `MemoryReflectTool.createIf(...)` exposes the tool when `memory.backend` is either `"hindsight"` or `"mnemopi"`.
2. `execute(...)` runs under `untilAborted(...)`.
3. If the backend is `mnemopi`:
   - it reads `session.getMnemopiSessionState()` and throws if the backend was not started;
   - if `context` has non-whitespace content, it recalls with `<query>\n\nAdditional context:\n<context>`; otherwise it recalls with `query`;
   - it calls `state.recallResultsScoped(...)` using the same local scoping and merge behavior as `recall`;
   - if results exist, it renders them through `state.formatContextScoped(...)` and prefixes `Based on recalled memories:`.
4. If the backend is `hindsight`:
   - it reads `session.getHindsightSessionState()` and throws if the backend was not started;
   - it calls `ensureBankMission(...)` with the current `bankId`, config, and process-local `missionsSet`;
   - `ensureBankMission(...)` best-effort `PUT`s `/v1/default/banks/{bank_id}` with `reflect_mission` and optional `retain_mission` exactly once per bank/process; failures are swallowed;
   - it calls `state.client.reflect(...)` with `query`, optional `context`, configured recall budget, and bank-scope tag filters;
   - `HindsightApi.reflect(...)` POSTs `/v1/default/banks/{bank_id}/reflect` and defaults its own budget to `"low"` when callers omit one; this tool always passes the configured budget;
   - blank or whitespace-only responses are replaced with `No relevant information found to reflect on.`
5. Backend failures are logged with `logger.warn("reflect failed", ...)` and rethrown as `Error` instances when needed.

## Modes / Variants
- Hindsight tool path: one remote reflect request, optionally focused by `context`.
- Mnemopi tool path: one local scoped recall followed by context formatting.
- Hindsight bank scoping:
  - `global` — no tag filter.
  - `per-project` — separate bank id per cwd basename.
  - `per-project-tagged` — shared bank id plus `project:<cwd basename>` filter with `tagsMatch = "any"`.
- Mnemopi bank scoping:
  - `global` — reads the shared bank.
  - `per-project` — reads the project bank.
  - `per-project-tagged` — reads the project bank and shared bank, then merges results.
- Session scope: reads cross-session memory data, but does not persist local output.

## Side Effects
- Network
  - Hindsight: optional `PUT /v1/default/banks/{bank_id}` from `ensureBankMission(...)`, then `POST /v1/default/banks/{bank_id}/reflect`.
  - Mnemopi: none unless configured embedding or LLM providers are used by the local runtime during recall.
- Session state
  - Reads session-held backend scope and config only. Does not update `lastRecallSnippet`, Hindsight mental-model cache, or retain queues.
- Background work / cancellation
  - Aborts through `untilAborted(...)` if the tool call signal is cancelled.

## Limits & Caps
- Tool availability requires `memory.backend` to be `"hindsight"` or `"mnemopi"`; default `memory.backend` is `"off"`.
- Tool-level params: only `query` is required; `context` is optional.
- Hindsight budget setting comes from `hindsight.recallBudget`, default `"mid"`.
- Hindsight `reflect` has no client-side token cap parameter here; unlike `recall`, the tool does not pass `maxTokens`.
- Hindsight mission initialization tracks up to `MISSION_SET_CAP = 10_000` bank ids, then drops the oldest half of the sorted set.
- Mnemopi result count is capped by `mnemopi.recallLimit`, default `8`.

## Errors
- Throws `Mnemopi backend is not initialised for this session.` when `memory.backend == "mnemopi"` but no state exists.
- Throws `Hindsight backend is not initialised for this session.` when `memory.backend == "hindsight"` but no state exists.
- Hindsight HTTP and fetch failures become `HindsightError` with `statusCode` and parsed `details` when available.
- Hindsight `ensureBankMission(...)` failures are silent to the tool caller; only the later reflect request can fail visibly.
- Mnemopi recall target failures inside `collectScopedRecallResults(...)` are caught per bank and logged only when `mnemopi.debug` is enabled; if all targets fail, the tool can return the no-information text.
- Non-`Error` failures caught by the tool are normalized to `new Error(String(err))` before rethrow.

## Notes
- Shared backend details are in `docs/tools/retain.md`: storage, subagent aliasing, bank scoping, seed mental models, and prompt injection.
- Hindsight `reflect` does not read the cached `<mental_models>` block directly. It queries the Hindsight server over the bank contents. The same session may also have separate mental-model context injected into its developer instructions.
- Hindsight reflect mission and retain mission are bank-level server settings, not per-request payload. The tool just ensures they are present best-effort before reflecting.
- Mnemopi `reflect` is local recall plus formatting, so its output shape differs from Hindsight's remote synthesized answer.
