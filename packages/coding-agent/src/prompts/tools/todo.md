**Tasks referenced by verbatim content string, not auto-generated ID. No "task-1"/"task-N" identifier — tool never emits one. Pass task's content text in `task` field.**

Manages phased task list. Pass `ops`: flat array of operations.
Next pending task auto-promoted to `in_progress` after each completion.
Allowed `op` values: `init`, `start`, `done`, `drop`, `rm`, `append`, `note` only. `pending` is status, not `op`; leave not-yet-started tasks implicit in `init`/`append` lists.

## Operations

|`op`|Required fields|Effect|
|---|---|---|
|`init`|`list: [{phase, items: string[]}]`|Initialize full list (replaces existing)|
|`start`|`task`|Mark in progress|
|`done`|`task` or `phase`|Mark completed|
|`drop`|`task` or `phase`|Mark abandoned|
|`rm`|`task` or `phase`|Remove|
|`append`|`phase`, `items: string[]`|Append tasks to `phase`; lazily creates phase|
|`note`|`task`, `text`|Append note to task. Reminders for future-you only.|

## Anatomy
- **Task content**: 5–10 words, what is being done, not how. Used as task identifier — unique.
- **Phase name**: short noun phrase (e.g. `Foundation`, `Auth`, `Verification`). Phase identifier — unique. NEVER add prefixes like `1.`, `A)`, `Phase 1:`, etc.

## Rules
- Mark tasks done immediately after finishing.
- Complete phases in order.
- On blockers, `append` new task to active phase to unblock, or `drop`.
- `task` and `phase` fields reference content/name verbatim; keep stable once introduced.

## When to create a list
- Task requires 3+ distinct steps
- User explicitly requests one
- User provides set of tasks to complete
- New instructions arrive mid-task — capture before proceeding

<examples>
# Initial setup (multi-phase)
`{"ops":[{"op":"init","list":[{"phase":"Foundation","items":["Scaffold crate","Wire workspace"]},{"phase":"Auth","items":["Port credential store","Wire OAuth providers"]},{"phase":"Verification","items":["Run cargo test"]}]}]}`
# Initial setup (single phase)
`{"ops":[{"op":"init","list":[{"phase":"Implementation","items":["Apply fix","Run tests"]}]}]}`
# Complete one task
`{"ops":[{"op":"done","task":"Wire workspace"}]}`
# Complete a whole phase
`{"ops":[{"op":"done","phase":"Auth"}]}`
# Remove all tasks
`{"ops":[{"op":"rm"}]}`
# Drop one task
`{"ops":[{"op":"drop","task":"Run cargo test"}]}`
# Append tasks to a phase
`{"ops":[{"op":"append","phase":"Auth","items":["Handle retries","Run tests"]}]}`
</examples>

<critical>
When user hands multi-step plan — phased todo, numbered or bulleted checklist, or "N bugs/items/tasks" to work through:
- MUST `init` list with EVERY item as own task before doing work.
- Enumerate all;
- NEVER summarize plan into fewer tasks, sample "important ones", drop items, or rely on memory to track rest.
Entire point is remember every one.
</critical>
