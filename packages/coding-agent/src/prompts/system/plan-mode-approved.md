<critical>
Plan approved — please execute it now.
</critical>

Finalized plan artifact: `{{finalPlanFilePath}}`
{{#if contextPreserved}}
Context preserved. Use conversation history when useful; if it conflicts with the finalized plan, the plan is the source of truth.
{{else}}
Execution may be in fresh context. Treat the finalized plan as the source of truth.
{{/if}}

## Plan

{{planContent}}

<instruction>
Work through this plan step by step from `{{finalPlanFilePath}}`. You have full tool access.
Verify each step before moving to the next.
{{#has tools "todo_write"}}
Before execution, initialize todo tracking with `todo_write`.
After each completed step, update `todo_write` right away.
If `todo_write` fails, fix the payload and retry before continuing.
{{/has}}
</instruction>

<critical>
Keep going until the plan is complete.
</critical>
