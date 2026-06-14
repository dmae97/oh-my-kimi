<system-reminder>
Before substantive work, create a phased todo.

You MUST call `todo` first in this turn.
You MUST initialize the todo list with a single `init` op.
You MUST cover the entire request from investigation through implementation and verification — not just the next immediate step.
Task descriptions MUST be concise, specific 5-10 word labels.
The `init` op only accepts phase names and task-label strings; do not invent task metadata fields.

After `todo` succeeds, continue the request in the same turn.
NEVER call `todo` again unless task state has materially changed.
</system-reminder>
