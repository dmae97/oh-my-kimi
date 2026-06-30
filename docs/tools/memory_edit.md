# memory_edit

> Update, forget, or invalidate Mnemopi long-term memories by id.

## Source
- Entry: `packages/coding-agent/src/tools/memory-edit.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/memory-edit.md`
- Backend collaborator: `packages/coding-agent/src/mnemopi/state.ts` (`editScopedMemory(...)`)

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `op` | `"update" \| "forget" \| "invalidate"` | Yes | Edit operation to apply. |
| `id` | `string` | Yes | Memory id returned by `recall`. |
| `content` | `string` | No | Replacement memory text for `update`. |
| `importance` | `number` | No | Replacement importance for `update`; clamped to `0..1`. |
| `replacement_id` | `string` | No | Superseding memory id recorded for `invalidate`. |

## Outputs
- `content[0].type = "text"`
- `content[0].text = "Memory <id> <status> in bank <bank> (<store>)."` or `"Memory <id> was not found..."`
- `details` is the backend edit result from `editScopedMemory(...)`, including status and location metadata when available.

## Flow
1. `MemoryEditTool.createIf(...)` exposes the tool only when `memory.backend == "mnemopi"`.
2. `execute(...)` fetches `session.getMnemopiSessionState()` and fails if the backend is not initialized.
3. `update` requires at least one of `content` or `importance`.
4. `importance` is clamped to `0..1` before the backend call.
5. The tool calls `state.editScopedMemory(op, id, { content, importance, replacementId })`.
6. The backend status is rendered into a short text result and returned unchanged in `details`.

## Modes / Variants
- `update` replaces memory text and/or importance in the scoped Mnemopi store.
- `forget` permanently deletes the addressed memory.
- `invalidate` softly supersedes a memory and may point at `replacement_id`.

## Side Effects
- Filesystem: mutates the local Mnemopi SQLite database for the active scoped bank.
- Network: none from the tool itself.
- Session state: reads the active session's Mnemopi state.

## Limits & Caps
- Availability requires `memory.backend = "mnemopi"`; Hindsight and local memory backends do not expose this tool.
- `id` must come from `recall`; the tool does not search by content.
- `update` with neither `content` nor `importance` is rejected before any backend write.

## Errors
- `Mnemopi backend is not initialised for this session.` when the tool is exposed but session state is missing.
- `memory_edit update requires content or importance.` for an empty update.
- Missing ids are normal results, not thrown errors; the text says the memory was not found.

## Notes
- Prefer `invalidate` for stale facts whose history may remain useful.
- Use `forget` only when content should be hard-deleted.
