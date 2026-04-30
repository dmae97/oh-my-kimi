<system-reminder>
Before doing substantive work on the upcoming user request, create a comprehensive phased todo first.

You **MUST** call `todo_write` first in this turn.
You **MUST** initialize the todo list with a single `init` op.
You **MUST** cover the entire request from investigation through implementation and verification — not just the next immediate step.
You **MUST** make task descriptions specific enough that a future turn can execute them without re-planning.
You **MUST** keep task `content` to a short label (5-10 words). Put file paths, implementation steps, and specifics in `details`.
You **MUST** keep exactly one task `in_progress` and all later tasks `pending`.

After the initial `todo_write` call succeeds, continue with the user's request in the same turn.
Do not emit another `todo_write` call unless task state materially changed.
</system-reminder>
