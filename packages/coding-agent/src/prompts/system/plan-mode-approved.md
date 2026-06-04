Plan approved.
{{#if contextPreserved}}
- Context preserved. Use conversation history when useful; this plan is the source of truth if it conflicts with earlier exploration.
{{/if}}

<instruction>
You MUST execute this plan step by step. You have full tool access.
You MUST verify each step before proceeding to the next.
{{#has tools "todo_write"}}
Before execution, initialize todo tracking with `todo_write`.
After each completed step, immediately update `todo_write`.
If `todo_write` fails, fix the payload and retry before continuing.
{{/has}}
The plan path is for subagent handoff only. You already have the plan; NEVER read it.
</instruction>

The full plan is injected below. You MUST execute it now:

<plan path="{{finalPlanFilePath}}">
{{planContent}}
</plan>

<critical>
You MUST keep going until complete. This matters.
</critical>
