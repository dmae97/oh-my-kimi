Manages a phased task list. Pass `ops`: a flat array of operations.
The next pending task is auto-promoted to `in_progress` after each completion.

## Operations

|`op`|Required fields|Effect|
|---|---|---|
|`replace`|`phases`|Replace the full list (initial setup, full restructure)|
|`start`|`task`|Set task to `in_progress`|
|`done`|`task` or `phase` (or neither = all)|Mark completed|
|`drop`|`task` or `phase` (or neither = all)|Mark abandoned|
|`rm`|`task` or `phase` (or neither = all)|Remove|
|`append`|`phase`, `items: {id, label}[]`|Append tasks; creates phase if missing|
|`note`|`task`, `text`|Append a note to `task.notes`. Only use to leave reminders for future-you.|

## Anatomy
- **Task `label`**: 5–10 words, what is being done, not how.
- **Phase `name`**: short noun phrase prefixed with a roman numeral — `I. Foundation`, `II. Auth`, `III. Verification`. Single-phase plans still use `I.`. Never use snake_case, arabic numerals, or letter prefixes.

## Rules
- Mark tasks done immediately after finishing — never defer.
- Complete phases in order.
- On blockers, `append` a new task to the active phase.
- Keep ids stable once introduced.

## When to create a list
- Task requires 3+ distinct steps
- User explicitly requests one
- User provides a set of tasks to complete
- New instructions arrive mid-task — capture before proceeding

<examples>
# Initial setup (multi-phase)
`{"ops":[{"op":"replace","phases":[{"name":"I. Foundation","tasks":[{"content":"Scaffold crate"},{"content":"Wire workspace"}]},{"name":"II. Auth","tasks":[{"content":"Port credential store"},{"content":"Wire OAuth providers"}]},{"name":"III. Verification","tasks":[{"content":"Run cargo test"}]}]}]}`
# Initial setup (single phase — still prefixed)
`{"ops":[{"op":"replace","phases":[{"name":"I. Implementation","tasks":[{"content":"Apply fix"},{"content":"Run tests"}]}]}]}`
# Complete one task
`{"ops":[{"op":"done","task":"task-2"}]}`
# Complete a whole phase
`{"ops":[{"op":"done","phase":"II. Auth"}]}`
# Remove all tasks
`{"ops":[{"op":"rm"}]}`
# Drop one task
`{"ops":[{"op":"drop","task":"task-7"}]}`
# Append tasks to a phase
`{"ops":[{"op":"append","phase":"II. Auth","items":[{"id":"task-8","label":"Handle retries"},{"id":"task-9","label":"Run tests"}]}]}`
</examples>
