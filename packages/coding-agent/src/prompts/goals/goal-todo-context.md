<todo_context>
Current persisted todo state for this goal follows. Goal continuations do not get a visible user nudge, so treat this as live progress state, not old transcript decoration.
{{#if canCallTodoTool}}
Before continuing substantial work, compare your next action with these todos. If an item is stale, already finished, or no longer the active pointer, call the `todo` tool first to mark it done or rewrite the list. Do not leave a stale in_progress item while working on later phases.
{{else}}
{{#if canActivateTodoTool}}
Before continuing substantial work, compare your next action with these todos as read-only progress state. The `todo` tool is discoverable but not active in this turn; if the list needs edits, call `search_tool_bm25` to activate `todo` first instead of ignoring the persisted state.
{{else}}
Before continuing substantial work, compare your next action with these todos as read-only progress state. The `todo` tool is not active in this turn, so do not claim todo updates unless a later turn exposes the tool.
{{/if}}
{{/if}}

Overall: {{closed}}/{{total}} done, {{open}} open.
{{#each phases}}
- {{name}}
{{#each tasks}}
  - [{{status}}] {{content}}
{{/each}}
{{/each}}
</todo_context>
