Resolves a pending action by either applying or discarding it.
- `action` is required:
  - `"apply"` persists / submits the pending action.
  - `"discard"` rejects the pending action.
- `reason` is required: one short complete sentence explaining why, starting with a capital letter and ending with a period.
- `extra` (optional) is free-form metadata passed to the resolving tool. When the pending action is a plan-approval gate, supply `extra.title` (kebab/PascalCase slug for the approved plan filename). For preview-style pending actions (e.g. `ast_edit`), `extra` is unused.

Valid whenever a pending action exists — either a preview-style staging (e.g. `ast_edit`) or a long-lived approval gate.
Call fails with an error when no pending action exists.
