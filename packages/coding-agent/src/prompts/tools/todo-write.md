Manages a phased task list through an `ops` array of flat operations.
The next pending task is auto-promoted to `in_progress` after completing the current one.

<protocol>
## Shape

Pass an object with an `ops` array:

```ts
{
  ops: [
    { op: "replace", phases: [...] },
    { op: "start", task: "task-3" },
    { op: "done", phase: "Implementation" },
    { op: "rm" },
    { op: "drop", task: "task-9" },
    { op: "append", phase: "Implementation", items: [{ id: "task-10", label: "Run tests" }] },
  ],
}
```

## Operation fields

|Field|Type|When to use|
|---|---|---|
|`op`|string|Required. One of `replace`, `start`, `done`, `rm`, `drop`, `append`|
|`task`|string|Task id for `start`, or a task target for `done` / `rm` / `drop`|
|`phase`|string|Phase target for `done` / `rm` / `drop`, or append destination for `append`|
|`items`|{id, label}[]|Required for `append`. If the phase does not exist, it is created at the end|
|`phases`|Phase[]|Only for `replace`. Keeps initial phased setup available for harness bootstrap and full restructures|

## Semantics
- `start`: requires `task`; sets that task to `in_progress`
- `done`: marks one task, one phase, or all tasks completed
- `rm`: removes one task, one phase's tasks, or all tasks
- `drop`: marks one task, one phase, or all tasks abandoned
- `append`: appends `items` to `phase`; creates the phase if missing
- `replace`: replaces the full todo list

If `done`, `rm`, or `drop` omits both `task` and `phase`, it applies to all tasks.

## Task Anatomy
- `label`: Short label (5-10 words). What is being done, not how.
- `replace` task `content` should stay short and specific.

## Phase Anatomy
- `name`: Short, human-readable noun phrase (1-3 words). Capitalize naturally.
- Always prefix with a roman-numeral ordinal (`I.`, `II.`, `III.`, `IV.`, ...) to convey ordering — e.g. `I. Foundation`, `II. Auth`, `III. Routing`. Single-phase plans use `I.` too.
- You **MUST NOT** use snake_case, `Phase1_*`, arabic numerals (`1.`), or letter prefixes (`A.`) — they render as ugly identifiers.

## Rules
- Mark tasks done immediately after finishing — never defer.
- Complete phases in order — do not skip ahead while earlier ones are pending.
- On blockers, append a new task to the active phase.
- Keep ids stable once introduced.
</protocol>

<conditions>
Create a todo list when:
1. Task requires 3+ distinct steps
2. User explicitly requests one
3. User provides a set of tasks to complete
4. New instructions arrive mid-task — capture before proceeding
</conditions>

<examples>
# Initial setup (multi-phase)
`{"ops":[{"op":"replace","phases":[{"name":"I. Foundation","tasks":[{"content":"Scaffold crate"},{"content":"Wire workspace"}]},{"name":"II. Auth","tasks":[{"content":"Port credential store"},{"content":"Wire OAuth providers"}]},{"name":"III. Verification","tasks":[{"content":"Run cargo test"}]}]}]}`
# Initial setup (single phase " still prefixed)
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

<avoid>
- Single-step tasks — act directly
- Conversational or informational requests
- Tasks completable in under 3 trivial steps
</avoid>
