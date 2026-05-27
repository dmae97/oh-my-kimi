Creates or overwrites a file at the specified path.

<conditions>
- Creating new files when the task calls for them
- Replacing entire file contents when editing would be more involved
- Supports `.tar`, `.tar.gz`, `.tgz`, and `.zip` archive entries via `archive.ext:path/inside/archive`
- Supports SQLite row operations via `db.sqlite:table` (insert), `db.sqlite:table:key` (update with JSON content, delete with empty content)
</conditions>

<critical>
- Reach for the Edit tool when modifying existing files — it's more precise and preserves formatting.
- Skip creating documentation files (*.md, README) unless the task explicitly asks for them.
- Skip emojis unless they were requested.
</critical>
