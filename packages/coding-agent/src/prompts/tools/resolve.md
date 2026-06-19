Resolves a pending action — apply or discard. Valid only when a pending action exists; errors otherwise.
- `action` (required): `"apply"` persists/submits; `"discard"` rejects.
- `reason` (required): one short sentence explaining why.
- `extra` (optional): free-form metadata. Plan-approval gate? Supply `extra.title` (kebab/PascalCase slug = approved plan filename). Unused for preview actions (e.g. `ast_edit`).
