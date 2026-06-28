<todo_context>
Current persisted todo state for this goal follows. Goal continuations do not get a visible user nudge, so treat this as live progress state, not old transcript decoration.
Before continuing substantial work, compare your next action with these todos. If an item is stale, already finished, or no longer the active pointer, call the `todo` tool first to mark it done or rewrite the list. Do not leave a stale in_progress item while working on later phases.

Overall: {{closed}}/{{total}} done, {{open}} open.
{{#each phases}}
- {{escapeXml name}}
{{#each tasks}}
  - [{{status}}] {{escapeXml content}}
{{/each}}
{{/each}}
</todo_context>
