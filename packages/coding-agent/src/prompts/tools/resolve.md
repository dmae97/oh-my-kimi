Resolves a pending action by either applying or discarding it.
- `action` is required:
  - `"apply"` persists / submits the pending action.
  - `"discard"` rejects the pending action.
- `reason` is required: one short complete sentence explaining why, starting with a capital letter and ending with a period.
- `extra` (optional) is free-form metadata passed to the resolving tool. Schema depends on context:

Valid whenever a pending action exists — either a preview-style staging (e.g. `ast_edit`) or a long-lived approval gate.
Call fails with an error when no pending action exists.
