Manages a phased task list through an ordered list of flat operations.
The next pending task is auto-promoted to `in_progress` after completing the current one.

<protocol>
## Shape

Pass an array of operation objects:

```ts
[
  { op: "replace", phases: [...] },
  { op: "start", task: "task-3" },
  { op: "done", phase: "Implementation" },
  { op: "rm" },
  { op: "drop", task: "task-9" },
  { op: "append", phase: "Implementation", items: [{ id: "task-10", label: "Run tests" }] }
]
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
# Initial setup
`[{op: "replace", phases: [{name: "Investigation", tasks: [{content: "Read source"}, {content: "Map callsites"}]}, {name: "Implementation", tasks: [{content: "Apply fix"}, {content: "Run tests"}]}]}]`
# Complete one task
`[{op: "done", task: "task-2"}]`
# Complete a whole phase
`[{op: "done", phase: "Implementation"}]`
# Remove all tasks
`[{op: "rm"}]`
# Drop one task
`[{op: "drop", task: "task-7"}]`
# Append tasks to a phase
`[{op: "append", phase: "Implementation", items: [{id: "task-8", label: "Handle retries"}, {id: "task-9", label: "Run tests"}]}]`
</examples>

<avoid>
- Single-step tasks — act directly
- Conversational or informational requests
- Tasks completable in under 3 trivial steps
</avoid>
