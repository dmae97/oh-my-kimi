Manage active goal-mode objective.

Use single `op` field:
- `create` starts goal. Requires `objective`; optional `token_budget` MUST be positive. Use only when no goal exists and no goal paused.
- `get` returns current goal (active or paused) and remaining token budget.
- `resume` re-activates paused goal so work can continue.
- `complete` marks goal complete after verified every deliverable against current evidence.
- `drop` discards current goal without completing.

Examples:
- `goal({"op":"create","objective":"Implement feature X","token_budget":50000})`
- `goal({"op":"get"})`
- `goal({"op":"resume"})`
- `goal({"op":"complete"})`
- `goal({"op":"drop"})`

NEVER call `complete` because budget low or turn ending. Call only when goal actually done and verified.
If `get` shows paused goal, call `resume` before continuing work.
