# recall

> Search the active long-term memory backend and return matching memories.

## Source
- Entry: `packages/coding-agent/src/tools/memory-recall.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/recall.md`
- Hindsight collaborators:
  - `packages/coding-agent/src/hindsight/state.ts` — session state, recall query defaults, prompt-side auto-recall.
  - `packages/coding-agent/src/hindsight/content.ts` — result formatting and UTC timestamp formatting.
  - `packages/coding-agent/src/hindsight/client.ts` — HTTP `recall` call and error mapping.
  - `packages/coding-agent/src/hindsight/bank.ts` — bank id and tag-filter scoping.
- Mnemopi collaborators:
  - `packages/coding-agent/src/mnemopi/state.ts` — scoped local recall and result formatting with ids.
  - `packages/coding-agent/src/mnemopi/config.ts` — local bank scoping and recall limits.
  - `docs/tools/retain.md` — shared backend, storage, scoping, and retention behavior.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `query` | `string` | Yes | Natural-language search query. The tool passes it through unchanged except Mnemopi `per-project-tagged` may run an internal shared-bank fallback query. |

## Outputs
Returns a single-shot tool result.

When matches exist:
- `content[0].type = "text"`
- `content[0].text = "Found <n> relevant memory/memories (as of YYYY-MM-DD HH:MM UTC):\n\n<bullet list>"`
- `details = {}`

Hindsight bullet format comes from `formatMemories(...)`:
- each bullet is `- <text> [<type>] (<mentioned_at>)`; the type and timestamp suffixes appear only when those fields are present.

Mnemopi bullet format comes from `formatScopedRecallWithIds(...)`:
- each bullet is `- <content> (id: <id>|id unavailable) [<source>] (<YYYY-MM-DD>) c:<score>`; optional source, date, and score suffixes appear only when present.

When no matches exist:
- `content[0].text = "No relevant memories found."`
- `details = {}`

## Flow
1. `MemoryRecallTool.createIf(...)` exposes the tool when `memory.backend` is either `"hindsight"` or `"mnemopi"`.
2. `execute(...)` wraps the operation in `untilAborted(...)`.
3. If the backend is `mnemopi`:
   - it reads `session.getMnemopiSessionState()` and throws if the backend was not started;
   - it calls `state.recallResultsScoped(params.query)`;
   - scoped recall queries each configured recall bank with `recallEnhanced(query, recallLimit, { includeFacts: true, channelId: bank })`, merges/deduplicates results by id/content, sorts them, and truncates to `recallLimit`;
   - in `per-project-tagged`, the shared bank may receive one extra fallback query with project-bank literal tokens stripped so broad global memories still match;
   - results are formatted with ids for later `memory_edit` use.
4. If the backend is `hindsight`:
   - it reads `session.getHindsightSessionState()` and throws if the backend was not started;
   - it calls `state.client.recall(...)` with `bankId`, query, configured `budget`, `maxTokens`, `types`, and bank-scope tag filters;
   - `HindsightApi.recall(...)` POSTs `/v1/default/banks/{bank_id}/memories/recall`;
   - results are formatted into a plain-text list with `formatMemories(...)`.
5. Backend failures are logged with `logger.warn("recall failed", ...)` and rethrown as `Error` instances when needed.

## Modes / Variants
- Tool path: explicit query-only recall. It does not compose context from recent turns.
- Backend auto-recall has a richer query-composition path in `HindsightSessionState.beforeAgentStartPrompt(...)` / `maybeRecallOnAgentStart(...)` and `MnemopiSessionState.beforeAgentStartPrompt(...)` / `maybeRecallOnAgentStart(...)`.
- Hindsight bank scoping:
  - `global` — no tag filter.
  - `per-project` — separate bank id per cwd basename.
  - `per-project-tagged` — shared bank id plus `project:<cwd basename>` filter with `tagsMatch = "any"`, so project-tagged and untagged global memories can both surface.
- Mnemopi bank scoping:
  - `global` — recall reads the shared bank.
  - `per-project` — recall reads the project bank.
  - `per-project-tagged` — recall reads the project bank and shared bank, then merges results.
- Session scope: reads cross-session memory data, using the active session's cached config and scope.

## Side Effects
- Network
  - Hindsight: `POST /v1/default/banks/{bank_id}/memories/recall`.
  - Mnemopi: none unless configured local runtime providers perform embedding/LLM work during recall.
- Session state
  - None on success for the explicit tool path. Unlike backend auto-recall, this tool does not update `lastRecallSnippet` or refresh the system prompt.
- Background work / cancellation
  - Aborts through `untilAborted(...)` if the tool call signal is cancelled.

## Limits & Caps
- Tool availability requires `memory.backend` to be `"hindsight"` or `"mnemopi"`; default `memory.backend` is `"off"`.
- Hindsight client default budget for raw `HindsightApi.recall(...)` is `"mid"`; this tool overrides from config.
- Hindsight recall settings:
  - `hindsight.recallBudget = "mid"`
  - `hindsight.recallMaxTokens = 1024`
  - `hindsight.recallTypes = ["world", "experience"]`
- Mnemopi recall settings:
  - `mnemopi.recallLimit = 8`
  - `mnemopi.scoping` selects which local bank(s) are searched
- The explicit tool path does not apply `hindsight.recallContextTurns`, `hindsight.recallMaxQueryChars`, `mnemopi.recallContextTurns`, or `mnemopi.recallMaxQueryChars`; those caps only affect backend auto-recall query composition.

## Errors
- Throws `Mnemopi backend is not initialised for this session.` when `memory.backend == "mnemopi"` but no state exists.
- Throws `Hindsight backend is not initialised for this session.` when `memory.backend == "hindsight"` but no state exists.
- Hindsight HTTP and fetch failures become `HindsightError` with `statusCode` and parsed `details` when available.
- Mnemopi recall target failures inside `collectScopedRecallResults(...)` are caught per bank and logged only when `mnemopi.debug` is enabled; if all targets fail, the tool can return `No relevant memories found.`
- Non-`Error` failures caught by the tool are normalized to `new Error(String(err))` before rethrow.

## Notes
- Shared backend details are in `docs/tools/retain.md`: storage, subagent aliasing, bank scoping, mission setup, and mental-model behavior.
- Hindsight mental models are not fetched by this tool. They may already be present in the agent's developer instructions because the backend caches a `<mental_models>` block separately from recall results.
- Mnemopi developer instructions may include a `<memories>` block from auto-recall; this explicit tool does not update that block.
- The tool returns memory hits; it does not synthesize across them. Use `reflect` for that path.
