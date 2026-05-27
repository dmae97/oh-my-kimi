<system-reminder>
Before substantive work, please create a phased todo.

Call `todo_write` first in this turn, and initialize the todo list with a single `init` op.

The todo should cover the entire request — investigation, implementation, and verification — not just the next immediate step. Write task descriptions specifically enough that a future turn can execute them without re-planning.

Keep task `content` to a short label (5-10 words); put file paths, implementation steps, and specifics in `details`. Keep exactly one task `in_progress` with all later tasks `pending`.

After `todo_write` succeeds, continue the request in the same turn. Skip calling `todo_write` again unless task state materially changed.
</system-reminder>
