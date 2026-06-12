**Tasks are referenced by their verbatim content string, not by any auto-generated ID. There is no "task-1"/"task-N" identifier — the tool never emits one. Pass the task's content text in the `task` field.**

Manages a phased task list. Pass `ops`: a flat array of operations.
The next pending task is auto-promoted to `in_progress` after each completion.
Allowed `op` values are only `init`, `start`, `done`, `drop`, `rm`, `append`, and `view`. `pending` is a task status, not an `op`; leave not-yet-started tasks implicit in `init`/`append` lists.

## Operations

|`op`|Required fields|Effect|
|---|---|---|
|`init`|`list: [{phase, items: string[]}]`|Initialize the full list (replaces any existing list)|
|`start`|`task`|Mark in progress|
|`done`|`task` or `phase`|Mark completed|
|`drop`|`task` or `phase`|Mark abandoned|
|`rm`|`task` or `phase` (optional)|Remove task or phase's tasks; omit both to clear the entire list|
|`append`|`phase`, `items: string[]`|Append tasks to `phase`; lazily creates phase|
|`view`|—|Read-only: echo the current list without modifying it|

## Anatomy
- **Task content**: 5–10 words, what is being done, not how. Used as the task identifier — unique.
- **Phase name**: short noun phrase (e.g. `Foundation`, `Auth`, `Verification`). Used as the phase identifier — unique. Do not add prefixes like `1.`, `A)`, `Phase 1:`, etc.

## Rules
- Mark tasks done immediately after finishing.
- Complete phases in order.
- On blockers, `append` a new task to the active phase to unblock yourself, or `drop`.
- `task` and `phase` fields reference content/name verbatim; keep them stable once introduced.
- Lost track of exact task text? `view` echoes the full list — NEVER guess content from memory; a mismatched `task` string is an error.

## When to create a list
- Task requires 3+ distinct steps
- User explicitly requests one
- User provides a set of tasks to complete
- New instructions arrive mid-task — capture before proceeding

<examples>
# Initial setup (multi-phase)
`{"ops":[{"op":"init","list":[{"phase":"Foundation","items":["Scaffold crate","Wire workspace"]},{"phase":"Auth","items":["Port credential store","Wire OAuth providers"]},{"phase":"Verification","items":["Run cargo test"]}]}]}`
# View current state (read-only)
`{"ops":[{"op":"view"}]}`
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
When the user hands you a multi-step plan — a phased todo, a numbered or bulleted checklist, or "N bugs/items/tasks" to work through:
- You MUST `init` the list with EVERY item as its own task before doing the work.
- Enumerate all of them;
- NEVER summarize the plan into fewer tasks, sample "the important ones", drop items, or rely on memory to track the rest.
The entire point is to remember every one.
</critical>
