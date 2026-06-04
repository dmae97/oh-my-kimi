Resolves pending action by applying or discarding.
- `action` is required:
  - `"apply"` persists / submits pending action.
  - `"discard"` rejects pending action.
- `reason` REQUIRED: one short complete sentence explaining why, starting capital letter ending period.
- `extra` optional free-form metadata passed to resolving tool. When pending action is plan-approval gate, supply `extra.title` (kebab/PascalCase slug for approved plan filename). For preview-style pending actions (e.g. `ast_edit`), `extra` unused.

Valid whenever pending action exists — either preview-style staging (e.g. `ast_edit`) or long-lived approval gate.
Call fails when no pending action exists.
