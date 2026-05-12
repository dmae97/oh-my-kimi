# recall

> Search the active Hindsight bank and return raw matching memories.

## Source
- Entry: `packages/coding-agent/src/tools/hindsight-recall.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/recall.md`
- Key collaborators:
  - `packages/coding-agent/src/hindsight/state.ts` — session state, recall query defaults, prompt-side auto-recall.
  - `packages/coding-agent/src/hindsight/content.ts` — result formatting and UTC timestamp formatting.
  - `packages/coding-agent/src/hindsight/client.ts` — HTTP `recall` call and error mapping.
  - `packages/coding-agent/src/hindsight/bank.ts` — bank id and tag-filter scoping.
  - `docs/tools/retain.md` — shared backend, storage, seeding, and mental-model bootstrap.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `query` | `string` | Yes | Natural-language search query. The tool passes it through unchanged. |

## Outputs
Returns a single-shot tool result.

When matches exist:
- `content[0].type = "text"`
- `content[0].text = "Found <n> relevant memories (as of YYYY-MM-DD HH:MM UTC):\n\n<bullet list>"`
- each bullet is `- <text> [<type>] (<mentioned_at>)`; the type and timestamp suffixes appear only when those fields are present
- `details = {}`

When no matches exist:
- `content[0].text = "No relevant memories found."`
- `details = {}`

## Flow
1. `HindsightRecallTool.createIf(...)` only exposes the tool when `memory.backend == "hindsight"`.
2. `execute(...)` wraps the whole operation in `untilAborted(...)` from `@oh-my-pi/pi-utils`.
3. It reads the active `HindsightSessionState`; missing state throws `Hindsight backend is not initialised for this session.`
4. It calls `state.client.recall(...)` with:
   - `bankId` from session bootstrap,
   - the model-supplied `query`,
   - `budget`, `maxTokens`, and `types` from `HindsightConfig`,
   - tag filters from the bank scope (`recallTags`, `recallTagsMatch`).
5. `HindsightApi.recall(...)` POSTs `/v1/default/banks/{bank_id}/memories/recall`.
6. Results are formatted into a plain-text list with `formatMemories(...)`; empty results map to the fixed no-match string.
7. Failures are logged with `logger.warn("recall failed", ...)` and rethrown.

## Modes / Variants
- Tool path: explicit query-only recall. The tool does not compose context from recent turns; that richer path is reserved for backend auto-recall in `HindsightSessionState.beforeAgentStartPrompt(...)` / `maybeRecallOnAgentStart(...)`.
- Bank scoping is inherited from the active `HindsightSessionState`:
  - `global` — no tag filter.
  - `per-project` — separate bank id per cwd basename.
  - `per-project-tagged` — shared bank id plus `project:<cwd basename>` filter with `tagsMatch = "any"`, so project-tagged and untagged global memories can both surface.
- Session scope: reads cross-session server-side memories, but uses per-session cached config and scope.

## Side Effects
- Network
  - `POST /v1/default/banks/{bank_id}/memories/recall` via `packages/coding-agent/src/hindsight/client.ts`.
- Session state (transcript, memory, jobs, checkpoints, registries)
  - None on success. Unlike backend auto-recall, this tool does not update `lastRecallSnippet` or refresh the system prompt.
- Background work / cancellation
  - Aborts through `untilAborted(...)` if the tool call signal is cancelled.

## Limits & Caps
- Client default budget for raw `HindsightApi.recall(...)` is `"mid"`; this tool overrides from config in `packages/coding-agent/src/hindsight/state.ts`.
- Default recall settings from `packages/coding-agent/src/config/settings-schema.ts`:
  - `hindsight.recallBudget = "mid"`
  - `hindsight.recallMaxTokens = 1024`
  - `hindsight.recallTypes = ["world", "experience"]`
- The explicit tool path does not apply `hindsight.recallContextTurns` or `hindsight.recallMaxQueryChars`; those caps only affect backend auto-recall query composition.

## Errors
- Throws `Hindsight backend is not initialised for this session.` when no state exists.
- HTTP and fetch failures become `HindsightError` from `packages/coding-agent/src/hindsight/client.ts` with `statusCode` and parsed `details` when available.
- Non-`Error` failures are normalized to `new Error(String(err))` before rethrow.

## Notes
- Shared backend details are in `docs/tools/retain.md`: server-side storage, subagent aliasing, bank scoping, mission setup, and mental-model bootstrap.
- Mental models are not fetched by this tool. They may still already be present in the agent's developer instructions because the backend caches a `<mental_models>` block separately from recall results.
- The tool returns raw memory hits; it does not synthesize across them. Use `reflect` for that path.
