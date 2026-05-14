Manage the active goal-mode objective.

Use a single `op` field:
- `create` starts a goal. Requires `objective`; optional `token_budget` must be positive. Use only when no goal exists.
- `get` returns the current goal and remaining token budget.
- `complete` marks the goal complete after you have verified every deliverable against current evidence.

Examples:
- `goal({"op":"create","objective":"Implement feature X","token_budget":50000})`
- `goal({"op":"get"})`
- `goal({"op":"complete"})`

Do not call `complete` because a budget is low or a turn is ending. Call it only when the goal is actually done and verified.
