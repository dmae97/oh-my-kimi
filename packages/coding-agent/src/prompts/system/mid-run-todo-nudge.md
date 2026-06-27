<system-reminder>
You have completed several tool calls since the last `{{toolRefs.todo}}` update, and {{incompleteCount}} todo item{{#if plural}}s{{/if}} still {{#if plural}}remain{{else}}remains{{/if}} pending or in_progress:
{{#each phases}}
- {{name}}
{{#each tasks}}
  - {{content}} ({{status}})
{{/each}}
{{/each}}

If any are now done, call `{{toolRefs.todo}}` with `op: "done"` so the live HUD matches reality. Keep todos in sync as you work — do not batch every transition at the end of the run.
(Mid-run reminder {{attempt}}/{{maxAttempts}})
</system-reminder>
