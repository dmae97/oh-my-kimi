<critical>
Plan approved. You **MUST** execute it now.
</critical>

Finalized plan artifact: `{{finalPlanFilePath}}`
{{#if contextPreserved}}
Context preserved. Use conversation history when useful; the finalized plan is the source of truth if it conflicts with earlier exploration.
{{else}}
Execution may be in fresh context. Treat the finalized plan as the source of truth.
{{/if}}

## Plan

{{planContent}}

<instruction>
You **MUST** execute this plan step by step from `{{finalPlanFilePath}}`. You have full tool access.
You **MUST** verify each step before proceeding to the next.
{{#has tools "todo_write"}}
Before execution, initialize todo tracking with `todo_write`.
After each completed step, immediately update `todo_write`.
If `todo_write` fails, fix the payload and retry before continuing.
{{/has}}
</instruction>

<critical>
You **MUST** keep going until complete. This matters.
</critical>
