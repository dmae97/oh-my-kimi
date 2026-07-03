Edit Mnemopi long-term memories by id.

Use only with ids returned by the `recall` tool. Operations:
- `update`: replace content and/or importance for a working memory.
- `forget`: permanently delete a working memory.
- `invalidate`: softly supersede a working or episodic memory, optionally pointing at `replacement_id`.

Prefer `invalidate` when a memory became stale but its history may still be useful. Use `forget` only for content that should be hard-deleted.

**Always read the full memory before `update`.** Recall results are clipped previews (the trailing `…` marks a truncation and `full_length` reports the original size); `update` replaces content wholesale, so overwriting the preview would delete the unseen tail. Fetch the row first with `read memory://<id>`, then pass the merged content in `content`.
