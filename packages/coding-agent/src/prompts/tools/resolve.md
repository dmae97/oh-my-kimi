Resolves a pending preview action by either applying or discarding it.
- `action` is required:
  - `"apply"` persists the pending changes.
  - `"discard"` rejects the pending changes.
- `reason` is required and must explain why you chose to apply or discard.

Only valid when a pending action exists (typically after a preview step).
Call fails with an error when no pending action exists.
