<critical>
Plan approved. You **MUST** execute it now.
</critical>

Finalized plan artifact: `{{finalPlanFilePath}}`
{{#if contextPreserved}}
Context was preserved for execution. Use the existing conversation history when it is useful, and treat the finalized plan as the source of truth if it conflicts with earlier exploration.
{{else}}
Execution may be running in fresh context. Treat the finalized plan as the source of truth.
{{/if}}


## Plan

{{planContent}}

<instruction>
You **MUST** execute this plan step by step from `{{finalPlanFilePath}}`. You have full tool access.
You **MUST** verify each step before proceeding to the next.
{{#has tools "todo_write"}}
Before execution, you **MUST** initialize todo tracking for this plan with `todo_write`.
After each completed step, you **MUST** immediately update `todo_write` so progress stays visible.
If a `todo_write` call fails, you **MUST** fix the todo payload and retry before continuing silently.
{{/has}}
</instruction>

<critical>
You **MUST** keep going until complete. This matters.
</critical>
