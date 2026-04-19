Manages a phased task list. Each field is a verb — set the ones you need in a single call.
The next pending task is auto-promoted to `in_progress` after completing the current one.

<protocol>
## Fields

|Field|Type|When to use|
|---|---|---|
|`phases`|Phase[]|Initial setup, or full restructure when the plan changes significantly|
|`complete`|string[]|Mark tasks done|
|`start`|string|Jump to a specific task out of order|
|`abandon`|string[]|Drop tasks intentionally|
|`remove`|string[]|Remove tasks that are no longer relevant|
|`add_notes`|{id, notes}[]|Append runtime observations to tasks|
|`add_tasks`|{phase, content, details?}[]|Add tasks to a phase (by name or ID)|
|`add_phase`|{name, tasks?}|Add a new phase of work discovered mid-task|

## Task Anatomy
- `content`: Short label (5-10 words). What is being done, not how.
- `details`: File paths, implementation steps, edge cases. Shown only when the task is active.

## Rules
- Mark tasks completed immediately after finishing — never defer
- Complete phases in order — do not skip ahead while earlier ones are pending
- On blockers: add a new task describing the blocker
</protocol>

<conditions>
Create a todo list when:
1. Task requires 3+ distinct steps
2. User explicitly requests one
3. User provides a set of tasks to complete
4. New instructions arrive mid-task — capture before proceeding
</conditions>

<example name="initial-setup">
{phases: [
  {name: "Investigation", tasks: [{content: "Read source"}, {content: "Map callsites"}]},
  {name: "Implementation", tasks: [{content: "Apply fix", details: "Update parser.ts to handle edge case in line 42"}, {content: "Run tests"}]}
]}
</example>

<example name="complete">
{complete: ["task-2", "task-3"]}
</example>

<example name="add-notes">
{add_notes: [{id: "task-3", notes: "Found edge case in parser — needs null check"}]}
</example>

<example name="add-task">
{add_tasks: [{phase: "Implementation", content: "Handle retries", details: "Cap exponential backoff in retry.ts"}]}
</example>

<example name="add-phase">
{add_phase: {name: "Cleanup", tasks: [{content: "Remove dead code"}]}}
</example>

<example name="combined">
{complete: ["task-2"], add_notes: [{id: "task-3", notes: "Needs extra validation"}]}
</example>

<avoid>
- Single-step tasks — act directly
- Conversational or informational requests
- Tasks completable in under 3 trivial steps
</avoid>
