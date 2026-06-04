Edit Mnemopi long-term memories by id.

Use only with ids returned by `recall` tool. Operations:
- `update`: replace content and/or importance for working memory.
- `forget`: permanently delete working memory.
- `invalidate`: softly supersede working or episodic memory, optionally pointing at `replacement_id`.

Prefer `invalidate` when memory became stale but history maybe useful. Use `forget` only for content MUST hard-delete.
