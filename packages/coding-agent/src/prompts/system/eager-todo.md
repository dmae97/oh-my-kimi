<system-reminder>
Before substantive work, create phased todo.

MUST call `todo` first in this turn.
MUST initialize todo list with single `init` op.
MUST cover entire request — investigation through implementation and verification, not just next step.
Task descriptions MUST be specific. Future turn MUST execute without re-planning.
MUST keep task `content` short label 5-10 words. Put file paths, implementation steps, specifics in `details`.
MUST keep exactly one task `in_progress` and all later tasks `pending`.

After `todo` succeeds, continue request same turn.
Do not call `todo` again unless task state materially changed.
</system-reminder>
